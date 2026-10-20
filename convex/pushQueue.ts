import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { requireApprovedWriteTarget } from "./lib/deployment";

// Pushes are coalesced per pot. The sync client uploads one event per call, so a bulk
// upload (for example sharing an imported sheet) used to schedule one APNs delivery per
// event. Instead, eligible events wait in one pending row per pot and are delivered
// together once the pot has been quiet for a moment, or after a hard ceiling while a
// long upload keeps adding events.
export const pushQuietMillis = 30_000;
export const pushMaxWaitMillis = 10 * 60_000;
// Bounds the row (Convex arrays hold at most 8,192 values). Events past the cap are not
// lost, they just do not add recipients to an already very large summary.
export const pushMaxQueuedEvents = 5_000;

export async function queueEventPushes(
  ctx: MutationCtx,
  potId: string,
  eventIds: readonly string[],
): Promise<void> {
  if (eventIds.length === 0) return;
  const now = Date.now();
  const pending = await ctx.db
    .query("pendingPushes")
    .withIndex("by_pot", (index) => index.eq("potId", potId))
    .first();
  if (pending) {
    const room = Math.max(0, pushMaxQueuedEvents - pending.eventIds.length);
    await ctx.db.patch(pending._id, {
      eventIds: [...pending.eventIds, ...eventIds.slice(0, room)],
      lastQueuedAt: now,
    });
    return;
  }
  const pendingId = await ctx.db.insert("pendingPushes", {
    potId,
    eventIds: eventIds.slice(0, pushMaxQueuedEvents),
    firstQueuedAt: now,
    lastQueuedAt: now,
  });
  await ctx.scheduler.runAfter(pushQuietMillis, internal.pushQueue.flushPendingPush, {
    pendingId,
  });
}

// Scheduled after the quiet window. If events are still arriving, wait for the rest
// of the quiet window (never past the ceiling); otherwise hand the batch to the APNs
// action and clear the row so the next event starts a fresh batch.
export const flushPendingPush = internalMutation({
  args: { pendingId: v.id("pendingPushes") },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const pending = await ctx.db.get(args.pendingId);
    if (!pending) return { status: "gone" as const };
    const now = Date.now();
    const quietRemaining = pending.lastQueuedAt + pushQuietMillis - now;
    const ceilingRemaining = pending.firstQueuedAt + pushMaxWaitMillis - now;
    if (quietRemaining > 0 && ceilingRemaining > 0) {
      await ctx.scheduler.runAfter(
        Math.min(quietRemaining, ceilingRemaining),
        internal.pushQueue.flushPendingPush,
        args,
      );
      return { status: "deferred" as const };
    }
    await ctx.db.delete(pending._id);
    await ctx.scheduler.runAfter(0, internal.apns.deliverBatchPush, {
      potId: pending.potId,
      eventIds: pending.eventIds,
    });
    return { status: "flushed" as const, eventCount: pending.eventIds.length };
  },
});

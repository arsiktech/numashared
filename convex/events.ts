import { v } from "convex/values";

import { mutation, query, type QueryCtx } from "./_generated/server";
import {
  requireActiveMembership,
  requireReadableMembership,
  requireSession,
  fail,
} from "./lib/access";
import { appendEventsToPot } from "./lib/appendEvents";
import { requireApprovedWriteTarget } from "./lib/deployment";
import { isNotificationEligible } from "./lib/notificationMatrix";
import { eventInputValidator } from "./model";
import { queueEventPushes } from "./pushQueue";

export const appendEvents = mutation({
  args: {
    potId: v.string(),
    events: v.array(eventInputValidator),
  },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    const membership = await requireActiveMembership(ctx, args.potId, account._id);
    const pot = await ctx.db
      .query("pots")
      .withIndex("by_pot_id", (index) => index.eq("potId", args.potId))
      .unique();
    if (!pot) fail("POT_MISSING");
    const appended = await appendEventsToPot(ctx, {
      pot,
      accountId: account._id,
      actorMemberId: membership.memberId,
      events: args.events,
    });
    const insertedEventIds = new Set(appended.insertedEventIds);
    await queueEventPushes(
      ctx,
      args.potId,
      args.events
        .filter((event) =>
          insertedEventIds.has(event.eventId) && isNotificationEligible(event.payload),
        )
        .map((event) => event.eventId),
    );
    return { events: appended.events };
  },
});

export const listEvents = query({
  args: {
    potId: v.string(),
    afterSequence: v.int64(),
  },
  handler: async (ctx, args) => {
    const { account } = await requireSession(ctx);
    const membership = await requireReadableMembership(ctx, args.potId, account._id);

    const fetched = membership.status === "archived"
      ? await ctx.db
        .query("events")
        .withIndex("by_pot_sequence", (index) =>
          index
            .eq("potId", args.potId)
            .gt("sequence", args.afterSequence)
            .lte("sequence", membership.archivedAtSequence!),
        )
        .order("asc")
        .take(501)
      : await ctx.db
        .query("events")
        .withIndex("by_pot_sequence", (index) =>
          index.eq("potId", args.potId).gt("sequence", args.afterSequence),
        )
        .order("asc")
        .take(501);
    const page = fetched.slice(0, 500);
    const firstSequence = page.at(0)?.sequence;
    const lastSequence = page.at(-1)?.sequence;
    const sidecars = firstSequence === undefined || lastSequence === undefined
      ? []
      : await ctx.db
        .query("eventTexts")
        .withIndex("by_pot_sequence", (index) =>
          index
            .eq("potId", args.potId)
            .gte("sequence", firstSequence)
            .lte("sequence", lastSequence),
        )
        .collect();
    const sidecarsByEvent = new Map<
      string,
      Map<(typeof sidecars)[number]["field"], string>
    >();
    for (const sidecar of sidecars) {
      let eventValues = sidecarsByEvent.get(sidecar.eventId);
      if (!eventValues) {
        eventValues = new Map();
        sidecarsByEvent.set(sidecar.eventId, eventValues);
      }
      eventValues.set(sidecar.field, sidecar.value);
    }
    const hydrated = [];
    for (const stored of page) {
      const values = sidecarsByEvent.get(stored.eventId) ?? new Map();
      const textStates = stored.textFields.map((field) => {
        const value = values.get(field);
        return value === undefined
          ? { field, state: "redacted" as const }
          : { field, state: "present" as const, value };
      });
      hydrated.push({
        event: {
          eventId: stored.eventId,
          potId: stored.potId,
          actorMemberId: stored.actorMemberId,
          occurredAtMillis: stored.occurredAtMillis,
          originatingTimeZone: stored.originatingTimeZone,
          schemaVersion: stored.schemaVersion,
          payload: stored.payload,
          textFields: stored.textFields,
          authoredText: [],
          ...(stored.legacyAuthoredText ? { legacyAuthoredText: true } : {}),
        },
        serverSequence: stored.sequence,
        // When the server sequenced the event. occurredAtMillis is the author's chosen time
        // (an expense can be backdated); this says when it was actually recorded.
        recordedAtMillis: stored.createdAt,
        textStates,
      });
    }
    return {
      events: hydrated,
      hasMore: fetched.length > page.length,
      nextAfterSequence: page.at(-1)?.sequence ?? args.afterSequence,
    };
  },
});

export const listTextChanges = query({
  args: {
    potId: v.string(),
    afterRevision: v.int64(),
  },
  handler: async (ctx, args) => {
    const page = await textChangePage(ctx, args);
    return {
      changes: page.changes,
      hasMore: page.hasMore,
      nextAfterRevision: page.nextAfterRevision,
    };
  },
});

// Opt-in endpoint: installed clients keep their original response contract.
// Deploy this endpoint before distributing clients that consume skipped revisions.
export const listTextChangesWithSkippedRevisions = query({
  args: { potId: v.string(), afterRevision: v.int64() },
  handler: textChangePage,
});

async function textChangePage(
  ctx: QueryCtx,
  args: { potId: string; afterRevision: bigint },
) {
    const { account } = await requireSession(ctx);
    const membership = await requireReadableMembership(ctx, args.potId, account._id);

    const fetchedUnbounded = await ctx.db
      .query("textRedactions")
      .withIndex("by_pot_revision", (index) =>
        index.eq("potId", args.potId).gt("revision", args.afterRevision),
      )
      .order("asc")
      .take(501);
    // Bound the scanned page before filtering: the lookahead must never appear
    // in changes while the returned cursor still points to the preceding row.
    const page = fetchedUnbounded.slice(0, 500);
    const readable = (change: (typeof page)[number]) => membership.status !== "archived"
      || change.sequence <= membership.archivedAtSequence!;
    return {
      changes: page.filter(readable).map((change) => ({
        eventId: change.eventId,
        field: change.field,
        revision: change.revision,
        state: "redacted" as const,
      })),
      // Deliberately omit event IDs and fields from inaccessible history.
      skippedRevisions: page.filter((change) => !readable(change)).map((change) => change.revision),
      hasMore: fetchedUnbounded.length > 500,
      nextAfterRevision: page.at(-1)?.revision ?? args.afterRevision,
    };
}

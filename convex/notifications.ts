import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server";
import { fail, requireActiveMembership, requireSession } from "./lib/access";
import { requireApprovedWriteTarget } from "./lib/deployment";
import { validateTimeZone } from "./lib/eventValidation";
import {
  contestedHeadAuthorMemberIds,
  financialTransitionAffectedUnitIds,
} from "./lib/financialRecordState";
import {
  contestedBody,
  notificationBody,
  unitNotificationRecipients,
} from "./lib/notificationMatrix";

type PushTargetToken = {
  deviceToken: string;
  environment: "sandbox" | "production";
};

// APNs device tokens are lowercase hex. 32 bytes today (64 chars); the upper bound is
// generous so a longer future token is stored rather than rejected outright.
const deviceTokenPattern = /^[0-9a-f]{64,200}$/;

const environmentValidator = v.union(
  v.literal("sandbox"),
  v.literal("production"),
);

// Register (or re-point) this device's APNs token. A device token identifies one
// physical device, so if it reappears under a different account — the same phone signed
// into another Apple ID — it moves rather than being duplicated, which keeps a signed
// out account from continuing to receive that device's pushes.
export const registerPushToken = mutation({
  args: {
    deviceToken: v.string(),
    environment: environmentValidator,
    timeZone: v.string(),
  },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    const deviceToken = args.deviceToken.toLowerCase();
    if (!deviceTokenPattern.test(deviceToken) || deviceToken.length % 2 !== 0) {
      fail("INVALID_DEVICE_TOKEN");
    }
    validateTimeZone(args.timeZone);
    const existing = await ctx.db
      .query("pushTokens")
      .withIndex("by_token", (index) => index.eq("deviceToken", deviceToken))
      .unique();
    const updatedAt = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        accountId: account._id,
        environment: args.environment,
        timeZone: args.timeZone,
        updatedAt,
      });
      return { registered: true as const };
    }
    await ctx.db.insert("pushTokens", {
      accountId: account._id,
      deviceToken,
      environment: args.environment,
      timeZone: args.timeZone,
      updatedAt,
    });
    return { registered: true as const };
  },
});

export const getPotMute = query({
  args: { potId: v.string() },
  handler: async (ctx, args) => {
    const { account } = await requireSession(ctx);
    await requireActiveMembership(ctx, args.potId, account._id);
    const existing = await ctx.db
      .query("potMutes")
      .withIndex("by_pot_account", (index) =>
        index.eq("potId", args.potId).eq("accountId", account._id),
      )
      .unique();
    return { muted: existing !== null };
  },
});

// Drop this device's token (sign out). Only the owning account may drop it; an unknown
// token is a no-op so a retried sign-out cannot fail.
export const unregisterPushToken = mutation({
  args: { deviceToken: v.string() },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    const deviceToken = args.deviceToken.toLowerCase();
    const existing = await ctx.db
      .query("pushTokens")
      .withIndex("by_token", (index) => index.eq("deviceToken", deviceToken))
      .unique();
    if (!existing) return { removed: false as const };
    if (existing.accountId !== account._id) fail("NOT_TOKEN_OWNER");
    await ctx.db.delete(existing._id);
    return { removed: true as const };
  },
});

// Per-pot mute for the calling member. Checked server-side before fan-out, so a muted
// member costs no delivery at all. Only a member of the pot can mute it.
export const setPotMute = mutation({
  args: { potId: v.string(), muted: v.boolean() },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    await requireActiveMembership(ctx, args.potId, account._id);
    const existing = await ctx.db
      .query("potMutes")
      .withIndex("by_pot_account", (index) =>
        index.eq("potId", args.potId).eq("accountId", account._id),
      )
      .unique();
    if (args.muted) {
      if (!existing) {
        await ctx.db.insert("potMutes", {
          potId: args.potId,
          accountId: account._id,
          mutedAt: Date.now(),
        });
      }
      return { muted: true as const };
    }
    if (existing) await ctx.db.delete(existing._id);
    return { muted: false as const };
  },
});

type PotPushContext = {
  potId: string;
  potName: string;
  activeByMember: Map<string, Doc<"potMembers">>;
  mutedMemberIds: Set<string>;
};

// One event's resolved push: who receives it (as accounts) and the §6 body. `kind`
// separates the "needs your choice" request from ordinary balance notifications, so a
// batched delivery can keep the request distinct instead of folding it into a summary.
export type EventPushPlan = {
  eventId: string;
  kind: "unit" | "contested";
  body: string;
  accountIds: Id<"accounts">[];
};

async function loadPotPushContext(
  ctx: QueryCtx,
  potId: string,
): Promise<PotPushContext | null> {
  const pot = await ctx.db
    .query("pots")
    .withIndex("by_pot_id", (index) => index.eq("potId", potId))
    .unique();
  if (!pot?.name) return null;
  const members = await ctx.db
    .query("potMembers")
    .withIndex("by_pot_account", (index) => index.eq("potId", potId))
    .collect();
  const activeByMember = new Map(
    members.filter((member) => member.status === "active").map((m) => [m.memberId, m]),
  );
  const mutes = await ctx.db
    .query("potMutes")
    .withIndex("by_pot_account", (index) => index.eq("potId", potId))
    .collect();
  const mutedAccountIds = new Set(mutes.map((mute) => mute.accountId));
  const mutedMemberIds = new Set(
    [...activeByMember.values()]
      .filter((member) => mutedAccountIds.has(member.accountId))
      .map((member) => member.memberId),
  );
  return { potId, potName: pot.name, activeByMember, mutedMemberIds };
}

async function planEventPush(
  ctx: QueryCtx,
  pot: PotPushContext,
  eventId: string,
): Promise<EventPushPlan | null> {
  const event = await ctx.db
    .query("events")
    .withIndex("by_pot_event", (index) =>
      index.eq("potId", pot.potId).eq("eventId", eventId),
    )
    .unique();
  if (!event) return null;
  // Read only what this push needs: the triggering record's own history and the
  // membership events (memberAdded, groupChanged), all bounded by this event's
  // sequence. Loading the whole pot here made every push O(pot size), so a bulk
  // upload of N events cost O(N^2) database reads.
  const recordEvents = event.recordId
    ? await ctx.db
        .query("events")
        .withIndex("by_pot_record", (index) =>
          index
            .eq("potId", pot.potId)
            .eq("recordId", event.recordId)
            .lte("sequence", event.sequence),
        )
        .collect()
    : [];

  const accountIdsFor = (memberIds: readonly string[]) => memberIds.flatMap((memberId) => {
    const member = pot.activeByMember.get(memberId);
    return member ? [member.accountId] : [];
  });

  const contestedAuthors = contestedHeadAuthorMemberIds(recordEvents, event.eventId);
  if (contestedAuthors) {
    const recipients = contestedAuthors.filter((memberId) =>
      memberId !== event.actorMemberId && !pot.mutedMemberIds.has(memberId),
    );
    return {
      eventId,
      kind: "contested",
      body: contestedBody(pot.potName),
      accountIds: accountIdsFor(recipients),
    };
  }

  const body = notificationBody(event.payload, pot.potName);
  if (!body) return null;

  // Compare this record's contribution immediately before and after the stored event.
  // This includes units removed by an edit and follows the same provisional-head rule
  // as Core without calculating or storing any pot balance.
  const units = financialTransitionAffectedUnitIds(recordEvents, event.eventId);
  if (!units || units.length === 0) return { eventId, kind: "unit", body, accountIds: [] };

  const membershipEventsOfKind = (kind: "memberAdded" | "groupChanged") =>
    ctx.db
      .query("events")
      .withIndex("by_pot_kind", (index) =>
        index
          .eq("potId", pot.potId)
          .eq("payload.kind", kind)
          .lte("sequence", event.sequence),
      )
      .collect();
  const membershipEvents = [
    ...(await membershipEventsOfKind("memberAdded")),
    ...(await membershipEventsOfKind("groupChanged")),
  ].sort((left, right) => (left.sequence < right.sequence ? -1 : 1));

  // Personal units come from memberAdded. Each groupChanged payload is the complete
  // current group topology, so rebuild group-unit membership through this event's
  // sequence and never let later structural changes alter an earlier push.
  const unitMembers = new Map<string, Set<string>>();
  const groupUnitIds = new Set<string>();
  for (const potEvent of membershipEvents) {
    if (potEvent.payload.kind === "memberAdded") {
      unitMembers.set(potEvent.payload.unitId, new Set([potEvent.payload.memberId]));
    } else if (potEvent.payload.kind === "groupChanged") {
      for (const unitId of groupUnitIds) unitMembers.delete(unitId);
      groupUnitIds.clear();
      for (const group of potEvent.payload.groups) {
        groupUnitIds.add(group.unitId);
        unitMembers.set(group.unitId, new Set(group.orderedMemberIds));
      }
    }
  }

  const recipients = unitNotificationRecipients({
    affectedUnitIds: units,
    unitMembers,
    actorMemberId: event.actorMemberId,
    mutedMemberIds: pot.mutedMemberIds,
  });
  return { eventId, kind: "unit", body, accountIds: accountIdsFor(recipients) };
}

async function tokensForAccountIds(
  ctx: QueryCtx,
  accountIds: readonly Id<"accounts">[],
): Promise<Array<PushTargetToken & { accountId: Id<"accounts"> }>> {
  const tokens: Array<PushTargetToken & { accountId: Id<"accounts"> }> = [];
  for (const accountId of accountIds) {
    const accountTokens = await ctx.db
      .query("pushTokens")
      .withIndex("by_account", (index) => index.eq("accountId", accountId))
      .collect();
    for (const token of accountTokens) {
      tokens.push({ accountId, deviceToken: token.deviceToken, environment: token.environment });
    }
  }
  return tokens;
}

// Resolve who must receive a push for one event, and on which devices. Internal: the
// fan-out action calls it, never a client. Returns no body (and no tokens) whenever §6
// says this event is silent, so the caller cannot accidentally invent a notification.
export const pushTargets = internalQuery({
  args: { potId: v.string(), eventId: v.string() },
  handler: async (ctx, args) => {
    const empty = { body: null, tokens: [] as PushTargetToken[] };
    const pot = await loadPotPushContext(ctx, args.potId);
    if (!pot) return empty;
    const plan = await planEventPush(ctx, pot, args.eventId);
    if (!plan) return empty;
    const tokens = await tokensForAccountIds(ctx, plan.accountIds);
    return {
      body: plan.body,
      tokens: tokens.map(({ deviceToken, environment }) => ({ deviceToken, environment })),
    };
  },
});

// Resolve a batch of queued events for one pot (see pushQueue.ts). The caller pages
// through large batches, so each call reads one bounded slice of event ids.
export const batchPushPlan = internalQuery({
  args: { potId: v.string(), eventIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const pot = await loadPotPushContext(ctx, args.potId);
    if (!pot) return { potName: null, plans: [] as EventPushPlan[] };
    const plans: EventPushPlan[] = [];
    for (const eventId of args.eventIds) {
      const plan = await planEventPush(ctx, pot, eventId);
      if (plan && plan.accountIds.length > 0) plans.push(plan);
    }
    return { potName: pot.potName, plans };
  },
});

// Devices for the accounts a batched delivery decided to notify.
export const pushTokensForAccounts = internalQuery({
  args: { accountIds: v.array(v.id("accounts")) },
  handler: async (ctx, args) => await tokensForAccountIds(ctx, args.accountIds),
});

// APNs 410 Unregistered means the device will never accept this token again: drop it so
// the next fan-out does not retry a dead device.
export const dropPushToken = internalMutation({
  args: { deviceToken: v.string(), invalidatedAtMillis: v.number() },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const existing = await ctx.db
      .query("pushTokens")
      .withIndex("by_token", (index) => index.eq("deviceToken", args.deviceToken))
      .unique();
    if (!existing) return { removed: false as const };
    // The 410 may race with a later app launch that re-registers the same token. Apple's
    // timestamp describes when APNs observed invalidation; never let that older response
    // delete a registration written after it.
    if (
      !Number.isFinite(args.invalidatedAtMillis)
      || args.invalidatedAtMillis <= 0
      || existing.updatedAt > args.invalidatedAtMillis
    ) {
      return { removed: false as const };
    }
    await ctx.db.delete(existing._id);
    return { removed: true as const };
  },
});

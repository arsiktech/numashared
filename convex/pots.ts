import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { appendPromotedPrerequisite, changeBudgetGroupsForMember } from "./members";
import { loadBudgetGroupTopology } from "./lib/budgetGroupTopology";
import { appendEventsToPot } from "./lib/appendEvents";
import {
  requireActiveMembership,
  requireSession,
  fail,
} from "./lib/access";
import {
  canonicalValue,
  validateConfiguration,
  validateDisplayName,
} from "./lib/eventValidation";
import { requireApprovedWriteTarget } from "./lib/deployment";
import {
  consumeAccountWriteQuota,
  maximumActivePotsPerAccount,
  potCreateLimitPerDay,
} from "./lib/accountWriteQuota";
import {
  eventInputValidator,
  potConfigurationInputValidator,
} from "./model";

export const promoteLocalPot = mutation({
  args: {
    configuration: potConfigurationInputValidator,
    ownerDisplayName: v.string(),
    events: v.array(eventInputValidator),
    budgetGroupPromotion: v.optional(v.object({
      ownerBindingEventId: v.string(),
      startingSequence: v.int64(),
      members: v.array(v.object({ memberId: v.string(), displayName: v.optional(v.string()) })),
    })),
    legacyMigrationEventIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    validateConfiguration(args.configuration);
    validateDisplayName(args.ownerDisplayName);
    const legacyMigrationEventIds = args.legacyMigrationEventIds ?? [];
    if (legacyMigrationEventIds.length > 100) fail("LEGACY_MIGRATION_TOO_LARGE");
    const authorizedLegacyEventIds = new Set(legacyMigrationEventIds);
    if (authorizedLegacyEventIds.size !== legacyMigrationEventIds.length) {
      fail("DUPLICATE_LEGACY_MIGRATION_EVENT");
    }
    const incomingEventIds = new Set(args.events.map((event) => event.eventId));
    for (const eventId of authorizedLegacyEventIds) {
      if (!incomingEventIds.has(eventId)) fail("INVALID_LEGACY_MIGRATION_EVENT");
    }
    const typed = args.budgetGroupPromotion;
    if (typed && (typed.startingSequence < 1n || typed.members.length > 64
      || args.events.length === 0 || args.events.length > 100
      || authorizedLegacyEventIds.size !== 0)) fail("PROMOTION_CONFLICT");
    let pot = await ctx.db
      .query("pots")
      .withIndex("by_pot_id", (index) => index.eq("potId", args.configuration.potId))
      .unique();
    let membership: Doc<"potMembers">;

    if (!pot) {
      if (typed && (typed.startingSequence !== 1n
        || !args.events.some((e) => e.eventId === typed.ownerBindingEventId
          && e.payload.kind === "memberAdded" && e.payload.memberId === args.configuration.ownerMemberId
          && e.payload.role === "owner")
        || !args.events.some((e) => e.payload.kind === "groupChanged" && e.schemaVersion === 2n))) {
        fail("PROMOTION_PREREQUISITES_REQUIRED");
      }
      const createdAt = Date.now();
      const activeMemberships = await ctx.db
        .query("potMembers")
        .withIndex("by_account_status", (index) =>
          index.eq("accountId", account._id).eq("status", "active"),
        )
        .take(maximumActivePotsPerAccount);
      if (activeMemberships.length >= maximumActivePotsPerAccount) {
        fail("ACCOUNT_POT_LIMIT_REACHED");
      }
      await consumeAccountWriteQuota(ctx, {
        accountId: account._id,
        scope: "potCreate",
        amount: 1n,
        limit: potCreateLimitPerDay,
        windowMillis: 86_400_000,
        now: createdAt,
      });
      const potId = await ctx.db.insert("pots", {
        potId: args.configuration.potId,
        currencyCode: args.configuration.currency.code,
        currencyExponent: args.configuration.currency.exponent,
        orderedUnitIds: args.configuration.orderedUnitIds,
        initialOrderedUnitIds: args.configuration.orderedUnitIds,
        ownerAccountId: account._id,
        minimumReaderSchemaVersion: args.configuration.minimumReaderSchemaVersion,
        nextSequence: 1n,
        nextTextRevision: 1n,
        positiveContributionBudget: 0n,
        negativeContributionBudget: 0n,
        ...(authorizedLegacyEventIds.size > 0
          ? { legacyMigrationCompletedAt: createdAt }
          : {}),
        createdAt,
      });
      await ctx.db.insert("potMembers", {
        potId: args.configuration.potId,
        accountId: account._id,
        memberId: args.configuration.ownerMemberId,
        role: "owner",
        status: "active",
        joinedAt: createdAt,
      });
      await ctx.db.insert("potMemberProfiles", {
        potId: args.configuration.potId,
        memberId: args.configuration.ownerMemberId,
        displayName: args.ownerDisplayName,
        role: "owner",
        state: "active",
        createdAt,
        updatedAt: createdAt,
      });
      pot = await ctx.db.get(potId);
      if (!pot) fail("POT_CREATE_FAILED");
      membership = await requireActiveMembership(
        ctx,
        args.configuration.potId,
        account._id,
      );
    } else {
      const existingPot = pot;
      membership = await requireActiveMembership(
        ctx,
        existingPot.potId,
        account._id,
      );
      const ownerProfile = await ctx.db
        .query("potMemberProfiles")
        .withIndex("by_pot_member", (index) =>
          index.eq("potId", existingPot.potId).eq("memberId", membership.memberId),
        )
        .unique();
      const storedConfiguration = {
        potId: existingPot.potId,
        currency: {
          code: existingPot.currencyCode,
          exponent: existingPot.currencyExponent,
        },
        orderedUnitIds: existingPot.orderedUnitIds,
        ownerMemberId: membership.memberId,
        minimumReaderSchemaVersion: existingPot.minimumReaderSchemaVersion,
      };
      if (typed) {
        if (existingPot.initialOrderedUnitIds === undefined) fail("BOOTSTRAP_BASELINE_UNAVAILABLE");
        const anchor = await ctx.db.query("events")
          .withIndex("by_event_id", (q) => q.eq("eventId", typed.ownerBindingEventId)).unique();
        if (!anchor || anchor.potId !== pot.potId || anchor.payload.kind !== "memberAdded"
          || anchor.payload.role !== "owner" || anchor.payload.memberId !== membership.memberId
          || membership.memberId !== args.configuration.ownerMemberId
          || existingPot.currencyCode !== args.configuration.currency.code
          || existingPot.currencyExponent !== args.configuration.currency.exponent
          || canonicalValue(existingPot.initialOrderedUnitIds)
            !== canonicalValue(args.configuration.orderedUnitIds)) fail("PROMOTION_CONFLICT");
      } else if (
        existingPot.ownerAccountId !== account._id
        || membership.role !== "owner"
        || !ownerProfile
        || ownerProfile.displayName !== args.ownerDisplayName
        || ownerProfile.role !== "owner"
        || ownerProfile.state !== "active"
        || canonicalValue(storedConfiguration) !== canonicalValue(args.configuration)
      ) {
        fail("PROMOTION_CONFLICT");
      }
      // A promotion whose response was lost is retried with the identical events.
      // Convex mutations are atomic, so an existing pot created by a legacy promotion
      // already holds every one of these legacy events at their assigned sequences.
      // Re-authorize that exact set so appendEventsToPot converges idempotently instead
      // of wedging the pot; introducing new legacy text on an existing pot stays barred.
      if (authorizedLegacyEventIds.size > 0) {
        if (pot.legacyMigrationCompletedAt === undefined) {
          fail("LEGACY_MIGRATION_NOT_AVAILABLE");
        }
        for (const eventId of authorizedLegacyEventIds) {
          const existing = await ctx.db
            .query("events")
            .withIndex("by_event_id", (index) => index.eq("eventId", eventId))
            .unique();
          if (
            existing === null
            || existing.potId !== pot.potId
            || existing.legacyAuthoredText !== true
          ) {
            fail("LEGACY_MIGRATION_NOT_AVAILABLE");
          }
        }
      }
    }

    if (typed) {
      const events: { eventId: string; sequence: bigint }[] = [];
      for (const [index, event] of args.events.entries()) {
        const current = await ctx.db.get(pot._id);
        if (!current) fail("POT_MISSING");
        const existing = await ctx.db.query("events")
          .withIndex("by_event_id", (q) => q.eq("eventId", event.eventId)).unique();
        const expected = typed.startingSequence + BigInt(index);
        if ((existing?.sequence ?? current.nextSequence) !== expected) fail("PROMOTION_SEQUENCE_CONFLICT");
        if (!existing && membership.role !== "owner") fail("NOT_OWNER");
        let sequence: bigint;
        if (event.payload.kind === "memberAdded" || event.payload.kind === "potRenamed") {
          sequence = await appendPromotedPrerequisite(ctx, current, membership, event,
            typed.members.find((m) => m.memberId === (event.payload.kind === "memberAdded" ? event.payload.memberId : ""))?.displayName);
        } else if (event.payload.kind === "groupChanged") {
          const expectedTopologyRevision = existing?.groupExpectedRevision
            ?? (await loadBudgetGroupTopology(ctx, current)).revision;
          sequence = (await changeBudgetGroupsForMember(ctx, account._id, membership,
            { potId: pot.potId, event, expectedTopologyRevision })).sequence;
        } else {
          sequence = (await appendEventsToPot(ctx, { pot: current, accountId: account._id,
            actorMemberId: membership.memberId, events: [event] })).events[0].sequence;
        }
        events.push({ eventId: event.eventId, sequence });
      }
      return { potId: pot.potId, events };
    }

    const appended = await appendEventsToPot(ctx, {
      pot,
      accountId: account._id,
      actorMemberId: membership.memberId,
      events: args.events,
      authorizedLegacyEventIds,
    });
    return { potId: pot.potId, events: appended.events };
  },
});

export const listMyPots = query({
  args: {},
  handler: async (ctx) => {
    const { account } = await requireSession(ctx);
    const activeMemberships = await ctx.db
      .query("potMembers")
      .withIndex("by_account_status", (index) =>
        index.eq("accountId", account._id).eq("status", "active"),
      )
      .take(maximumActivePotsPerAccount + 1);
    if (activeMemberships.length > maximumActivePotsPerAccount) {
      fail("ACCOUNT_POT_LIMIT_INVARIANT_BROKEN");
    }
    const archivedMemberships = await ctx.db
      .query("potMembers")
      .withIndex("by_account_status", (index) =>
        index.eq("accountId", account._id).eq("status", "archived"),
      )
      .collect();
    const memberships = [...activeMemberships, ...archivedMemberships];
    const result = [];
    for (const membership of memberships) {
      const pot = await ctx.db
        .query("pots")
        .withIndex("by_pot_id", (index) => index.eq("potId", membership.potId))
        .unique();
      if (!pot) fail("POT_MISSING");
      result.push({
        potId: pot.potId,
        currency: {
          code: pot.currencyCode,
          exponent: pot.currencyExponent,
        },
        orderedUnitIds: pot.orderedUnitIds,
        initialOrderedUnitIds: pot.initialOrderedUnitIds ?? null,
        memberId: membership.memberId,
        role: membership.role,
        minimumReaderSchemaVersion: pot.minimumReaderSchemaVersion,
        lastSequence: membership.status === "archived"
          ? membership.archivedAtSequence
          : pot.nextSequence - 1n,
        lastTextRevision: pot.nextTextRevision - 1n,
        isArchived: pot.archivedAtSequence !== undefined,
      });
    }
    return result.sort((left, right) => left.potId.localeCompare(right.potId));
  },
});

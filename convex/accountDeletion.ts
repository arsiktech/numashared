import { v } from "convex/values";

import type { Doc, Id, TableNames } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { fail } from "./lib/access";
import { applyStructuralTopology, loadBudgetGroupTopology } from "./lib/budgetGroupTopology";
import { requireApprovedWriteTarget } from "./lib/deployment";
import {
  type EventInput,
  validateEvent,
  validateTimeZone,
  validateUUIDv7,
} from "./lib/eventValidation";

const deletionBatchSize = 100;
const receiptLifetimeMillis = 30 * 24 * 60 * 60 * 1_000;

type ReadContext = QueryCtx | MutationCtx;
type AnyDb = MutationCtx["db"];

// Per-pot cleanup order: sidecars first, then the append-only log, then membership.
// All indexes listed here are keyed by potId.
const potSweep: Array<[TableNames, string]> = [
  ["eventTexts", "by_pot_sequence"],
  ["textRedactions", "by_pot_revision"],
  ["events", "by_pot_sequence"],
  ["inviteClaims", "by_pot"],
  ["invites", "by_pot"],
  ["potMutes", "by_pot_account"],
  ["pendingPushes", "by_pot"],
  ["potMemberProfiles", "by_pot_member"],
  ["cardSyncSpends", "by_pot_spend"],
  ["cardSyncLinks", "by_pot"],
  ["potMembers", "by_pot_account"],
];

// Per-account identity cleanup sweep, in order; indexes keyed by accountId.
// Authored event texts are intentionally NOT swept here: the erasure path must
// complete first, and any remaining row is a hard invariant
// (ACCOUNT_DELETION_TEXT_REMAINS) enforced below.
const accountSweep: Array<TableNames> = [
  "sessions",
  "refreshTokenHistory",
  "accountWriteQuotas",
  "pushTokens",
  "appleIdentityNotifications",
];

// Typed generically at call sites with literal table/index names; erased here so the
// sweep tables stay data, not code.
async function takeIndexed(
  db: AnyDb,
  table: TableNames,
  index: string,
  field: string,
  value: string | Id<"accounts">,
): Promise<Array<{ _id: never }>> {
  const query = db.query(table) as unknown as {
    withIndex(
      name: string,
      bind: (q: { eq: (f: string, v: string) => unknown }) => unknown,
    ): { take(n: number): Promise<Array<{ _id: never }>> };
  };
  return (await query
    .withIndex(index, (q) => q.eq(field, value))
    .take(deletionBatchSize)) as unknown as Array<{ _id: never }>;
}

export async function sweepPot(ctx: MutationCtx, pot: Doc<"pots">): Promise<void> {
  const lastIndex = potSweep.length - 1;
  for (let i = 0; i < potSweep.length; i += 1) {
    const rows = await takeIndexed(ctx.db, potSweep[i][0], potSweep[i][1], "potId", pot.potId);
    if (rows.length > 0) {
      for (const row of rows) await ctx.db.delete(row._id);
      // The original flow deletes the pot in the same pass as its final
      // membership rows, so a fully emptied pot never survives a restart.
      if (i === lastIndex) await ctx.db.delete(pot._id);
      return;
    }
  }
  await ctx.db.delete(pot._id);
}

async function accountForRefreshHash(
  ctx: ReadContext,
  refreshTokenHash: string,
  now: number,
): Promise<{ account: Doc<"accounts">; session: Doc<"sessions"> } | null> {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_refresh_token_hash", (index) =>
      index.eq("refreshTokenHash", refreshTokenHash),
    )
    .unique();
  if (!session || session.revokedAt !== undefined || session.expiresAt <= now) {
    return null;
  }
  const account = await ctx.db.get(session.accountId);
  if (!account) return null;
  return { account, session };
}

async function activeMembers(
  ctx: ReadContext,
  potId: string,
): Promise<Doc<"potMembers">[]> {
  const members = await ctx.db
    .query("potMembers")
    .withIndex("by_pot_account", (index) => index.eq("potId", potId))
    .take(65);
  if (members.length > 64) fail("TOO_MANY_MEMBERS");
  return members.filter((member) => member.status === "active");
}

function successor(
  members: Doc<"potMembers">[],
  deletingAccountId: Id<"accounts">,
): Doc<"potMembers"> | undefined {
  return members
    .filter((member) => member.accountId !== deletingAccountId)
    .sort((left, right) =>
      left.joinedAt - right.joinedAt || left.memberId.localeCompare(right.memberId)
    )[0];
}

async function appendStructuralEvent(
  ctx: MutationCtx,
  pot: Doc<"pots">,
  sequence: bigint,
  event: EventInput,
): Promise<bigint> {
  validateEvent(event, {
    potId: pot.potId,
    currency: { code: pot.currencyCode, exponent: pot.currencyExponent },
    orderedUnitIds: pot.orderedUnitIds,
    ownerMemberId: event.actorMemberId,
    minimumReaderSchemaVersion: pot.minimumReaderSchemaVersion,
  }, { allowLegacyAuthoredText: false });
  if (event.schemaVersion < pot.minimumReaderSchemaVersion) fail("SCHEMA_DOWNGRADE");
  if (pot.minimumReaderSchemaVersion === 2n) {
    const currentPot = await ctx.db.get(pot._id);
    if (!currentPot) fail("POT_MISSING");
    const topology = applyStructuralTopology(await loadBudgetGroupTopology(ctx, currentPot), event, sequence, pot.orderedUnitIds);
    await ctx.db.patch(pot._id, { budgetGroupTopology: topology });
  }
  await ctx.db.insert("events", {
    potId: pot.potId,
    eventId: event.eventId,
    actorMemberId: event.actorMemberId,
    occurredAtMillis: event.occurredAtMillis,
    originatingTimeZone: event.originatingTimeZone,
    schemaVersion: event.schemaVersion,
    sequence,
    payload: event.payload,
    textFields: [],
    createdAt: Number(event.occurredAtMillis),
  });
  return sequence + 1n;
}

export const receipt = internalQuery({
  args: { requestId: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    validateUUIDv7(args.requestId, "ACCOUNT_DELETION_REQUEST_INVALID");
    const value = await ctx.db
      .query("accountDeletionReceipts")
      .withIndex("by_request_id", (index) => index.eq("requestId", args.requestId))
      .unique();
    return { complete: value !== null && value.expiresAt > args.now };
  },
});

export const preview = internalQuery({
  args: { refreshTokenHash: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    const authenticated = await accountForRefreshHash(
      ctx,
      args.refreshTokenHash,
      args.now,
    );
    if (!authenticated) return { authorized: false as const, pots: [] };
    const { account } = authenticated;
    const memberships = [
      ...await ctx.db.query("potMembers")
        .withIndex("by_account_status", (index) =>
          index.eq("accountId", account._id).eq("status", "active"),
        ).collect(),
      ...await ctx.db.query("potMembers")
        .withIndex("by_account_status", (index) =>
          index.eq("accountId", account._id).eq("status", "archived"),
        ).collect(),
    ];
    const pots = [] as Array<{
      potId: string;
      name: string | null;
      outcome: "deleted" | "anonymized";
      successorName: string | null;
    }>;
    for (const membership of memberships) {
      const pot = await ctx.db
        .query("pots")
        .withIndex("by_pot_id", (index) => index.eq("potId", membership.potId))
        .unique();
      if (!pot) continue;
      const nextOwner = successor(await activeMembers(ctx, pot.potId), account._id);
      let successorName: string | null = null;
      if (pot.ownerAccountId === account._id && nextOwner) {
        const profile = await ctx.db
          .query("potMemberProfiles")
          .withIndex("by_pot_member", (index) =>
            index.eq("potId", pot.potId).eq("memberId", nextOwner.memberId),
          )
          .unique();
        successorName = profile?.displayName ?? null;
      }
      pots.push({
        potId: pot.potId,
        name: pot.name ?? null,
        outcome: nextOwner ? "anonymized" : "deleted",
        successorName,
      });
    }
    return { authorized: true as const, pots };
  },
});

export const begin = internalMutation({
  args: {
    refreshTokenHash: v.string(),
    requestId: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    validateUUIDv7(args.requestId, "ACCOUNT_DELETION_REQUEST_INVALID");
    const progress = await ctx.db
      .query("accountDeletionProgress")
      .withIndex("by_request_id", (index) => index.eq("requestId", args.requestId))
      .unique();
    const resumedAccount = progress ? await ctx.db.get(progress.accountId) : null;
    const authenticated = await accountForRefreshHash(
      ctx,
      args.refreshTokenHash,
      args.now,
    );
    if (!authenticated && !resumedAccount) return { authorized: false as const };
    const account = authenticated?.account ?? resumedAccount!;
    const existingProgress = await ctx.db
      .query("accountDeletionProgress")
      .withIndex("by_account", (index) => index.eq("accountId", account._id))
      .unique();
    if (existingProgress && existingProgress.requestId !== args.requestId) {
      fail("ACCOUNT_DELETION_REQUEST_MISMATCH");
    }
    if (account.deletionStartedAt === undefined) {
      await ctx.db.patch(account._id, { deletionStartedAt: args.now });
    }
    if (!existingProgress) {
      await ctx.db.insert("accountDeletionProgress", {
        requestId: args.requestId,
        accountId: account._id,
        startedAt: args.now,
      });
    }
    const authorization = await ctx.db
      .query("appleAuthorizations")
      .withIndex("by_account", (index) => index.eq("accountId", account._id))
      .unique();
    return {
      authorized: true as const,
      accountId: account._id,
      appleSubjectHash: account.appleSubjectHash,
      authorization: authorization === null || authorization.revokedAt !== undefined
        ? null
        : {
        encryptedRefreshToken: authorization.encryptedRefreshToken,
        encryptionNonce: authorization.encryptionNonce,
        encryptionKeyVersion: authorization.encryptionKeyVersion,
        appleClientId: authorization.appleClientId,
      },
    };
  },
});

export const markAppleAuthorizationRevoked = internalMutation({
  args: { accountId: v.id("accounts"), now: v.number() },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const authorization = await ctx.db
      .query("appleAuthorizations")
      .withIndex("by_account", (index) => index.eq("accountId", args.accountId))
      .unique();
    if (authorization && authorization.revokedAt === undefined) {
      await ctx.db.patch(authorization._id, { revokedAt: args.now });
    }
    return { revoked: true };
  },
});

export const processNextPot = internalMutation({
  args: {
    accountId: v.id("accounts"),
    transferEventId: v.string(),
    archiveEventId: v.string(),
    originatingTimeZone: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    validateUUIDv7(args.transferEventId, "ACCOUNT_DELETION_EVENT_INVALID");
    validateUUIDv7(args.archiveEventId, "ACCOUNT_DELETION_EVENT_INVALID");
    validateTimeZone(args.originatingTimeZone);
    const account = await ctx.db.get(args.accountId);
    if (!account || account.deletionStartedAt === undefined) {
      fail("ACCOUNT_DELETION_NOT_STARTED");
    }
    const membership = await ctx.db
      .query("potMembers")
      .withIndex("by_account_status", (index) =>
        index.eq("accountId", account._id).eq("status", "active"),
      )
      .first() ?? await ctx.db
      .query("potMembers")
      .withIndex("by_account_status", (index) =>
        index.eq("accountId", account._id).eq("status", "archived"),
      )
      .first();
    if (!membership) return { complete: true, outcome: null };
    const pot = await ctx.db
      .query("pots")
      .withIndex("by_pot_id", (index) => index.eq("potId", membership.potId))
      .unique();
    if (!pot) {
      await ctx.db.delete(membership._id);
      return { complete: false, outcome: "orphanRemoved" as const };
    }
    const remainingMembers = await activeMembers(ctx, pot.potId);
    const nextOwner = successor(remainingMembers, account._id);
    if (!nextOwner) {
      await sweepPot(ctx, pot);
      return { complete: false, outcome: "potDeletionProgress" as const };
    }

    let nextSequence = pot.nextSequence;
    if (pot.ownerAccountId === account._id) {
      const transferEvent: EventInput = {
        eventId: args.transferEventId,
        potId: pot.potId,
        actorMemberId: membership.memberId,
        occurredAtMillis: BigInt(args.now),
        originatingTimeZone: args.originatingTimeZone,
        schemaVersion: pot.minimumReaderSchemaVersion,
        payload: {
          kind: "ownershipTransferred",
          fromMemberId: membership.memberId,
          toMemberId: nextOwner.memberId,
        },
        textFields: [],
        authoredText: [],
      };
      nextSequence = await appendStructuralEvent(ctx, pot, nextSequence, transferEvent);
      await ctx.db.patch(nextOwner._id, { role: "owner" });
      const nextProfile = await ctx.db
        .query("potMemberProfiles")
        .withIndex("by_pot_member", (index) =>
          index.eq("potId", pot.potId).eq("memberId", nextOwner.memberId),
        )
        .unique();
      if (!nextProfile) fail("MEMBER_PROFILE_MISSING");
      await ctx.db.patch(nextProfile._id, { role: "owner", updatedAt: args.now });
      await ctx.db.patch(pot._id, { ownerAccountId: nextOwner.accountId });
    }
    if (membership.status === "active") {
      const archiveEvent: EventInput = {
        eventId: args.archiveEventId,
        potId: pot.potId,
        actorMemberId: membership.memberId,
        occurredAtMillis: BigInt(args.now),
        originatingTimeZone: args.originatingTimeZone,
        schemaVersion: pot.minimumReaderSchemaVersion,
        payload: { kind: "memberArchived", memberId: membership.memberId },
        textFields: [],
        authoredText: [],
      };
      nextSequence = await appendStructuralEvent(ctx, pot, nextSequence, archiveEvent);
    }
    await ctx.db.patch(pot._id, { nextSequence });
    const profile = await ctx.db
      .query("potMemberProfiles")
      .withIndex("by_pot_member", (index) =>
        index.eq("potId", pot.potId).eq("memberId", membership.memberId),
      )
      .unique();
    if (!profile) fail("MEMBER_PROFILE_MISSING");
    await ctx.db.patch(profile._id, {
      displayName: undefined,
      role: "member",
      state: "archived",
      updatedAt: args.now,
    });
    // A card link names its account, cards and labels; it goes with the account even though the
    // household stays for the others. Spends it already added remain ordinary shared records.
    const links = await ctx.db
      .query("cardSyncLinks")
      .withIndex("by_pot", (index) => index.eq("potId", pot.potId))
      .collect();
    for (const link of links) {
      if (link.accountId === account._id) await ctx.db.delete(link._id);
    }
    await ctx.db.delete(membership._id);
    return {
      complete: false,
      outcome: "anonymized" as const,
      potId: pot.potId,
      successorMemberId: pot.ownerAccountId === account._id
        ? nextOwner.memberId
        : null,
    };
  },
});

export const eraseIdentityBatch = internalMutation({
  args: {
    accountId: v.id("accounts"),
    requestId: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    validateUUIDv7(args.requestId, "ACCOUNT_DELETION_REQUEST_INVALID");
    const existingReceipt = await ctx.db
      .query("accountDeletionReceipts")
      .withIndex("by_request_id", (index) => index.eq("requestId", args.requestId))
      .unique();
    if (existingReceipt) return { complete: true };
    const account = await ctx.db.get(args.accountId);
    if (!account || account.deletionStartedAt === undefined) {
      fail("ACCOUNT_DELETION_NOT_STARTED");
    }
    const remainingMembership = await ctx.db
      .query("potMembers")
      .withIndex("by_account_status", (index) =>
        index.eq("accountId", account._id).eq("status", "active"),
      )
      .first() ?? await ctx.db
      .query("potMembers")
      .withIndex("by_account_status", (index) =>
        index.eq("accountId", account._id).eq("status", "archived"),
      )
      .first();
    if (remainingMembership) fail("ACCOUNT_DELETION_POTS_REMAIN");

    for (const table of accountSweep) {
      const rows = await takeIndexed(ctx.db, table, "by_account", "accountId", account._id);
      if (rows.length > 0) {
        for (const row of rows) await ctx.db.delete(row._id);
        return { complete: false };
      }
    }
    const subjectNotificationRows = await ctx.db.query("appleIdentityNotifications")
      .withIndex("by_apple_subject_hash", (index) =>
        index.eq("appleSubjectHash", account.appleSubjectHash),
      )
      .take(deletionBatchSize);
    if (subjectNotificationRows.length > 0) {
      for (const row of subjectNotificationRows) await ctx.db.delete(row._id);
      return { complete: false };
    }
    const issuedInvite = await ctx.db.query("invites")
      .withIndex("by_issuer", (index) => index.eq("issuedByAccountId", account._id))
      .first();
    if (issuedInvite) {
      const claims = await ctx.db.query("inviteClaims")
        .withIndex("by_invite", (index) => index.eq("inviteId", issuedInvite.inviteId))
        .take(deletionBatchSize);
      if (claims.length > 0) {
        for (const row of claims) await ctx.db.delete(row._id);
      } else {
        await ctx.db.delete(issuedInvite._id);
      }
      return { complete: false };
    }
    const claims = await ctx.db.query("inviteClaims")
      .withIndex("by_claimant", (index) => index.eq("claimantAccountId", account._id))
      .take(deletionBatchSize);
    if (claims.length > 0) {
      for (const row of claims) await ctx.db.delete(row._id);
      return { complete: false };
    }
    const mutes = await ctx.db.query("potMutes")
      .withIndex("by_account", (index) => index.eq("accountId", account._id))
      .take(deletionBatchSize);
    if (mutes.length > 0) {
      for (const row of mutes) await ctx.db.delete(row._id);
      return { complete: false };
    }
    const authorization = await ctx.db.query("appleAuthorizations")
      .withIndex("by_account", (index) => index.eq("accountId", account._id))
      .unique();
    if (authorization) {
      await ctx.db.delete(authorization._id);
      return { complete: false };
    }
    const authoredText = await ctx.db.query("eventTexts")
      .withIndex("by_author", (index) => index.eq("authorAccountId", account._id))
      .first();
    if (authoredText) fail("ACCOUNT_DELETION_TEXT_REMAINS");

    const progress = await ctx.db.query("accountDeletionProgress")
      .withIndex("by_account", (index) => index.eq("accountId", account._id))
      .unique();
    if (!progress || progress.requestId !== args.requestId) {
      fail("ACCOUNT_DELETION_PROGRESS_MISSING");
    }

    await ctx.db.insert("accountDeletionReceipts", {
      requestId: args.requestId,
      completedAt: args.now,
      expiresAt: args.now + receiptLifetimeMillis,
    });
    await ctx.db.delete(progress._id);
    await ctx.db.delete(account._id);
    return { complete: true };
  },
});

export const deleteExpiredReceipts = internalMutation({
  args: { now: v.number() },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const expired = await ctx.db.query("accountDeletionReceipts")
      .withIndex("by_expires_at", (index) => index.lt("expiresAt", args.now))
      .take(deletionBatchSize);
    for (const row of expired) await ctx.db.delete(row._id);
    return { deletedCount: expired.length, hasMore: expired.length === deletionBatchSize };
  },
});

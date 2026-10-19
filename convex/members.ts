import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import {
  fail,
  requireActiveMembership,
  requireSession,
} from "./lib/access";
import {
  consumeAccountWriteQuota,
  inviteIssueLimitPerDay,
  eventWriteLimitPerHour,
} from "./lib/accountWriteQuota";
import { requireApprovedWriteTarget } from "./lib/deployment";
import type { EventInput, TextField } from "./lib/eventValidation";
import {
  canonicalValue,
  validateDisplayName,
  validateEvent,
  validateUUIDv7,
} from "./lib/eventValidation";
import { sha256Hex } from "./lib/hash";
import {
  hashInviteCode,
  isCanonicalInviteCode,
  isCanonicalInviteToken,
} from "./lib/inviteCode";
import {
  isInviteClaimTicketId,
  readInviteTicketSecret,
  verifyInviteClaimTicketProof,
} from "./lib/inviteTicket";
import { eventInputValidator } from "./model";
import { loadClientContract } from "./lib/clientContract";
import {
  applyStructuralTopology,
  loadBudgetGroupTopology,
  type BudgetGroupTopology,
} from "./lib/budgetGroupTopology";

declare const process: { env: Record<string, string | undefined> };

// Per J7: default token life is 30 days; longer-lived invites are rejected.
const maximumInviteLifetimeMillis = 30 * 24 * 60 * 60 * 1000;

const memberClaimEventMetadataValidator = v.object({
  eventId: v.string(),
  occurredAtMillis: v.int64(),
  originatingTimeZone: v.string(),
  schemaVersion: v.int64(),
});

type MemberClaimEventMetadata = {
  eventId: string;
  occurredAtMillis: bigint;
  originatingTimeZone: string;
  schemaVersion: bigint;
};

async function getPot(ctx: MutationCtx, potId: string): Promise<Doc<"pots">> {
  const pot = await ctx.db
    .query("pots")
    .withIndex("by_pot_id", (index) => index.eq("potId", potId))
    .unique();
  if (!pot) fail("POT_MISSING");
  return pot;
}

async function getMemberProfile(
  ctx: MutationCtx,
  potId: string,
  memberId: string,
): Promise<Doc<"potMemberProfiles">> {
  const profile = await ctx.db
    .query("potMemberProfiles")
    .withIndex("by_pot_member", (index) =>
      index.eq("potId", potId).eq("memberId", memberId),
    )
    .unique();
  if (!profile) fail("MEMBER_PROFILE_MISSING");
  return profile;
}

type Roster = {
  memberIds: Set<string>;
  addedMemberIds: Set<string>;
  addedUnitIds: Set<string>;
  claimedMemberIds: Set<string>;
};

// The membership roster is derived from the append-only event log (memberAdded /
// memberClaimed) plus the current potMembers rows (which include the creating owner,
// who has no memberAdded event). Units grow only through memberAdded, which appends to
// pot.orderedUnitIds, so unit uniqueness is checked against that list directly.
async function loadRoster(ctx: MutationCtx, potId: string): Promise<Roster> {
  const memberIds = new Set<string>();
  const addedMemberIds = new Set<string>();
  const addedUnitIds = new Set<string>();
  const claimedMemberIds = new Set<string>();
  const members = await ctx.db
    .query("potMembers")
    .withIndex("by_pot_account", (index) => index.eq("potId", potId))
    .collect();
  for (const member of members) memberIds.add(member.memberId);
  const events = await ctx.db
    .query("events")
    .withIndex("by_pot_sequence", (index) => index.eq("potId", potId))
    .collect();
  for (const event of events) {
    if (event.payload.kind === "memberAdded") {
      memberIds.add(event.payload.memberId);
      addedMemberIds.add(event.payload.memberId);
      addedUnitIds.add(event.payload.unitId);
    } else if (event.payload.kind === "memberClaimed") {
      claimedMemberIds.add(event.payload.memberId);
    } else if (event.payload.kind === "memberClaimReassigned") {
      // A detached claim frees the identity again: the events arrive in sequence order,
      // so a later reassignment cancels the earlier claim and the member becomes
      // re-invitable without ever reusing its memberId or unitId.
      claimedMemberIds.delete(event.payload.memberId);
    }
  }
  return { memberIds, addedMemberIds, addedUnitIds, claimedMemberIds };
}

// Append a single validated membership event with server-assigned sequence. Membership
// events carry no financial payload, so this stays entirely off the money path in
// appendEventsToPot: it only assigns the next sequence, stores the row, and (for
// memberAdded) extends the pot's unit list. Idempotent replay returns the stored
// sequence. Convex mutation atomicity + OCC keep the sequence gap-free under concurrency.
async function appendMembershipEvent(
  ctx: MutationCtx,
  pot: Doc<"pots">,
  actorMemberId: string,
  event: EventInput,
  authorAccountId: Id<"accounts">,
  appendUnitId?: string,
  preparedTopology?: BudgetGroupTopology,
  groupExpectedRevision?: bigint,
): Promise<bigint> {
  const replaySequence = await existingMembershipEventSequence(
    ctx,
    pot,
    actorMemberId,
    event,
  );
  if (replaySequence !== undefined) return replaySequence;
  validateEvent(
    event,
    {
      potId: pot.potId,
      currency: { code: pot.currencyCode, exponent: pot.currencyExponent },
      orderedUnitIds: pot.orderedUnitIds,
      ownerMemberId: actorMemberId,
      minimumReaderSchemaVersion: pot.minimumReaderSchemaVersion,
    },
    { allowLegacyAuthoredText: false },
  );
  if (event.schemaVersion < pot.minimumReaderSchemaVersion) fail("SCHEMA_DOWNGRADE");
  if (event.schemaVersion === 2n && pot.minimumReaderSchemaVersion < 2n && !preparedTopology) {
    fail("BUDGET_GROUP_ACTIVATION_REQUIRED");
  }
  const sequence = pot.nextSequence;
  const topology = preparedTopology ?? (pot.minimumReaderSchemaVersion === 2n
    ? applyStructuralTopology(await loadBudgetGroupTopology(ctx, pot), event, sequence, pot.orderedUnitIds)
    : undefined);
  const createdAt = Date.now();
  await ctx.db.insert("events", {
    potId: pot.potId,
    eventId: event.eventId,
    actorMemberId: event.actorMemberId,
    occurredAtMillis: event.occurredAtMillis,
    originatingTimeZone: event.originatingTimeZone,
    schemaVersion: event.schemaVersion,
    sequence,
    payload: event.payload,
    textFields: event.textFields,
    ...(groupExpectedRevision === undefined ? {} : { groupExpectedRevision }),
    createdAt,
  });
  for (const authored of event.authoredText) {
    await ctx.db.insert("eventTexts", {
      potId: pot.potId,
      eventId: event.eventId,
      sequence,
      field: authored.field,
      value: authored.value,
      authorAccountId,
      createdAt,
    });
  }
  await ctx.db.patch(pot._id, {
    nextSequence: sequence + 1n,
    ...(topology ? {
      budgetGroupTopology: topology,
      minimumReaderSchemaVersion: topology.minimumSchemaVersion,
    } : {}),
    ...(appendUnitId
      ? { orderedUnitIds: [...pot.orderedUnitIds, appendUnitId] }
      : {}),
  });
  return sequence;
}

async function existingMembershipEventSequence(
  ctx: MutationCtx,
  pot: Doc<"pots">,
  actorMemberId: string,
  event: EventInput,
): Promise<bigint | undefined> {
  if (event.potId !== pot.potId) fail("EVENT_POT_MISMATCH");
  if (event.actorMemberId !== actorMemberId) fail("ACTOR_MISMATCH");
  const existing = await ctx.db
    .query("events")
    .withIndex("by_event_id", (index) => index.eq("eventId", event.eventId))
    .unique();
  if (existing) {
    const incomingShape = {
      eventId: event.eventId,
      potId: event.potId,
      actorMemberId: event.actorMemberId,
      occurredAtMillis: event.occurredAtMillis,
      originatingTimeZone: event.originatingTimeZone,
      schemaVersion: event.schemaVersion,
      payload: event.payload,
      textFields: event.textFields,
    };
    const storedShape = {
      eventId: existing.eventId,
      potId: existing.potId,
      actorMemberId: existing.actorMemberId,
      occurredAtMillis: existing.occurredAtMillis,
      originatingTimeZone: existing.originatingTimeZone,
      schemaVersion: existing.schemaVersion,
      payload: existing.payload,
      textFields: existing.textFields,
    };
    if (
      existing.potId !== pot.potId
      || canonicalValue(storedShape) !== canonicalValue(incomingShape)
    ) {
      fail("EVENT_ID_CONFLICT");
    }
    const retainedText = await ctx.db
      .query("eventTexts")
      .withIndex("by_pot_event", (index) =>
        index.eq("potId", pot.potId).eq("eventId", event.eventId),
      )
      .collect();
    const incomingText = new Map(
      event.authoredText.map(({ field, value }) => [field, value]),
    );
    if (
      retainedText.length !== event.authoredText.length
      || retainedText.some((sidecar) =>
        incomingText.get(sidecar.field as TextField) !== sidecar.value,
      )
    ) {
      fail("EVENT_TEXT_CONFLICT");
    }
    return existing.sequence;
  }
  return undefined;
}

type InviteCredentialLookup = {
  invite: Doc<"invites">;
  canCreate: boolean;
  createFailureCode?: "INVITE_INVALID" | "INVITE_EXPIRED";
};

function credentialLookup(
  invite: Doc<"invites"> | null,
  kind: Doc<"invites">["kind"],
  credentialFresh: boolean,
): InviteCredentialLookup {
  if (!invite) fail("INVITE_INVALID");
  if (invite.kind !== kind) fail("INVITE_KIND_MISMATCH");
  const inviteExpired = invite.expiresAt <= Date.now();
  const canCreate = credentialFresh
    && invite.status === "active"
    && !inviteExpired;
  return {
    invite,
    canCreate,
    ...(canCreate
      ? {}
      : {
        createFailureCode: credentialFresh
          && invite.status === "active"
          && inviteExpired
          ? "INVITE_EXPIRED" as const
          : "INVITE_INVALID" as const,
      }),
  };
}

function inviteSecret(): string {
  try {
    return readInviteTicketSecret(process.env);
  } catch {
    fail("INVITE_TICKET_CONFIGURATION_INVALID");
  }
}

async function inviteByToken(
  ctx: MutationCtx,
  token: string,
  kind: Doc<"invites">["kind"],
): Promise<InviteCredentialLookup> {
  if (!isCanonicalInviteToken(token)) fail("INVITE_INVALID");
  const tokenHash = await sha256Hex(token);
  const matches = await ctx.db
    .query("invites")
    .withIndex("by_token_hash", (index) => index.eq("tokenHash", tokenHash))
    .take(2);
  return credentialLookup(
    matches.length === 1 ? matches[0] : null,
    kind,
    true,
  );
}

async function inviteByTicket(
  ctx: MutationCtx,
  ticket: string,
  kind: Doc<"invites">["kind"],
): Promise<InviteCredentialLookup> {
  const secret = inviteSecret();
  const proof = await verifyInviteClaimTicketProof(ticket, Date.now(), secret);
  if (!proof) fail("INVITE_TICKET_INVALID");
  const matches = await ctx.db
    .query("invites")
    .withIndex("by_invite_id", (index) => index.eq("inviteId", proof.inviteId))
    .take(2);
  return credentialLookup(
    matches.length === 1 ? matches[0] : null,
    kind,
    proof.isFresh,
  );
}

async function claimPerMember(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  credential: InviteCredentialLookup,
  event: EventInput,
) {
  const { invite } = credential;
  if (event.payload.kind !== "memberClaimed") fail("EXPECTED_MEMBER_CLAIMED");
  const memberId = invite.pendingMemberId;
  if (!memberId) fail("INVITE_INVALID");
  if (event.payload.memberId !== memberId) fail("CLAIM_MEMBER_MISMATCH");
  if (event.potId !== invite.potId) fail("CLAIM_POT_MISMATCH");
  const pot = await getPot(ctx, invite.potId);
  const existingEvent = await ctx.db
    .query("events")
    .withIndex("by_event_id", (index) => index.eq("eventId", event.eventId))
    .unique();
  if (existingEvent) {
    const existingMembership = await ctx.db
      .query("potMembers")
      .withIndex("by_pot_account", (index) =>
        index.eq("potId", invite.potId).eq("accountId", accountId),
      )
      .unique();
    if (
      invite.status !== "consumed"
      || existingMembership?.memberId !== memberId
      || existingMembership.status !== "active"
    ) {
      fail("INVITE_INVALID");
    }
    const sequence = await appendMembershipEvent(
      ctx,
      pot,
      memberId,
      event,
      accountId,
    );
    return { sequence, memberId, potId: invite.potId };
  }
  if (!credential.canCreate) fail(credential.createFailureCode ?? "INVITE_INVALID");
  const roster = await loadRoster(ctx, invite.potId);
  if (!roster.addedMemberIds.has(memberId)) fail("UNKNOWN_PENDING_MEMBER");
  if (roster.claimedMemberIds.has(memberId)) fail("MEMBER_ALREADY_CLAIMED");
  const existingMembership = await ctx.db
    .query("potMembers")
    .withIndex("by_pot_account", (index) =>
      index.eq("potId", invite.potId).eq("accountId", accountId),
    )
    .unique();
  if (existingMembership) fail("ALREADY_MEMBER");
  const profile = await getMemberProfile(ctx, invite.potId, memberId);
  // Archival withdraws admission even if an unused invite/ticket survives it.
  if (profile.state === "archived") fail("MEMBER_ALREADY_ARCHIVED");
  await ctx.db.insert("potMembers", {
    potId: invite.potId,
    accountId,
    memberId,
    role: "member",
    status: "active",
    joinedAt: Date.now(),
  });
  await ctx.db.patch(profile._id, {
    state: "active",
    updatedAt: Date.now(),
  });
  const sequence = await appendMembershipEvent(
    ctx,
    pot,
    memberId,
    event,
    accountId,
  );
  await ctx.db.patch(invite._id, { status: "consumed" });
  return { sequence, memberId, potId: invite.potId };
}

function perMemberClaimEvent(
  invite: Doc<"invites">,
  metadata: MemberClaimEventMetadata,
): EventInput {
  if (!invite.pendingMemberId) fail("INVITE_INVALID");
  return {
    ...metadata,
    potId: invite.potId,
    actorMemberId: invite.pendingMemberId,
    payload: {
      kind: "memberClaimed",
      memberId: invite.pendingMemberId,
    },
    textFields: [],
    authoredText: [],
  };
}

async function claimPotLink(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  credential: InviteCredentialLookup,
  chosenMemberId?: string,
) {
  const { invite } = credential;
  const existingMembership = await ctx.db
    .query("potMembers")
    .withIndex("by_pot_account", (index) =>
      index.eq("potId", invite.potId).eq("accountId", accountId),
    )
    .unique();
  if (existingMembership) fail("ALREADY_MEMBER");
  const priorClaims = await ctx.db
    .query("inviteClaims")
    .withIndex("by_pot_claimant", (index) =>
      index.eq("potId", invite.potId).eq("claimantAccountId", accountId),
    )
    .collect();
  const pendingClaims = priorClaims.filter((claim) => claim.status === "pending");
  if (
    pendingClaims.length === 1
    && pendingClaims[0].inviteId === invite.inviteId
    && pendingClaims[0].chosenMemberId === chosenMemberId
  ) {
    return { status: "pending" as const };
  }
  if (pendingClaims.length > 0) {
    fail("CLAIM_ALREADY_PENDING");
  }
  if (!credential.canCreate) fail(credential.createFailureCode ?? "INVITE_INVALID");
  if (chosenMemberId) {
    const roster = await loadRoster(ctx, invite.potId);
    if (!roster.addedMemberIds.has(chosenMemberId)) fail("UNKNOWN_PENDING_MEMBER");
    if (roster.claimedMemberIds.has(chosenMemberId)) fail("MEMBER_ALREADY_CLAIMED");
    const profile = await getMemberProfile(ctx, invite.potId, chosenMemberId);
    if (profile.state === "archived") fail("MEMBER_ALREADY_ARCHIVED");
  }
  await ctx.db.insert("inviteClaims", {
    potId: invite.potId,
    inviteId: invite.inviteId,
    claimantAccountId: accountId,
    ...(chosenMemberId ? { chosenMemberId } : {}),
    status: "pending",
    createdAt: Date.now(),
  });
  return { status: "pending" as const };
}

/** Owner-only schema-2 activation/setup. Grouping never establishes a claim or ACL. */
export const changeBudgetGroups = mutation({
  args: { potId: v.string(), expectedTopologyRevision: v.int64(), event: eventInputValidator },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    const membership = await requireActiveMembership(ctx, args.potId, account._id);
    return changeBudgetGroupsForMember(ctx, account._id, membership, args);
  },
});


export async function changeBudgetGroupsForMember(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  membership: Doc<"potMembers">,
  args: { potId: string; expectedTopologyRevision: bigint; event: EventInput },
) {
    if (args.event.payload.kind !== "groupChanged") fail("EXPECTED_GROUP_CHANGED");
    if (args.event.schemaVersion !== 2n) fail("BUDGET_GROUP_SCHEMA_REQUIRED");
    if (args.expectedTopologyRevision < 0n) fail("INVALID_TOPOLOGY_REVISION");
    const pot = await getPot(ctx, args.potId);
    const replay = await existingMembershipEventSequence(ctx, pot, membership.memberId, args.event);
    if (replay !== undefined) {
      const stored = await ctx.db.query("events")
        .withIndex("by_pot_event", (q) => q.eq("potId", pot.potId).eq("eventId", args.event.eventId)).unique();
      if (stored?.groupExpectedRevision !== args.expectedTopologyRevision) fail("EVENT_ID_CONFLICT");
      return { sequence: replay, topologyRevision: replay };
    }
    // An active original actor may recover their immutable receipt after
    // transferring ownership; only new setup requires the current owner.
    if (membership.role !== "owner") fail("NOT_OWNER");
    if (pot.archivedAtSequence !== undefined) fail("POT_ARCHIVED");
    validateEvent(args.event, {
      potId: pot.potId, currency: { code: pot.currencyCode, exponent: pot.currencyExponent },
      ownerMemberId: membership.memberId, orderedUnitIds: pot.orderedUnitIds,
      minimumReaderSchemaVersion: pot.minimumReaderSchemaVersion,
    });
    const before = await loadBudgetGroupTopology(ctx, pot);
    if (!before.members.some((member) => member.memberId === membership.memberId && !member.archived)) {
      fail("OWNER_UNIT_NOT_BOUND");
    }
    if (before.revision !== args.expectedTopologyRevision) fail("TOPOLOGY_REVISION_CONFLICT");
    const contract = await loadClientContract(ctx);
    const topology = applyStructuralTopology(
      before, args.event, pot.nextSequence, pot.orderedUnitIds, false, contract.maximumBudgetGroupSize,
    );
    const orderedUnitIds = [...pot.orderedUnitIds];
    for (const group of topology.groups) if (!orderedUnitIds.includes(group.unitId)) orderedUnitIds.push(group.unitId);
    await consumeAccountWriteQuota(ctx, {
      accountId: accountId, scope: "event", amount: 1n, limit: eventWriteLimitPerHour,
      windowMillis: 3_600_000, now: Date.now(),
    });
    const sequence = await appendMembershipEvent(ctx, pot, membership.memberId,
      args.event, accountId, undefined, topology, args.expectedTopologyRevision);
    await ctx.db.patch(pot._id, { orderedUnitIds });
    return { sequence, topologyRevision: sequence };
}

export const getBudgetGroupTopology = query({
  args: { potId: v.string() },
  handler: async (ctx, args) => {
    const { account } = await requireSession(ctx);
    await requireActiveMembership(ctx, args.potId, account._id);
    const pot = await ctx.db.query("pots").withIndex("by_pot_id", (q) => q.eq("potId", args.potId)).unique();
    if (!pot) fail("POT_MISSING");
    return await loadBudgetGroupTopology(ctx, pot);
  },
});

type PendingMemberBound = {
  ctx: MutationCtx;
  account: { _id: Id<"accounts"> };
  membership: Doc<"potMembers">;
  args: { potId: string; displayName: string; event: EventInput };
  /** addPendingMember appends a new unit; bindPendingMember binds an existing one. */
  mode: "addUnit" | "bindUnit";
};

/**
 * Shared body of addPendingMember / bindPendingMember. Replay returns the stored
 * sequence without touching the roster; fresh inserts create the pending profile
 * first (it is the server-readable sidecar that persists across offline windows),
 * then append the memberAdded event.
 */
async function addOrBindPendingMember(
  { ctx, account, membership, args, mode }: PendingMemberBound,
): Promise<{ sequence: bigint }> {
  requireApprovedWriteTarget();
  if (membership.role !== "owner") fail("NOT_OWNER");
  if (args.event.payload.kind !== "memberAdded") fail("EXPECTED_MEMBER_ADDED");
  if (args.event.payload.role !== "member") fail("MEMBER_ROLE_REQUIRED");
  validateDisplayName(args.displayName);
  const pot = await getPot(ctx, args.potId);
  const { memberId, unitId } = args.event.payload;
  if (mode === "bindUnit" && !pot.orderedUnitIds.includes(unitId)) {
    fail("UNKNOWN_UNIT");
  }
  const existingEvent = await ctx.db
    .query("events")
    .withIndex("by_event_id", (index) => index.eq("eventId", args.event.eventId))
    .unique();
  const existingProfile = await ctx.db
    .query("potMemberProfiles")
    .withIndex("by_pot_member", (index) =>
      index.eq("potId", args.potId).eq("memberId", memberId),
    )
    .unique();
  if (existingEvent) {
    if (
      existingProfile?.displayName !== args.displayName
      || existingProfile.unitId !== unitId
      || existingProfile.role !== "member"
    ) {
      fail("MEMBER_PROFILE_CONFLICT");
    }
    const sequence = await appendMembershipEvent(
      ctx,
      pot,
      membership.memberId,
      args.event,
      account._id,
      mode === "addUnit" ? unitId : undefined,
    );
    return { sequence };
  }
  if (existingProfile) fail("MEMBER_PROFILE_CONFLICT");
  const roster = await loadRoster(ctx, args.potId);
  if (roster.memberIds.has(memberId)) fail("MEMBER_ALREADY_EXISTS");
  if (mode === "addUnit") {
    if (pot.orderedUnitIds.includes(unitId)) fail("UNIT_ALREADY_EXISTS");
    if (pot.orderedUnitIds.length >= 64) fail("TOO_MANY_UNITS");
  } else {
    if (roster.addedUnitIds.has(unitId)) fail("UNIT_ALREADY_BOUND");
  }
  const now = Date.now();
  await ctx.db.insert("potMemberProfiles", {
    potId: args.potId,
    memberId,
    unitId,
    displayName: args.displayName,
    role: "member",
    state: "pending",
    createdAt: now,
    updatedAt: now,
  });
  const sequence = await appendMembershipEvent(
    ctx,
    pot,
    membership.memberId,
    args.event,
    account._id,
    mode === "addUnit" ? unitId : undefined,
  );
  return { sequence };
}

// Owner adds a pending member (a new unit + identity that nobody has claimed yet).
export const addPendingMember = mutation({
  args: {
    potId: v.string(),
    displayName: v.string(),
    event: eventInputValidator,
  },
  handler: async (ctx, args) => {
    const { account } = await requireSession(ctx);
    const membership = await requireActiveMembership(ctx, args.potId, account._id);
    return await addOrBindPendingMember({
      ctx, account, membership, args, mode: "addUnit",
    });
  },
});

// Local pots already carry their configured settlement units before they gain an
// account. Promotion preserves those unit ids, so pending identities created during
// offline setup bind to an existing unowned unit rather than adding a duplicate unit.
export const bindPendingMember = mutation({
  args: {
    potId: v.string(),
    displayName: v.string(),
    event: eventInputValidator,
  },
  handler: async (ctx, args) => {
    const { account } = await requireSession(ctx);
    const membership = await requireActiveMembership(ctx, args.potId, account._id);
    return await addOrBindPendingMember({
      ctx, account, membership, args, mode: "bindUnit",
    });
  },
});

// Owner issues an invite. The owner's device generates a URL-safe high-entropy token and
// a six-character code; only a token digest and secret-keyed code digest are stored.
// Per-member invites bind 1:1 to an added-but-unclaimed member.
export const issueInvite = mutation({
  args: {
    potId: v.string(),
    inviteId: v.string(),
    kind: v.union(v.literal("perMember"), v.literal("potLink")),
    pendingMemberId: v.optional(v.string()),
    token: v.string(),
    code: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    const membership = await requireActiveMembership(ctx, args.potId, account._id);
    if (membership.role !== "owner") fail("NOT_OWNER");
    const now = Date.now();
    if (!isCanonicalInviteToken(args.token)) {
      fail("INVITE_SECRET_TOO_WEAK");
    }
    if (!isCanonicalInviteCode(args.code)) fail("INVITE_CODE_INVALID");
    if (!isInviteClaimTicketId(args.inviteId)) fail("INVITE_ID_INVALID");
    const tokenHash = await sha256Hex(args.token);
    const codeHash = await hashInviteCode(args.code, inviteSecret());
    const existing = await ctx.db
      .query("invites")
      .withIndex("by_invite_id", (index) => index.eq("inviteId", args.inviteId))
      .unique();
    if (existing) {
      if (
        existing.potId !== args.potId
        || existing.kind !== args.kind
        || existing.pendingMemberId !== args.pendingMemberId
        || existing.tokenHash !== tokenHash
        || existing.codeHash !== codeHash
        || existing.issuedByAccountId !== account._id
        || existing.expiresAt !== args.expiresAt
      ) {
        fail("INVITE_ALREADY_EXISTS");
      }
      return { inviteId: existing.inviteId };
    }
    if (
      args.expiresAt <= now
      || args.expiresAt > now + maximumInviteLifetimeMillis
    ) {
      fail("INVITE_EXPIRY_INVALID");
    }
    if (args.kind === "perMember") {
      if (!args.pendingMemberId) fail("MISSING_PENDING_MEMBER");
      const roster = await loadRoster(ctx, args.potId);
      if (!roster.addedMemberIds.has(args.pendingMemberId)) {
        fail("UNKNOWN_PENDING_MEMBER");
      }
      if (roster.claimedMemberIds.has(args.pendingMemberId)) {
        fail("MEMBER_ALREADY_CLAIMED");
      }
      const profile = await getMemberProfile(ctx, args.potId, args.pendingMemberId);
      if (profile.state === "archived") fail("MEMBER_ALREADY_ARCHIVED");
      const siblingInvites = await ctx.db
        .query("invites")
        .withIndex("by_pot", (index) => index.eq("potId", args.potId))
        .collect();
      if (siblingInvites.some((invite) =>
        invite.kind === "perMember"
        && invite.pendingMemberId === args.pendingMemberId
        && invite.status === "active"
        && invite.expiresAt > now,
      )) {
        fail("INVITE_PENDING_MEMBER_ALREADY_ACTIVE");
      }
    } else if (args.pendingMemberId) {
      fail("POT_LINK_HAS_NO_MEMBER");
    }
    if ((await ctx.db
      .query("invites")
      .withIndex("by_code_hash", (index) => index.eq("codeHash", codeHash))
      .take(1)).length > 0) {
      fail("INVITE_CODE_UNAVAILABLE");
    }
    if ((await ctx.db
      .query("invites")
      .withIndex("by_token_hash", (index) => index.eq("tokenHash", tokenHash))
      .take(1)).length > 0) {
      fail("INVITE_SECRET_ALREADY_USED");
    }
    await consumeAccountWriteQuota(ctx, {
      accountId: account._id,
      scope: "inviteIssue",
      amount: 1n,
      limit: inviteIssueLimitPerDay,
      windowMillis: 86_400_000,
      now,
    });
    await ctx.db.insert("invites", {
      potId: args.potId,
      inviteId: args.inviteId,
      kind: args.kind,
      tokenHash,
      codeHash,
      ...(args.pendingMemberId ? { pendingMemberId: args.pendingMemberId } : {}),
      issuedByAccountId: account._id,
      status: "active",
      expiresAt: args.expiresAt,
      createdAt: now,
    });
    return { inviteId: args.inviteId };
  },
});

// Owners can inspect active invite metadata without recovering either secret.
// Expired records remain visible until revoked so the device can explain why a
// newly generated credential replaced an older one.
export const listInvites = query({
  args: { potId: v.string() },
  handler: async (ctx, args) => {
    const { account } = await requireSession(ctx);
    const membership = await requireActiveMembership(ctx, args.potId, account._id);
    if (membership.role !== "owner") fail("NOT_OWNER");
    const invites = await ctx.db
      .query("invites")
      .withIndex("by_pot", (index) => index.eq("potId", args.potId))
      .collect();
    return invites
      .filter((invite) => invite.status === "active")
      .sort((left, right) =>
        left.createdAt !== right.createdAt
          ? left.createdAt - right.createdAt
          : left.inviteId.localeCompare(right.inviteId))
      .map((invite) => ({
        inviteId: invite.inviteId,
        kind: invite.kind,
        ...(invite.pendingMemberId
          ? { pendingMemberId: invite.pendingMemberId }
          : {}),
        expiresAt: invite.expiresAt,
        createdAt: invite.createdAt,
      }));
  },
});

export const revokeInvite = mutation({
  args: { potId: v.string(), inviteId: v.string() },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    const membership = await requireActiveMembership(ctx, args.potId, account._id);
    if (membership.role !== "owner") fail("NOT_OWNER");
    const invite = await ctx.db
      .query("invites")
      .withIndex("by_invite_id", (index) => index.eq("inviteId", args.inviteId))
      .unique();
    if (!invite || invite.potId !== args.potId) fail("INVITE_INVALID");
    if (invite.status === "consumed") fail("INVITE_ALREADY_USED");
    if (invite.status === "active") await ctx.db.patch(invite._id, { status: "revoked" });
    return { status: "revoked" as const };
  },
});

// A signed-in account claims a per-member invite by presenting the raw token. The server
// fills the private pot/member fields into the append-only event; the client supplies only
// event identity/time metadata. An exact same-account retry returns the stored sequence.
// Token and claim-ticket presentations resolve the same credential two ways; the pairs
// below share one resolver per flow.
export const claimPerMemberInvite = mutation({
  args: { token: v.string(), event: memberClaimEventMetadataValidator },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    const credential = await inviteByToken(ctx, args.token, "perMember");
    return claimPerMember(
      ctx,
      account._id,
      credential,
      perMemberClaimEvent(credential.invite, args.event),
    );
  },
});

export const claimPerMemberInviteWithTicket = mutation({
  args: { ticket: v.string(), event: memberClaimEventMetadataValidator },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    const credential = await inviteByTicket(ctx, args.ticket, "perMember");
    return claimPerMember(
      ctx,
      account._id,
      credential,
      perMemberClaimEvent(credential.invite, args.event),
    );
  },
});

async function perMemberClaimEventFromToken(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  token: string,
  event: MemberClaimEventMetadata,
) {
  const credential = await inviteByToken(ctx, token, "perMember");
  return perMemberClaimEvent(credential.invite, event);
}

// A signed-in account claims a multi-use pot-link invite. This records a PENDING claim
// only — it grants no membership and therefore no read access, so a leaked pot link
// cannot expose history until the owner approves. "I'm Leo" sets chosenMemberId; "I'm
// new here" leaves it undefined for the owner to assign an added member on approval.
export const claimPotLinkInvite = mutation({
  args: { token: v.string(), chosenMemberId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    return claimPotLink(
      ctx,
      account._id,
      await inviteByToken(ctx, args.token, "potLink"),
      args.chosenMemberId,
    );
  },
});

export const claimPotLinkInviteWithTicket = mutation({
  args: { ticket: v.string(), chosenMemberId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    return claimPotLink(
      ctx,
      account._id,
      await inviteByTicket(ctx, args.ticket, "potLink"),
      args.chosenMemberId,
    );
  },
});

// Owner approves a pending pot-link claim, binding the claimant's account to an
// added-but-unclaimed member and making history visible to them from here on.
export const approvePotLinkClaim = mutation({
  args: {
    claimId: v.id("inviteClaims"),
    memberId: v.string(),
    event: eventInputValidator,
  },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    const claim = await ctx.db.get(args.claimId);
    if (!claim) fail("CLAIM_INVALID");
    const membership = await requireActiveMembership(ctx, claim.potId, account._id);
    if (membership.role !== "owner") fail("NOT_OWNER");
    if (args.event.payload.kind !== "memberClaimed") fail("EXPECTED_MEMBER_CLAIMED");
    if (claim.chosenMemberId && claim.chosenMemberId !== args.memberId) {
      fail("CLAIM_MEMBER_MISMATCH");
    }
    if (args.event.payload.memberId !== args.memberId) fail("CLAIM_MEMBER_MISMATCH");
    if (args.event.actorMemberId !== args.memberId) fail("ACTOR_MISMATCH");
    if (args.event.potId !== claim.potId) fail("CLAIM_POT_MISMATCH");
    const pot = await getPot(ctx, claim.potId);
    const replaySequence = await existingMembershipEventSequence(
      ctx,
      pot,
      args.memberId,
      args.event,
    );
    if (replaySequence !== undefined) {
      return { sequence: replaySequence, memberId: args.memberId };
    }
    if (claim.status !== "pending") fail("CLAIM_INVALID");
    const roster = await loadRoster(ctx, claim.potId);
    if (!roster.addedMemberIds.has(args.memberId)) fail("UNKNOWN_PENDING_MEMBER");
    if (roster.claimedMemberIds.has(args.memberId)) fail("MEMBER_ALREADY_CLAIMED");
    const existingMembership = await ctx.db
      .query("potMembers")
      .withIndex("by_pot_account", (index) =>
        index.eq("potId", claim.potId).eq("accountId", claim.claimantAccountId),
      )
      .unique();
    if (existingMembership) fail("ALREADY_MEMBER");
    const profile = await getMemberProfile(ctx, claim.potId, args.memberId);
    if (profile.state === "archived") fail("MEMBER_ALREADY_ARCHIVED");
    await ctx.db.insert("potMembers", {
      potId: claim.potId,
      accountId: claim.claimantAccountId,
      memberId: args.memberId,
      role: "member",
      status: "active",
      joinedAt: Date.now(),
    });
    await ctx.db.patch(profile._id, {
      state: "active",
      updatedAt: Date.now(),
    });
    const sequence = await appendMembershipEvent(
      ctx,
      pot,
      args.memberId,
      args.event,
      account._id,
    );
    await ctx.db.patch(claim._id, { status: "approved" });
    return { sequence, memberId: args.memberId };
  },
});

// Owner rejects a pending pot-link claim; no membership is created.
export const rejectPotLinkClaim = mutation({
  args: { claimId: v.id("inviteClaims") },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    const claim = await ctx.db.get(args.claimId);
    if (!claim) fail("CLAIM_INVALID");
    const membership = await requireActiveMembership(ctx, claim.potId, account._id);
    if (membership.role !== "owner") fail("NOT_OWNER");
    if (claim.status === "rejected") return { status: "rejected" as const };
    if (claim.status !== "pending") fail("CLAIM_INVALID");
    await ctx.db.patch(claim._id, { status: "rejected" });
    return { status: "rejected" as const };
  },
});

// Owner-only view of pending pot-link claims awaiting a decision.
export const listPendingClaims = query({
  args: { potId: v.string() },
  handler: async (ctx, args) => {
    const { account } = await requireSession(ctx);
    const membership = await requireActiveMembership(ctx, args.potId, account._id);
    if (membership.role !== "owner") fail("NOT_OWNER");
    const claims = await ctx.db
      .query("inviteClaims")
      .withIndex("by_pot_status", (index) =>
        index.eq("potId", args.potId).eq("status", "pending"),
      )
      .collect();
    return claims.map((claim) => ({
      claimId: claim._id,
      inviteId: claim.inviteId,
      chosenMemberId: claim.chosenMemberId ?? null,
      createdAt: claim.createdAt,
    }));
  },
});

// Every active member can resolve per-pot identities. Account ids stay private and
// display names remain in the mutable profile sidecar rather than event history.
export const listRoster = query({
  args: { potId: v.string() },
  handler: async (ctx, args) => {
    const { account } = await requireSession(ctx);
    await requireActiveMembership(ctx, args.potId, account._id);
    const pot = await ctx.db
      .query("pots")
      .withIndex("by_pot_id", (index) => index.eq("potId", args.potId))
      .unique();
    if (!pot) fail("POT_MISSING");
    const profiles = await ctx.db
      .query("potMemberProfiles")
      .withIndex("by_pot_member", (index) => index.eq("potId", args.potId))
      .take(65);
    if (profiles.length > 64) fail("TOO_MANY_MEMBERS");
    const unitOrder = new Map(
      pot.orderedUnitIds.map((unitId, index) => [unitId, index]),
    );
    profiles.sort((left, right) => {
      const leftIndex = left.unitId === undefined
        ? -1
        : (unitOrder.get(left.unitId) ?? Number.MAX_SAFE_INTEGER);
      const rightIndex = right.unitId === undefined
        ? -1
        : (unitOrder.get(right.unitId) ?? Number.MAX_SAFE_INTEGER);
      return leftIndex - rightIndex || left.memberId.localeCompare(right.memberId);
    });
    return profiles.map((profile) => ({
      memberId: profile.memberId,
      unitId: profile.unitId ?? null,
      ...(pot.budgetGroupTopology ? {
        budgetUnitId: pot.budgetGroupTopology.members.find((member) => member.memberId === profile.memberId)?.unitId ?? null,
      } : {}),
      displayName: profile.displayName ?? null,
      role: profile.role,
      state: profile.state,
    }));
  },
});

// Non-user erasure path from §7.6/§11.4. Only an unclaimed identity may use this
// owner-driven operation; claimed-account erasure is handled by account deletion.
export const anonymizePendingMember = mutation({
  args: { potId: v.string(), memberId: v.string() },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    const membership = await requireActiveMembership(ctx, args.potId, account._id);
    if (membership.role !== "owner") fail("NOT_OWNER");
    const profile = await getMemberProfile(ctx, args.potId, args.memberId);
    if (profile.state !== "pending") fail("MEMBER_NOT_PENDING");
    await ctx.db.patch(profile._id, {
      displayName: undefined,
      updatedAt: Date.now(),
    });
    return { status: "anonymized" as const };
  },
});

// Bind the creating owner to one of the pot's existing units. Pot creation records the
// unit list and the owner's memberId but never links them, because promotion cannot
// carry structural events — leaving the owner's unit owned by nobody, so they would
// never be a push recipient. This appends the owner's own memberAdded over an EXISTING
// unit (so the unit list does not grow) and completes the roster binding.
export const bindOwnerUnit = mutation({
  args: { potId: v.string(), event: eventInputValidator },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    const membership = await requireActiveMembership(ctx, args.potId, account._id);
    if (membership.role !== "owner") fail("NOT_OWNER");
    if (args.event.payload.kind !== "memberAdded") fail("EXPECTED_MEMBER_ADDED");
    if (args.event.payload.role !== "owner") fail("OWNER_ROLE_REQUIRED");
    if (args.event.payload.memberId !== membership.memberId) fail("NOT_SELF_BINDING");
    const pot = await getPot(ctx, args.potId);
    const { unitId } = args.event.payload;
    if (!pot.orderedUnitIds.includes(unitId)) fail("UNKNOWN_UNIT");
    const existingEvent = await ctx.db
      .query("events")
      .withIndex("by_event_id", (index) => index.eq("eventId", args.event.eventId))
      .unique();
    const profile = await getMemberProfile(
      ctx,
      args.potId,
      membership.memberId,
    );
    if (existingEvent) {
      if (
        profile.unitId !== unitId
        || profile.role !== "owner"
        || profile.state !== "active"
      ) {
        fail("MEMBER_PROFILE_CONFLICT");
      }
      const sequence = await appendMembershipEvent(
        ctx,
        pot,
        membership.memberId,
        args.event,
        account._id,
      );
      return { sequence };
    }
    if (profile.unitId !== undefined) fail("OWNER_ALREADY_BOUND");
    const roster = await loadRoster(ctx, args.potId);
    if (roster.addedMemberIds.has(membership.memberId)) fail("OWNER_ALREADY_BOUND");
    if (roster.addedUnitIds.has(unitId)) fail("UNIT_ALREADY_BOUND");
    const sequence = await appendMembershipEvent(
      ctx,
      pot,
      membership.memberId,
      args.event,
      account._id,
    );
    await ctx.db.patch(profile._id, {
      unitId,
      updatedAt: Date.now(),
    });
    return { sequence };
  },
});

// Owner renames the pot. The name is projected onto the pot document so the server can
// compose pot-named push text itself; the append-only event stays the source of truth.
export const renamePot = mutation({
  args: { potId: v.string(), event: eventInputValidator },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    const membership = await requireActiveMembership(ctx, args.potId, account._id);
    if (membership.role !== "owner") fail("NOT_OWNER");
    if (args.event.payload.kind !== "potRenamed") fail("EXPECTED_POT_RENAMED");
    if (args.event.potId !== args.potId) fail("EVENT_POT_MISMATCH");
    const pot = await getPot(ctx, args.potId);
    const name = args.event.payload.name;
    const replaySequence = await existingMembershipEventSequence(
      ctx,
      pot,
      membership.memberId,
      args.event,
    );
    // Return the original receipt without replacing a later rename's projection.
    if (replaySequence !== undefined) return { sequence: replaySequence, name };
    const sequence = await appendMembershipEvent(
      ctx,
      pot,
      membership.memberId,
      args.event,
      account._id,
    );
    await ctx.db.patch(pot._id, { name });
    return { sequence, name };
  },
});

// Owner detaches a wrong claim (J7): the account that claimed this identity loses its
// binding, the identity becomes unclaimed and can be invited again. The append-only log
// keeps the full audit trail of the wrong claim and its reassignment.
export const reassignClaim = mutation({
  args: { potId: v.string(), event: eventInputValidator },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    const membership = await requireActiveMembership(ctx, args.potId, account._id);
    if (membership.role !== "owner") fail("NOT_OWNER");
    if (args.event.payload.kind !== "memberClaimReassigned") {
      fail("EXPECTED_MEMBER_CLAIM_REASSIGNED");
    }
    const memberId = args.event.payload.memberId;
    const pot = await getPot(ctx, args.potId);
    const replaySequence = await existingMembershipEventSequence(
      ctx,
      pot,
      membership.memberId,
      args.event,
    );
    if (replaySequence !== undefined) return { sequence: replaySequence };
    const roster = await loadRoster(ctx, args.potId);
    if (!roster.addedMemberIds.has(memberId)) fail("UNKNOWN_PENDING_MEMBER");
    if (!roster.claimedMemberIds.has(memberId)) fail("MEMBER_NOT_CLAIMED");
    const target = await ctx.db
      .query("potMembers")
      .withIndex("by_pot_member", (index) =>
        index.eq("potId", args.potId).eq("memberId", memberId),
      )
      .unique();
    if (!target) fail("MEMBER_NOT_CLAIMED");
    if (target.role === "owner") fail("CANNOT_REASSIGN_OWNER");
    const sequence = await appendMembershipEvent(
      ctx,
      pot,
      membership.memberId,
      args.event,
      account._id,
    );
    await ctx.db.delete(target._id);
    const profile = await getMemberProfile(ctx, args.potId, memberId);
    await ctx.db.patch(profile._id, {
      state: "pending",
      updatedAt: Date.now(),
    });
    return { sequence };
  },
});

// Owner archives a member (left or removed). The archived membership retains the exact
// final readable sequence so that device can fetch and persist its frozen snapshot. The
// owner cannot archive themselves while owner — ownership must be transferred first —
// so a pot is never left ownerless.
export const archiveMember = mutation({
  args: { potId: v.string(), event: eventInputValidator },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    const membership = await requireActiveMembership(ctx, args.potId, account._id);
    if (membership.role !== "owner") fail("NOT_OWNER");
    if (args.event.payload.kind !== "memberArchived") fail("EXPECTED_MEMBER_ARCHIVED");
    const memberId = args.event.payload.memberId;
    const pot = await getPot(ctx, args.potId);
    const replaySequence = await existingMembershipEventSequence(
      ctx,
      pot,
      membership.memberId,
      args.event,
    );
    if (replaySequence !== undefined) return { sequence: replaySequence };
    const roster = await loadRoster(ctx, args.potId);
    if (!roster.memberIds.has(memberId)) fail("UNKNOWN_MEMBER");
    const target = await ctx.db
      .query("potMembers")
      .withIndex("by_pot_member", (index) =>
        index.eq("potId", args.potId).eq("memberId", memberId),
      )
      .unique();
    if (target) {
      if (target.role === "owner") fail("CANNOT_ARCHIVE_OWNER");
      if (target.status !== "active") fail("MEMBER_ALREADY_ARCHIVED");
    }
    const sequence = await appendMembershipEvent(
      ctx,
      pot,
      membership.memberId,
      args.event,
      account._id,
    );
    if (target) {
      await ctx.db.patch(target._id, {
        status: "archived",
        archivedAtSequence: sequence,
      });
    }
    const profile = await getMemberProfile(ctx, args.potId, memberId);
    await ctx.db.patch(profile._id, {
      state: "archived",
      updatedAt: Date.now(),
    });
    return { sequence };
  },
});

// Any active member may leave voluntarily. If the departing member owns the pot,
// succession and archival are appended in one mutation so no retry can leave the pot
// between owners. The archived membership retains its read boundary and display name;
// account deletion is the separate flow that erases identity.
export const leavePot = mutation({
  args: {
    potId: v.string(),
    archiveEvent: eventInputValidator,
    transferEventId: v.string(),
  },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    validateUUIDv7(args.transferEventId, "LEAVE_EVENT_INVALID");
    const { account } = await requireSession(ctx);
    const membership = await ctx.db
      .query("potMembers")
      .withIndex("by_pot_account", (index) =>
        index.eq("potId", args.potId).eq("accountId", account._id),
      )
      .unique();
    if (!membership) fail("NOT_MEMBER");
    const event = args.archiveEvent;
    if (event.payload.kind !== "memberArchived") fail("EXPECTED_MEMBER_ARCHIVED");
    if (event.payload.memberId !== membership.memberId) fail("TARGET_MEMBER_MISMATCH");
    if (event.actorMemberId !== membership.memberId) fail("ACTOR_MISMATCH");
    const pot = await getPot(ctx, args.potId);

    if (membership.status === "archived") {
      const archiveSequence = await existingMembershipEventSequence(
        ctx,
        pot,
        membership.memberId,
        event,
      );
      if (archiveSequence === undefined
          || archiveSequence !== membership.archivedAtSequence) {
        fail("LEAVE_REPLAY_MISMATCH");
      }
      const preceding = archiveSequence > 1n
        ? await ctx.db.query("events")
          .withIndex("by_pot_sequence", (index) =>
            index.eq("potId", args.potId).eq("sequence", archiveSequence - 1n),
          )
          .unique()
        : null;
      if (preceding?.payload.kind === "ownershipTransferred"
          && preceding.payload.fromMemberId === membership.memberId) {
        if (preceding.eventId !== args.transferEventId) fail("LEAVE_REPLAY_MISMATCH");
        return {
          archiveSequence,
          successorMemberId: preceding.payload.toMemberId,
          transferSequence: preceding.sequence,
        };
      }
      return {
        archiveSequence,
        successorMemberId: null,
        transferSequence: null,
      };
    }

    let successorMemberId: string | null = null;
    let transferSequence: bigint | null = null;
    if (membership.role === "owner") {
      const active = await ctx.db
        .query("potMembers")
        .withIndex("by_pot_account", (index) => index.eq("potId", args.potId))
        .collect();
      const successor = active
        .filter((candidate) =>
          candidate.status === "active" && candidate.accountId !== account._id,
        )
        .sort((left, right) =>
          left.joinedAt - right.joinedAt
            || left.memberId.localeCompare(right.memberId),
        )[0];
      if (!successor) fail("SOLE_ACTIVE_MEMBER");
      const transferEvent: EventInput = {
        eventId: args.transferEventId,
        potId: args.potId,
        actorMemberId: membership.memberId,
        occurredAtMillis: event.occurredAtMillis,
        originatingTimeZone: event.originatingTimeZone,
        schemaVersion: event.schemaVersion,
        payload: {
          kind: "ownershipTransferred",
          fromMemberId: membership.memberId,
          toMemberId: successor.memberId,
        },
        textFields: [],
        authoredText: [],
      };
      transferSequence = await appendMembershipEvent(
        ctx,
        pot,
        membership.memberId,
        transferEvent,
        account._id,
      );
      successorMemberId = successor.memberId;
      await ctx.db.patch(membership._id, { role: "member" });
      await ctx.db.patch(successor._id, { role: "owner" });
      await ctx.db.patch(pot._id, { ownerAccountId: successor.accountId });
      const ownerProfile = await getMemberProfile(ctx, args.potId, membership.memberId);
      const successorProfile = await getMemberProfile(ctx, args.potId, successor.memberId);
      const updatedAt = Date.now();
      await ctx.db.patch(ownerProfile._id, { role: "member", updatedAt });
      await ctx.db.patch(successorProfile._id, { role: "owner", updatedAt });
    }

    const currentPot = transferSequence === null ? pot : await getPot(ctx, args.potId);
    const archiveSequence = await appendMembershipEvent(
      ctx,
      currentPot,
      membership.memberId,
      event,
      account._id,
    );
    await ctx.db.patch(membership._id, {
      role: "member",
      status: "archived",
      archivedAtSequence: archiveSequence,
    });
    const profile = await getMemberProfile(ctx, args.potId, membership.memberId);
    await ctx.db.patch(profile._id, {
      role: "member",
      state: "archived",
      updatedAt: Date.now(),
    });
    return { archiveSequence, successorMemberId, transferSequence };
  },
});

// Owner transfers ownership to another active claimed member. Roles swap and the pot's
// ownerAccountId moves, so exactly one owner remains.
export const transferOwnership = mutation({
  args: { potId: v.string(), event: eventInputValidator },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    const membership = await requireActiveMembership(ctx, args.potId, account._id);
    if (args.event.payload.kind !== "ownershipTransferred") {
      fail("EXPECTED_OWNERSHIP_TRANSFERRED");
    }
    const { fromMemberId, toMemberId } = args.event.payload;
    if (fromMemberId !== membership.memberId) fail("FROM_MEMBER_MISMATCH");
    if (args.event.actorMemberId !== membership.memberId) fail("ACTOR_MISMATCH");
    if (args.event.potId !== args.potId) fail("EVENT_POT_MISMATCH");
    const pot = await getPot(ctx, args.potId);
    const replaySequence = await existingMembershipEventSequence(
      ctx,
      pot,
      membership.memberId,
      args.event,
    );
    if (replaySequence !== undefined) return { sequence: replaySequence };
    if (membership.role !== "owner") fail("NOT_OWNER");
    const target = await ctx.db
      .query("potMembers")
      .withIndex("by_pot_member", (index) =>
        index.eq("potId", args.potId).eq("memberId", toMemberId),
      )
      .unique();
    if (!target || target.status !== "active") fail("TARGET_NOT_ACTIVE_MEMBER");
    if (target.role === "owner") fail("ALREADY_OWNER");
    const sequence = await appendMembershipEvent(
      ctx,
      pot,
      membership.memberId,
      args.event,
      account._id,
    );
    await ctx.db.patch(membership._id, { role: "member" });
    await ctx.db.patch(target._id, { role: "owner" });
    await ctx.db.patch(pot._id, { ownerAccountId: target.accountId });
    const ownerProfile = await getMemberProfile(ctx, args.potId, fromMemberId);
    const targetProfile = await getMemberProfile(ctx, args.potId, toMemberId);
    await ctx.db.patch(ownerProfile._id, {
      role: "member",
      updatedAt: Date.now(),
    });
    await ctx.db.patch(targetProfile._id, {
      role: "owner",
      updatedAt: Date.now(),
    });
    return { sequence };
  },
});

/** Typed accountless bootstrap only. No claims, invites, or arbitrary structural privilege. */
export async function appendPromotedPrerequisite(
  ctx: MutationCtx, pot: Doc<"pots">, membership: Doc<"potMembers">,
  event: EventInput, displayName?: string,
): Promise<bigint> {
  const replay = await existingMembershipEventSequence(ctx, pot, membership.memberId, event);
  if (replay !== undefined) return replay;
  if (membership.role !== "owner") fail("NOT_OWNER");
  if (pot.archivedAtSequence !== undefined) fail("POT_ARCHIVED");
  // Bootstrap prerequisites must precede activation. Later topology has its own typed API.
  if (pot.minimumReaderSchemaVersion !== 1n || event.schemaVersion !== 1n) fail("PROMOTION_CONFLICT");
  await consumeAccountWriteQuota(ctx, {
    accountId: membership.accountId, scope: "event", amount: 1n, limit: eventWriteLimitPerHour,
    windowMillis: 3_600_000, now: Date.now(),
  });
  const topology = await loadBudgetGroupTopology(ctx, pot);
  if (topology.hasFinancialHistory) fail("PROMOTION_CONFLICT");
  if (event.payload.kind === "potRenamed") {
    const sequence = await appendMembershipEvent(ctx, pot, membership.memberId, event, membership.accountId);
    await ctx.db.patch(pot._id, { name: event.payload.name });
    return sequence;
  }
  if (event.payload.kind !== "memberAdded") fail("STRUCTURAL_EVENT_NOT_AVAILABLE");
  const { memberId, unitId, role } = event.payload;
  if (!pot.orderedUnitIds.includes(unitId)) fail("UNKNOWN_UNIT");
  if (topology.members.some((m) => m.memberId === memberId || m.personalUnitId === unitId)) fail("MEMBER_PROFILE_CONFLICT");
  const profile = await ctx.db.query("potMemberProfiles")
    .withIndex("by_pot_member", (q) => q.eq("potId", pot.potId).eq("memberId", memberId)).unique();
  if (role === "owner") {
    if (memberId !== membership.memberId || !profile || profile.unitId !== undefined) fail("NOT_SELF_BINDING");
  } else {
    if (memberId === membership.memberId || profile) fail("MEMBER_PROFILE_CONFLICT");
    if (displayName === undefined) fail("INVALID_MEMBER_DISPLAY_NAME");
    validateDisplayName(displayName);
  }
  const sequence = await appendMembershipEvent(ctx, pot, membership.memberId, event, membership.accountId);
  if (profile) {
    await ctx.db.patch(profile._id, { unitId, updatedAt: Date.now() });
  } else {
    await ctx.db.insert("potMemberProfiles", { potId: pot.potId, memberId, unitId,
      displayName, role: "member", state: "pending", createdAt: Date.now(), updatedAt: Date.now() });
  }
  return sequence;
}

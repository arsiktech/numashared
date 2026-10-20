import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import timeZoneIdentifierParity from "../NumaSharedCore/Tests/NumaSharedCoreTests/Fixtures/time-zone-identifier-parity.json";
import ios18TimeZoneIdentifiersFixture from "../ios/NumaShared/NumaSharedTests/Fixtures/ios18-time-zone-identifiers.json";
import { ios18TimeZoneIdentifiers } from "./lib/ios18TimeZoneIdentifiers";
import { composeBatchMessages } from "./lib/notificationMatrix";
import {
  eventWriteLimitPerHour,
  inviteIssueLimitPerDay,
  potCreateLimitPerDay,
} from "./lib/accountWriteQuota";
import schema from "./schema";
import { modules } from "./test.setup";

const promoteLocalPot = makeFunctionReference<"mutation">("pots:promoteLocalPot");
const appendEvents = makeFunctionReference<"mutation">("events:appendEvents");
const listEvents = makeFunctionReference<"query">("events:listEvents");
const listTextChanges = makeFunctionReference<"query">("events:listTextChanges");
const listMyPots = makeFunctionReference<"query">("pots:listMyPots");
const eraseAuthoredTextForAccount = makeFunctionReference<"mutation">(
  "redaction:eraseAuthoredTextForAccount",
);
const beginAccountDeletion = makeFunctionReference<"mutation">(
  "accountDeletion:begin",
);
const processNextDeletionPot = makeFunctionReference<"mutation">(
  "accountDeletion:processNextPot",
);
const eraseDeletionIdentityBatch = makeFunctionReference<"mutation">(
  "accountDeletion:eraseIdentityBatch",
);
const accountDeletionReceipt = makeFunctionReference<"query">(
  "accountDeletion:receipt",
);
const addPendingMember = makeFunctionReference<"mutation">("members:addPendingMember");
const issueInvite = makeFunctionReference<"mutation">("members:issueInvite");
const listInvites = makeFunctionReference<"query">("members:listInvites");
const claimPerMemberInvite = makeFunctionReference<"mutation">(
  "members:claimPerMemberInvite",
);
const claimPerMemberInviteWithTicket = makeFunctionReference<"mutation">(
  "members:claimPerMemberInviteWithTicket",
);
const claimPotLinkInvite = makeFunctionReference<"mutation">(
  "members:claimPotLinkInvite",
);
const claimPotLinkInviteWithTicket = makeFunctionReference<"mutation">(
  "members:claimPotLinkInviteWithTicket",
);
const revokeInvite = makeFunctionReference<"mutation">("members:revokeInvite");
const approvePotLinkClaim = makeFunctionReference<"mutation">(
  "members:approvePotLinkClaim",
);
const rejectPotLinkClaim = makeFunctionReference<"mutation">(
  "members:rejectPotLinkClaim",
);
const listPendingClaims = makeFunctionReference<"query">("members:listPendingClaims");
const listRoster = makeFunctionReference<"query">("members:listRoster");
const anonymizePendingMember = makeFunctionReference<"mutation">(
  "members:anonymizePendingMember",
);
const archiveMember = makeFunctionReference<"mutation">("members:archiveMember");
const leavePot = makeFunctionReference<"mutation">("members:leavePot");
const transferOwnership = makeFunctionReference<"mutation">("members:transferOwnership");
const reassignClaim = makeFunctionReference<"mutation">("members:reassignClaim");
const registerPushToken = makeFunctionReference<"mutation">(
  "notifications:registerPushToken",
);
const unregisterPushToken = makeFunctionReference<"mutation">(
  "notifications:unregisterPushToken",
);
const getPotMute = makeFunctionReference<"query">("notifications:getPotMute");
const setPotMute = makeFunctionReference<"mutation">("notifications:setPotMute");
const renamePot = makeFunctionReference<"mutation">("members:renamePot");
const bindOwnerUnit = makeFunctionReference<"mutation">("members:bindOwnerUnit");
const bindPendingMember = makeFunctionReference<"mutation">(
  "members:bindPendingMember",
);
const pushTargets = makeFunctionReference<"query">("notifications:pushTargets");
const dropPushToken = makeFunctionReference<"mutation">("notifications:dropPushToken");
const batchPushPlan = makeFunctionReference<"query">("notifications:batchPushPlan");
const flushPendingPush = makeFunctionReference<"mutation">("pushQueue:flushPendingPush");
const deliverEventPush = makeFunctionReference<"action">("apns:deliverEventPush");
const deliverBatchPush = makeFunctionReference<"action">("apns:deliverBatchPush");

function id(value: number): string {
  return `01890f5e-7b00-7000-8000-${value.toString(16).padStart(12, "0")}`;
}

const ids = {
  pot: id(1),
  secondPot: id(2),
  ownerMember: id(3),
  otherMember: id(4),
  payer: id(5),
  beneficiary: id(6),
  thirdUnit: id(7),
  expenseEvent: id(10),
  settlementEvent: id(11),
  restoreEvent: id(12),
  expenseRecord: id(20),
  settlementRecord: id(21),
};

const currency = { code: "EUR", exponent: 2n };
const configuration = {
  potId: ids.pot,
  currency,
  orderedUnitIds: [ids.payer, ids.beneficiary, ids.thirdUnit],
  ownerMemberId: ids.ownerMember,
  minimumReaderSchemaVersion: 1n,
};

function money(minorUnits: bigint) {
  return { minorUnits, currency };
}

function baseEvent(eventId: string, potId = ids.pot) {
  return {
    eventId,
    potId,
    actorMemberId: ids.ownerMember,
    occurredAtMillis: 1_700_000_000_000n + BigInt(parseInt(eventId.slice(-4), 16)),
    originatingTimeZone: "Europe/Madrid",
    schemaVersion: 1n,
  };
}

const expense = {
  ...baseEvent(ids.expenseEvent),
  payload: {
    kind: "expenseAdded" as const,
    recordId: ids.expenseRecord,
    content: {
      expenseKind: "shared" as const,
      amount: money(8_640n),
      payerUnitId: ids.payer,
      allocations: [
        { unitId: ids.payer, amount: money(4_320n) },
        { unitId: ids.beneficiary, amount: money(4_320n) },
      ],
    },
  },
  textFields: ["title", "category"] as const,
  authoredText: [
    { field: "title" as const, value: "Unique secret grocery title" },
    { field: "category" as const, value: "Unique private category" },
  ],
};

const settlement = {
  ...baseEvent(ids.settlementEvent),
  payload: {
    kind: "settlementRecorded" as const,
    recordId: ids.settlementRecord,
    content: {
      amount: money(4_320n),
      fromUnitId: ids.beneficiary,
      toUnitId: ids.payer,
    },
  },
  textFields: ["title"] as const,
  authoredText: [
    { field: "title" as const, value: "Unique private settlement title" },
  ],
};

function textlessEvent(eventId: string, payload: Record<string, unknown>, potId = ids.pot) {
  return {
    ...baseEvent(eventId, potId),
    payload,
    textFields: [],
    authoredText: [],
  };
}

function memberClaimMetadata(event: {
  eventId: string;
  occurredAtMillis: bigint;
  originatingTimeZone: string;
  schemaVersion: bigint;
}) {
  return {
    eventId: event.eventId,
    occurredAtMillis: event.occurredAtMillis,
    originatingTimeZone: event.originatingTimeZone,
    schemaVersion: event.schemaVersion,
  };
}

function expenseRevision(
  eventId: string,
  recordId: string,
  basis:
    | { kind: "parent"; parentEventId: string }
    | { kind: "resolution"; firstEventId: string; secondEventId: string },
  amountMinorUnits: bigint,
) {
  return {
    ...baseEvent(eventId),
    payload: {
      kind: "expenseRevised" as const,
      recordId,
      basis,
      content: {
        kind: "expense" as const,
        expenseKind: "shared" as const,
        amount: money(amountMinorUnits),
        payerUnitId: ids.payer,
        allocations: [
          { unitId: ids.payer, amount: money(amountMinorUnits / 2n) },
          { unitId: ids.beneficiary, amount: money(amountMinorUnits - amountMinorUnits / 2n) },
        ],
      },
    },
    textFields: ["title"] as const,
    authoredText: [
      { field: "title" as const, value: `Expense revision ${eventId}` },
    ],
  };
}

function openingBalanceRoot(eventId: string, recordId: string, potId = ids.pot) {
  return {
    ...baseEvent(eventId, potId),
    payload: {
      kind: "openingBalanceSet" as const,
      recordId,
      content: {
        entries: [
          { unitId: ids.payer, amount: money(5_000n) },
          { unitId: ids.beneficiary, amount: money(-5_000n) },
        ],
      },
    },
    textFields: ["title"] as const,
    authoredText: [
      { field: "title" as const, value: `Opening balance ${eventId}` },
    ],
  };
}

function openingBalanceRevision(
  eventId: string,
  recordId: string,
  parentEventId: string,
) {
  return {
    ...baseEvent(eventId),
    payload: {
      kind: "expenseRevised" as const,
      recordId,
      basis: { kind: "parent" as const, parentEventId },
      content: {
        kind: "openingBalance" as const,
        entries: [
          { unitId: ids.payer, amount: money(4_500n) },
          { unitId: ids.beneficiary, amount: money(-4_500n) },
        ],
      },
    },
    textFields: ["title"] as const,
    authoredText: [
      { field: "title" as const, value: `Opening revision ${eventId}` },
    ],
  };
}

function voidRecord(eventId: string, recordId: string) {
  return {
    ...baseEvent(eventId),
    payload: { kind: "recordVoided" as const, recordId },
    textFields: ["reason"] as const,
    authoredText: [
      { field: "reason" as const, value: `Void reason ${eventId}` },
    ],
  };
}

function expenseRoot(eventId: string, recordId: string, potId = ids.pot) {
  return {
    ...expense,
    ...baseEvent(eventId, potId),
    payload: {
      ...expense.payload,
      recordId,
    },
    authoredText: [
      { field: "title" as const, value: `Expense root ${eventId}` },
      { field: "category" as const, value: "Test category" },
    ],
  };
}

function expenseRootWithAmount(
  eventId: string,
  recordId: string,
  amountMinorUnits: bigint,
  potId = ids.pot,
) {
  const root = expenseRoot(eventId, recordId, potId);
  return {
    ...root,
    payload: {
      ...root.payload,
      content: {
        ...root.payload.content,
        amount: money(amountMinorUnits),
        allocations: [
          { unitId: ids.payer, amount: money(0n) },
          { unitId: ids.beneficiary, amount: money(amountMinorUnits) },
        ],
      },
    },
  };
}

function settlementRootWithAmount(
  eventId: string,
  recordId: string,
  amountMinorUnits: bigint,
  potId = ids.pot,
) {
  return {
    ...settlement,
    ...baseEvent(eventId, potId),
    payload: {
      ...settlement.payload,
      recordId,
      content: {
        ...settlement.payload.content,
        amount: money(amountMinorUnits),
      },
    },
    authoredText: [
      { field: "title" as const, value: `Settlement root ${eventId}` },
    ],
  };
}

function settlementReversal(
  eventId: string,
  recordId: string,
  amountMinorUnits: bigint,
  reversalOfRecordId: string,
  direction: "opposite" | "same" = "opposite",
) {
  return {
    ...settlement,
    ...baseEvent(eventId),
    payload: {
      ...settlement.payload,
      recordId,
      content: {
        ...settlement.payload.content,
        amount: money(amountMinorUnits),
        fromUnitId: direction === "opposite" ? ids.payer : ids.beneficiary,
        toUnitId: direction === "opposite" ? ids.beneficiary : ids.payer,
        reversalOfRecordId,
      },
    },
    authoredText: [
      { field: "title" as const, value: `Settlement reversal ${eventId}` },
    ],
  };
}

function owner(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    issuer: "https://auth.numa.shared",
    subject: "account-owner-000001",
    sid: "session-owner-00000001",
    numa_session_audience: "tech.arsik.numashared",
    token_use: "access",
  });
}

function outsider(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    issuer: "https://auth.numa.shared",
    subject: "account-outsider-001",
    sid: "session-outsider-0001",
    numa_session_audience: "tech.arsik.numashared",
    token_use: "access",
  });
}

function directAppleIdentity(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({
    issuer: "https://appleid.apple.com",
    subject: "apple-owner-subject",
    sid: "session-owner-00000001",
  });
}

async function ensureOwnerSession(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    const existing = await ctx.db
      .query("accounts")
      .filter((query) => query.eq(query.field("publicAccountId"), "account-owner-000001"))
      .unique();
    if (existing) return;
    const accountId = await ctx.db.insert("accounts", {
      publicAccountId: "account-owner-000001",
      appleSubjectHash: "apple-subject-hash-owner",
      createdAt: 1,
    });
    await ctx.db.insert("sessions", {
      sessionId: "session-owner-00000001",
      accountId,
      refreshTokenHash: "refresh-owner-hash",
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      createdAt: 1,
      rotatedAt: 1,
    });
  });
}

async function promote(t: ReturnType<typeof convexTest>) {
  await ensureOwnerSession(t);
  return await owner(t).mutation(promoteLocalPot, {
    ownerDisplayName: "Arseny",
    configuration,
    events: [expense, settlement],
  });
}

async function addOtherMember(
  t: ReturnType<typeof convexTest>,
  status: "active" | "archived" = "active",
) {
  await ensureOutsiderSession(t);
  await t.run(async (ctx) => {
    const account = await ctx.db
      .query("accounts")
      .filter((query) => query.eq(query.field("publicAccountId"), "account-outsider-001"))
      .unique();
    if (!account) throw new Error("missing outsider account");
    await ctx.db.insert("potMembers", {
      potId: ids.pot,
      accountId: account._id,
      memberId: ids.otherMember,
      role: "member",
      status,
      joinedAt: 1,
    });
  });
}

async function ensureOutsiderSession(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    const existing = await ctx.db
      .query("accounts")
      .filter((query) => query.eq(query.field("publicAccountId"), "account-outsider-001"))
      .unique();
    if (existing) return;
    const accountId = await ctx.db.insert("accounts", {
      publicAccountId: "account-outsider-001",
      appleSubjectHash: "apple-subject-hash-outsider",
      createdAt: 1,
    });
    await ctx.db.insert("sessions", {
      sessionId: "session-outsider-0001",
      accountId,
      refreshTokenHash: "refresh-outsider-hash",
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      createdAt: 1,
      rotatedAt: 1,
    });
  });
}

async function setupTwoMemberPushPot(t: ReturnType<typeof convexTest>) {
  await promote(t);
  await owner(t).mutation(bindOwnerUnit, {
    potId: ids.pot,
    event: {
      ...baseEvent(id(2_200)),
      payload: {
        kind: "memberAdded" as const,
        memberId: ids.ownerMember,
        unitId: ids.payer,
        role: "owner" as const,
      },
      textFields: [],
      authoredText: [],
    },
  });
  await owner(t).mutation(renamePot, {
    potId: ids.pot,
    event: {
      ...baseEvent(id(2_201)),
      payload: { kind: "potRenamed" as const, name: "Casa Mar" },
      textFields: [],
      authoredText: [],
    },
  });

  const joiner = id(2_202);
  const joinerUnit = id(2_203);
  await owner(t).mutation(addPendingMember, {
    displayName: "Maya",
    potId: ids.pot,
    event: {
      ...baseEvent(id(2_204)),
      payload: {
        kind: "memberAdded" as const,
        memberId: joiner,
        unitId: joinerUnit,
        role: "member" as const,
      },
      textFields: [],
      authoredText: [],
    },
  });
  const token = "join-push-token-0123456789abcdef0123456789ab";
  await owner(t).mutation(issueInvite, {
    potId: ids.pot,
    inviteId: id(2_205),
    kind: "perMember",
    pendingMemberId: joiner,
    token,
    code: "PUSH01",
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
  await ensureOutsiderSession(t);
  await outsider(t).mutation(claimPerMemberInvite, {
    token,
    event: {
      eventId: id(2_206),
      occurredAtMillis: 1_700_000_900_000n,
      originatingTimeZone: "Europe/Madrid",
      schemaVersion: 1n,
    },
  });
  return { joiner, joinerUnit };
}

async function expectTerminalCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error("Expected mutation to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<{ code: string; retryable: boolean }>).data).toEqual({
      code,
      retryable: false,
    });
  }
}

async function expectRetryableCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error("Expected mutation to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<{ code: string; retryable: boolean }>).data).toEqual({
      code,
      retryable: true,
    });
  }
}

beforeEach(() => {
  vi.stubEnv("NUMA_SHARED_PRODUCT", "numa-shared");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_CLASS", "anonymous-local");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_NAME", "anonymous-agent");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
  vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
  vi.stubEnv(
    "NUMA_SHARED_TOKEN_HASH_SECRET",
    "backend-test-token-hash-secret-at-least-32-bytes",
  );
  vi.stubEnv("NUMA_SHARED_SESSION_ISSUER", "https://auth.numa.shared");
  vi.stubEnv("NUMA_SHARED_SESSION_AUDIENCE", "tech.arsik.numashared");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Backend event and multi-user foundation", () => {
  test("stores per-pot display names outside events and derives roster state", async () => {
    const t = convexTest(schema, modules);
    await ensureOwnerSession(t);
    await owner(t).mutation(promoteLocalPot, {
      ownerDisplayName: "Arseny",
      configuration,
      events: [],
    });
    await owner(t).mutation(bindOwnerUnit, {
      potId: ids.pot,
      event: {
        ...baseEvent(id(1_400)),
        payload: {
          kind: "memberAdded" as const,
          memberId: ids.ownerMember,
          unitId: ids.payer,
          role: "owner" as const,
        },
        textFields: [],
        authoredText: [],
      },
    });
    const pendingMember = id(1_401);
    const pendingUnit = id(1_402);
    await owner(t).mutation(addPendingMember, {
      displayName: "Maya",
      potId: ids.pot,
      event: {
        ...baseEvent(id(1_403)),
        payload: {
          kind: "memberAdded" as const,
          memberId: pendingMember,
          unitId: pendingUnit,
          role: "member" as const,
        },
        textFields: [],
        authoredText: [],
      },
    });

    await expect(owner(t).query(listRoster, { potId: ids.pot })).resolves.toEqual([
      {
        memberId: ids.ownerMember,
        unitId: ids.payer,
        displayName: "Arseny",
        role: "owner",
        state: "active",
      },
      {
        memberId: pendingMember,
        unitId: pendingUnit,
        displayName: "Maya",
        role: "member",
        state: "pending",
      },
    ]);

    const stored = await t.run(async (ctx) => ({
      profiles: await ctx.db.query("potMemberProfiles").collect(),
      events: await ctx.db
        .query("events")
        .withIndex("by_pot_sequence", (index) => index.eq("potId", ids.pot))
        .collect(),
    }));
    expect(stored.profiles.map((profile) => profile.displayName)).toEqual([
      "Arseny",
      "Maya",
    ]);
    const serializedEvents = JSON.stringify(stored.events, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    );
    expect(serializedEvents).not.toContain("Arseny");
    expect(serializedEvents).not.toContain("Maya");

    await owner(t).mutation(anonymizePendingMember, {
      potId: ids.pot,
      memberId: pendingMember,
    });
    await expect(owner(t).query(listRoster, { potId: ids.pot })).resolves.toEqual([
      {
        memberId: ids.ownerMember,
        unitId: ids.payer,
        displayName: "Arseny",
        role: "owner",
        state: "active",
      },
      {
        memberId: pendingMember,
        unitId: pendingUnit,
        displayName: null,
        role: "member",
        state: "pending",
      },
    ]);
  });

  test("validates display names and keeps pending-member retries idempotent", async () => {
    for (const [displayName, code] of [
      ["\u200B", "BLANK_DISPLAY_NAME"],
      ["x".repeat(129), "DISPLAY_NAME_TOO_LONG"],
      ["[redacted]", "RESERVED_REDACTED_TEXT"],
    ] as const) {
      const rejected = convexTest(schema, modules);
      await ensureOwnerSession(rejected);
      await expectTerminalCode(
        owner(rejected).mutation(promoteLocalPot, {
          configuration,
          ownerDisplayName: displayName,
          events: [],
        }),
        code,
      );
      await expect(rejected.run(async (ctx) => ({
        pots: (await ctx.db.query("pots").collect()).length,
        profiles: (await ctx.db.query("potMemberProfiles").collect()).length,
      }))).resolves.toEqual({ pots: 0, profiles: 0 });
    }

    const t = convexTest(schema, modules);
    await promote(t);
    const event = {
      ...baseEvent(id(1_410)),
      payload: {
        kind: "memberAdded" as const,
        memberId: id(1_411),
        unitId: id(1_412),
        role: "member" as const,
      },
      textFields: [],
      authoredText: [],
    };
    const request = { potId: ids.pot, displayName: "Maya", event };
    await expect(owner(t).mutation(addPendingMember, request)).resolves.toEqual({
      sequence: 3n,
    });
    await expect(owner(t).mutation(addPendingMember, request)).resolves.toEqual({
      sequence: 3n,
    });
    await expectTerminalCode(
      owner(t).mutation(addPendingMember, {
        ...request,
        displayName: "Different name",
      }),
      "MEMBER_PROFILE_CONFLICT",
    );
    await expect(t.run(async (ctx) =>
      (await ctx.db
        .query("potMemberProfiles")
        .withIndex("by_pot_member", (index) =>
          index.eq("potId", ids.pot).eq("memberId", event.payload.memberId),
        )
        .collect()).length
    )).resolves.toBe(1);
  });

  test("idempotently binds promoted owner and pending identities to existing units", async () => {
    const t = convexTest(schema, modules);
    await ensureOwnerSession(t);
    await owner(t).mutation(promoteLocalPot, {
      ownerDisplayName: "Arseny",
      configuration,
      events: [],
    });
    const ownerEvent = {
      ...baseEvent(id(1_420)),
      payload: {
        kind: "memberAdded" as const,
        memberId: ids.ownerMember,
        unitId: ids.payer,
        role: "owner" as const,
      },
      textFields: [],
      authoredText: [],
    };
    const pendingEvent = {
      ...baseEvent(id(1_421)),
      payload: {
        kind: "memberAdded" as const,
        memberId: id(1_422),
        unitId: ids.beneficiary,
        role: "member" as const,
      },
      textFields: [],
      authoredText: [],
    };
    const pendingRequest = {
      potId: ids.pot,
      displayName: "Sam",
      event: pendingEvent,
    };

    await expect(owner(t).mutation(bindOwnerUnit, {
      potId: ids.pot,
      event: ownerEvent,
    })).resolves.toEqual({ sequence: 1n });
    await expect(owner(t).mutation(bindOwnerUnit, {
      potId: ids.pot,
      event: ownerEvent,
    })).resolves.toEqual({ sequence: 1n });
    await expect(owner(t).mutation(bindPendingMember, pendingRequest))
      .resolves.toEqual({ sequence: 2n });
    await expect(owner(t).mutation(bindPendingMember, pendingRequest))
      .resolves.toEqual({ sequence: 2n });

    const pot = await t.run(async (ctx) => ctx.db
      .query("pots")
      .withIndex("by_pot_id", (index) => index.eq("potId", ids.pot))
      .unique());
    expect(pot?.orderedUnitIds).toEqual(configuration.orderedUnitIds);
    await expect(owner(t).query(listRoster, { potId: ids.pot })).resolves.toEqual([
      {
        memberId: ids.ownerMember,
        unitId: ids.payer,
        displayName: "Arseny",
        role: "owner",
        state: "active",
      },
      {
        memberId: pendingEvent.payload.memberId,
        unitId: ids.beneficiary,
        displayName: "Sam",
        role: "member",
        state: "pending",
      },
    ]);

    await expectTerminalCode(
      owner(t).mutation(bindPendingMember, {
        ...pendingRequest,
        event: {
          ...pendingEvent,
          eventId: id(1_423),
          payload: {
            ...pendingEvent.payload,
            memberId: id(1_424),
          },
        },
      }),
      "UNIT_ALREADY_BOUND",
    );
  });

  test("promotes atomically and assigns stable exactly-once sequences", async () => {
    const t = convexTest(schema, modules);

    const first = await promote(t);
    expect(first).toEqual({
      potId: ids.pot,
      events: [
        { eventId: ids.expenseEvent, sequence: 1n },
        { eventId: ids.settlementEvent, sequence: 2n },
      ],
    });
    await expect(promote(t)).resolves.toEqual(first);

    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [{
          ...expense,
          payload: {
            ...expense.payload,
            content: {
              ...expense.payload.content,
              amount: money(8_641n),
              allocations: [
                { unitId: ids.payer, amount: money(4_320n) },
                { unitId: ids.beneficiary, amount: money(4_321n) },
              ],
            },
          },
        }],
      }),
      "EVENT_ID_CONFLICT",
    );
    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [{
          ...expense,
          authoredText: [
            { field: "title", value: "Conflicting title" },
            expense.authoredText[1],
          ],
        }],
      }),
      "EVENT_TEXT_CONFLICT",
    );

    const restore = textlessEvent(ids.restoreEvent, {
      kind: "recordRestored",
      recordId: ids.expenseRecord,
    });
    await expect(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [expense, restore],
      }),
    ).resolves.toEqual({
      events: [
        { eventId: ids.expenseEvent, sequence: 1n },
        { eventId: ids.restoreEvent, sequence: 3n },
      ],
    });

    const concurrentA = expenseRoot(id(30), id(130));
    const concurrentB = expenseRoot(id(31), id(131));
    await Promise.all([
      owner(t).mutation(appendEvents, { potId: ids.pot, events: [concurrentA] }),
      owner(t).mutation(appendEvents, { potId: ids.pot, events: [concurrentB] }),
    ]);
    const same = expenseRoot(id(32), id(132));
    const duplicateResults = await Promise.all([
      owner(t).mutation(appendEvents, { potId: ids.pot, events: [same] }),
      owner(t).mutation(appendEvents, { potId: ids.pot, events: [same] }),
    ]);
    expect(duplicateResults[0]).toEqual(duplicateResults[1]);

    const listed = await owner(t).query(listEvents, {
      potId: ids.pot,
      afterSequence: 0n,
    });
    expect(listed.events.map((item: { serverSequence: bigint }) => item.serverSequence)).toEqual([
      1n, 2n, 3n, 4n, 5n, 6n,
    ]);
    expect(await owner(t).query(listMyPots, {})).toMatchObject([
      {
        potId: ids.pot,
        lastSequence: 6n,
        lastTextRevision: 0n,
        role: "owner",
        isArchived: false,
      },
    ]);
  });

  test("drains 500 offline events inside the account-isolated hourly allowance", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    const offlineEvents = Array.from({ length: 500 }, (_, offset) =>
      openingBalanceRoot(id(10_000 + offset), id(20_000 + offset))
    );
    for (let offset = 0; offset < offlineEvents.length; offset += 100) {
      await owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: offlineEvents.slice(offset, offset + 100),
      });
    }
    const page = await owner(t).query(listEvents, {
      potId: ids.pot,
      afterSequence: 2n,
    });
    expect(page.events).toHaveLength(500);
    expect(page.hasMore).toBe(false);
    expect(page.nextAfterSequence).toBe(502n);
  });

  test("write quotas isolate accounts, exempt exact replay, reset, and roll back batches", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    await addOtherMember(t);
    const now = Date.now();
    await t.run(async (ctx) => {
      const ownerAccount = await ctx.db
        .query("accounts")
        .withIndex("by_public_account_id", (index) =>
          index.eq("publicAccountId", "account-owner-000001"),
        )
        .unique();
      if (!ownerAccount) throw new Error("missing owner account");
      const eventQuota = await ctx.db
        .query("accountWriteQuotas")
        .withIndex("by_account_scope", (index) =>
          index.eq("accountId", ownerAccount._id).eq("scope", "event"),
        )
        .unique();
      const potQuota = await ctx.db
        .query("accountWriteQuotas")
        .withIndex("by_account_scope", (index) =>
          index.eq("accountId", ownerAccount._id).eq("scope", "potCreate"),
        )
        .unique();
      if (!eventQuota || !potQuota) throw new Error("missing owner quotas");
      await ctx.db.patch(eventQuota._id, {
        count: eventWriteLimitPerHour,
        expiresAt: now + 60_000,
      });
      await ctx.db.patch(potQuota._id, {
        count: potCreateLimitPerDay,
        expiresAt: now + 60_000,
      });
    });

    await expect(owner(t).mutation(appendEvents, {
      potId: ids.pot,
      events: [expense],
    })).resolves.toEqual({
      events: [{ eventId: ids.expenseEvent, sequence: 1n }],
    });
    const blockedBatch = [
      openingBalanceRoot(id(30_000), id(31_000)),
      openingBalanceRoot(id(30_001), id(31_001)),
    ];
    await expectRetryableCode(
      owner(t).mutation(appendEvents, { potId: ids.pot, events: blockedBatch }),
      "ACCOUNT_WRITE_RATE_LIMITED",
    );
    await expect(owner(t).query(listEvents, {
      potId: ids.pot,
      afterSequence: 0n,
    })).resolves.toMatchObject({ nextAfterSequence: 2n });

    const outsiderEvent = {
      ...openingBalanceRoot(id(30_002), id(31_002)),
      actorMemberId: ids.otherMember,
    };
    await expect(outsider(t).mutation(appendEvents, {
      potId: ids.pot,
      events: [outsiderEvent],
    })).resolves.toEqual({
      events: [{ eventId: outsiderEvent.eventId, sequence: 3n }],
    });

    await expectRetryableCode(
      owner(t).mutation(promoteLocalPot, {
        ownerDisplayName: "Arseny",
        configuration: {
          ...configuration,
          potId: id(40_000),
        },
        events: [],
      }),
      "ACCOUNT_WRITE_RATE_LIMITED",
    );
    await expect(t.run(async (ctx) =>
      await ctx.db
        .query("pots")
        .withIndex("by_pot_id", (index) => index.eq("potId", id(40_000)))
        .unique()
    )).resolves.toBeNull();
    await expect(outsider(t).mutation(promoteLocalPot, {
      ownerDisplayName: "Arseny",
      configuration: {
        ...configuration,
        potId: ids.secondPot,
        ownerMemberId: ids.otherMember,
      },
      events: [],
    })).resolves.toEqual({ potId: ids.secondPot, events: [] });

    await t.run(async (ctx) => {
      const ownerAccount = await ctx.db
        .query("accounts")
        .withIndex("by_public_account_id", (index) =>
          index.eq("publicAccountId", "account-owner-000001"),
        )
        .unique();
      if (!ownerAccount) throw new Error("missing owner account");
      const eventQuota = await ctx.db
        .query("accountWriteQuotas")
        .withIndex("by_account_scope", (index) =>
          index.eq("accountId", ownerAccount._id).eq("scope", "event"),
        )
        .unique();
      if (!eventQuota) throw new Error("missing event quota");
      await ctx.db.patch(eventQuota._id, { expiresAt: now - 1 });
    });
    await expect(owner(t).mutation(appendEvents, {
      potId: ids.pot,
      events: [blockedBatch[0]],
    })).resolves.toEqual({
      events: [{ eventId: blockedBatch[0].eventId, sequence: 4n }],
    });
    await expect(t.run(async (ctx) => {
      const ownerAccount = await ctx.db
        .query("accounts")
        .withIndex("by_public_account_id", (index) =>
          index.eq("publicAccountId", "account-owner-000001"),
        )
        .unique();
      if (!ownerAccount) throw new Error("missing owner account");
      return (await ctx.db
        .query("accountWriteQuotas")
        .withIndex("by_account_scope", (index) =>
          index.eq("accountId", ownerAccount._id).eq("scope", "event"),
        )
        .unique())?.count;
    })).resolves.toBe(1n);
  });

  test("rejects P3 structural event kinds before sequencing", async () => {
    const t = convexTest(schema, modules);
    await ensureOwnerSession(t);
    await owner(t).mutation(promoteLocalPot, {
      ownerDisplayName: "Arseny",
      configuration,
      events: [],
    });
    const structuralEvents = [
      textlessEvent(id(400), {
        kind: "memberAdded",
        memberId: id(600),
        unitId: id(601),
        role: "member",
      }),
      textlessEvent(id(401), { kind: "memberClaimed", memberId: id(600) }),
      textlessEvent(id(402), { kind: "memberClaimReassigned", memberId: id(600) }),
      textlessEvent(id(403), { kind: "memberArchived", memberId: id(600) }),
      textlessEvent(id(404), {
        kind: "ownershipTransferred",
        fromMemberId: ids.ownerMember,
        toMemberId: id(600),
      }),
      textlessEvent(id(405), {
        kind: "groupChanged",
        groups: [{
          groupId: id(610),
          unitId: id(611),
          orderedMemberIds: [ids.ownerMember],
          defaultShareWeight: 1n,
        }],
      }),
      textlessEvent(id(406), {
        kind: "presetChanged",
        name: "Everyone",
        orderedUnitIds: [ids.payer, ids.beneficiary],
      }),
      textlessEvent(id(407), { kind: "potRenamed", name: "Casa final" }),
      textlessEvent(id(408), { kind: "potArchived" }),
    ];

    for (const event of structuralEvents) {
      await expectTerminalCode(
        owner(t).mutation(appendEvents, {
          potId: ids.pot,
          events: [event],
        }),
        "STRUCTURAL_EVENT_NOT_AVAILABLE",
      );
    }
    await expect(owner(t).query(listMyPots, {})).resolves.toMatchObject([
      { potId: ids.pot, lastSequence: 0n, isArchived: false },
    ]);
  });

  test("rolls back every row when a later promotion event is invalid", async () => {
    const t = convexTest(schema, modules);
    await ensureOwnerSession(t);
    const invalid = {
      ...settlement,
      payload: {
        ...settlement.payload,
        content: { ...settlement.payload.content, amount: money(0n) },
      },
    };

    await expectTerminalCode(
      owner(t).mutation(promoteLocalPot, {
        ownerDisplayName: "Arseny",
        configuration,
        events: [expense, invalid],
      }),
      "INVALID_SETTLEMENT_AMOUNT",
    );

    const rows = await t.run(async (ctx) => ({
      accounts: await ctx.db.query("accounts").collect(),
      pots: await ctx.db.query("pots").collect(),
      members: await ctx.db.query("potMembers").collect(),
      events: await ctx.db.query("events").collect(),
      texts: await ctx.db.query("eventTexts").collect(),
      redactions: await ctx.db.query("textRedactions").collect(),
    }));
    expect(rows.pots).toEqual([]);
    expect(rows.members).toEqual([]);
    expect(rows.events).toEqual([]);
    expect(rows.texts).toEqual([]);
    expect(rows.redactions).toEqual([]);
    expect(rows.accounts).toHaveLength(1);
  });

  test("matches Core time-zone admission and rolls back invalid promotion", async () => {
    expect(Array.from(ios18TimeZoneIdentifiers).sort()).toEqual(
      ios18TimeZoneIdentifiersFixture,
    );

    for (const [index, parityCase] of timeZoneIdentifierParity.entries()) {
      const t = convexTest(schema, modules);
      await ensureOwnerSession(t);
      const potId = id(8_000 + index);
      const root = {
        ...expenseRoot(id(8_100 + index), id(8_200 + index), potId),
        originatingTimeZone: parityCase.value,
      };
      const promotion = owner(t).mutation(promoteLocalPot, {
        ownerDisplayName: "Arseny",
        configuration: { ...configuration, potId },
        events: [root],
      });

      if (parityCase.isValid) {
        await expect(promotion, parityCase.name).resolves.toEqual({
          potId,
          events: [{ eventId: root.eventId, sequence: 1n }],
        });
      } else {
        await expectTerminalCode(promotion, "INVALID_TIME_ZONE");
      }

      const rows = await t.run(async (ctx) => ({
        pots: await ctx.db.query("pots").collect(),
        members: await ctx.db.query("potMembers").collect(),
        events: await ctx.db.query("events").collect(),
        texts: await ctx.db.query("eventTexts").collect(),
      }));
      if (parityCase.isValid) {
        expect(rows.pots, parityCase.name).toHaveLength(1);
        expect(rows.members, parityCase.name).toHaveLength(1);
        expect(rows.events, parityCase.name).toHaveLength(1);
        expect(rows.texts, parityCase.name).toHaveLength(2);
      } else {
        expect(rows, parityCase.name).toEqual({
          pots: [],
          members: [],
          events: [],
          texts: [],
        });
      }
    }
  });

  test("rejects Foundation-blank required text atomically before sequencing", async () => {
    const cases = [
      {
        name: "title",
        code: "BLANK_TITLE",
        events: [{
          ...expense,
          authoredText: [
            { field: "title" as const, value: "\u0085" },
            expense.authoredText[1],
          ],
        }],
      },
      {
        name: "reason",
        code: "BLANK_REASON",
        events: [
          expense,
          {
            ...voidRecord(id(30), ids.expenseRecord),
            authoredText: [{ field: "reason" as const, value: "\u0085" }],
          },
        ],
      },
    ];

    for (const testCase of cases) {
      const t = convexTest(schema, modules);
      await ensureOwnerSession(t);
      await expectTerminalCode(
        owner(t).mutation(promoteLocalPot, {
          ownerDisplayName: "Arseny",
          configuration,
          events: testCase.events,
        }),
        testCase.code,
      );

      const rows = await t.run(async (ctx) => ({
        pots: await ctx.db.query("pots").collect(),
        members: await ctx.db.query("potMembers").collect(),
        events: await ctx.db.query("events").collect(),
        texts: await ctx.db.query("eventTexts").collect(),
        redactions: await ctx.db.query("textRedactions").collect(),
      }));
      expect(rows, testCase.name).toEqual({
        pots: [],
        members: [],
        events: [],
        texts: [],
        redactions: [],
      });
    }
  });

  test("admits explicitly grandfathered P1 text and returns its compatibility marker", async () => {
    const t = convexTest(schema, modules);
    await ensureOwnerSession(t);
    const legacy = {
      ...expense,
      authoredText: [
        { field: "title" as const, value: " \n" },
        { field: "category" as const, value: "[redacted]" },
      ],
    };
    await expect(owner(t).mutation(promoteLocalPot, {
      ownerDisplayName: "Arseny",
      configuration,
      events: [legacy],
      legacyMigrationEventIds: [legacy.eventId],
    })).resolves.toEqual({
      potId: ids.pot,
      events: [{ eventId: ids.expenseEvent, sequence: 1n }],
    });
    const page = await owner(t).query(listEvents, {
      potId: ids.pot,
      afterSequence: 0n,
    });
    expect(page.events[0].event.legacyAuthoredText).toBe(true);
    expect(page.events[0].textStates).toEqual([
      { field: "title", state: "present", value: " \n" },
      { field: "category", state: "present", value: "[redacted]" },
    ]);

    await expectTerminalCode(
      owner(t).mutation(promoteLocalPot, {
        ownerDisplayName: "Arseny",
        configuration,
        events: [{ ...legacy, eventId: id(406) }],
        legacyMigrationEventIds: [id(406)],
      }),
      "LEGACY_MIGRATION_NOT_AVAILABLE",
    );
  });

  test("idempotently converges a legacy promotion whose response was lost", async () => {
    const t = convexTest(schema, modules);
    await ensureOwnerSession(t);
    const legacy = {
      ...expense,
      authoredText: [
        { field: "title" as const, value: " \n" },
        { field: "category" as const, value: "[redacted]" },
      ],
    };
    const promotion = {
      ownerDisplayName: "Arseny",
      configuration,
      events: [legacy],
      legacyMigrationEventIds: [legacy.eventId],
    };
    // First promotion commits the pot plus the legacy event at sequence 1.
    await expect(owner(t).mutation(promoteLocalPot, promotion)).resolves.toEqual({
      potId: ids.pot,
      events: [{ eventId: ids.expenseEvent, sequence: 1n }],
    });
    // The client never saw the response and retries the identical promotion. It must
    // return the same sequence rather than fail, and must not wedge the pot.
    await expect(owner(t).mutation(promoteLocalPot, promotion)).resolves.toEqual({
      potId: ids.pot,
      events: [{ eventId: ids.expenseEvent, sequence: 1n }],
    });
    const rows = await t.run(async (ctx) => ({
      pots: await ctx.db.query("pots").collect(),
      events: await ctx.db.query("events").collect(),
      texts: await ctx.db.query("eventTexts").collect(),
    }));
    expect(rows.pots).toHaveLength(1);
    expect(rows.events).toHaveLength(1);
    expect(rows.events[0].sequence).toBe(1n);
    expect(rows.events[0].legacyAuthoredText).toBe(true);
    // The grandfathered sidecar text is preserved exactly once.
    expect(
      rows.texts
        .map((row) => ({ field: row.field, value: row.value }))
        .sort((left, right) => left.field.localeCompare(right.field)),
    ).toEqual([
      { field: "category", value: "[redacted]" },
      { field: "title", value: " \n" },
    ]);
  });

  test("bars a legacy retry against a pot created without legacy migration", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    // The pot exists but was created without legacy migration, so a legacy-flagged
    // retry naming an already-stored event must terminalize, not idempotently pass.
    await expectTerminalCode(
      owner(t).mutation(promoteLocalPot, {
        ownerDisplayName: "Arseny",
        configuration,
        events: [expense, settlement],
        legacyMigrationEventIds: [expense.eventId],
      }),
      "LEGACY_MIGRATION_NOT_AVAILABLE",
    );
  });

  test("per-member invite: owner adds a pending member, an outsider claims and can append", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    const newMember = id(1_501);
    const newUnit = id(1_502);
    await owner(t).mutation(addPendingMember, {
      displayName: "Maya",
      potId: ids.pot,
      event: {
        ...baseEvent(id(1_500)),
        payload: {
          kind: "memberAdded" as const,
          memberId: newMember,
          unitId: newUnit,
          role: "member" as const,
        },
        textFields: [],
        authoredText: [],
      },
    });

    const rawToken = "invite-token-0123456789abcdef0123456789abcdef";
    await owner(t).mutation(issueInvite, {
      potId: ids.pot,
      inviteId: id(1_503),
      kind: "perMember",
      pendingMemberId: newMember,
      token: rawToken,
      code: "JOIN42",
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    await ensureOutsiderSession(t);
    const memberClaimed = {
      eventId: id(1_504),
      potId: ids.pot,
      actorMemberId: newMember,
      occurredAtMillis: 1_700_000_100_000n,
      originatingTimeZone: "Europe/Madrid",
      schemaVersion: 1n,
      payload: { kind: "memberClaimed" as const, memberId: newMember },
      textFields: [],
      authoredText: [],
    };
    const claim = await outsider(t).mutation(claimPerMemberInvite, {
      token: rawToken,
      event: memberClaimMetadata(memberClaimed),
    });
    expect(claim.memberId).toBe(newMember);
    await expect(outsider(t).mutation(claimPerMemberInvite, {
      token: rawToken,
      event: memberClaimMetadata(memberClaimed),
    })).resolves.toEqual(claim);

    // The new account is now an active member and can append a shared expense.
    const appended = await outsider(t).mutation(appendEvents, {
      potId: ids.pot,
      events: [
        {
          eventId: id(1_505),
          potId: ids.pot,
          actorMemberId: newMember,
          occurredAtMillis: 1_700_000_200_000n,
          originatingTimeZone: "Europe/Madrid",
          schemaVersion: 1n,
          payload: {
            kind: "expenseAdded" as const,
            recordId: id(1_506),
            content: {
              expenseKind: "shared" as const,
              amount: money(2_000n),
              payerUnitId: newUnit,
              allocations: [
                { unitId: newUnit, amount: money(1_000n) },
                { unitId: ids.payer, amount: money(1_000n) },
              ],
            },
          },
          textFields: ["title"],
          authoredText: [{ field: "title" as const, value: "First shared expense" }],
        },
      ],
    });
    expect(appended.events[0].eventId).toBe(id(1_505));
    const pots = await outsider(t).query(listMyPots, {});
    expect(pots.map((pot: { potId: string }) => pot.potId)).toContain(ids.pot);

    // The per-member invite is single-claim: a second claim is rejected.
    await expectTerminalCode(
      outsider(t).mutation(claimPerMemberInvite, {
        token: rawToken,
        event: memberClaimMetadata({ ...memberClaimed, eventId: id(1_507) }),
      }),
      "INVITE_INVALID",
    );
  });

  test("typed code produces a ticket that claims once and never exposes history first", async () => {
    const ticketNow = 1_750_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(ticketNow);
    const t = convexTest(schema, modules);
    await promote(t);
    const newMember = id(1_551);
    const newUnit = id(1_552);
    await owner(t).mutation(addPendingMember, {
      displayName: "Maya",
      potId: ids.pot,
      event: {
        ...baseEvent(id(1_550)),
        payload: {
          kind: "memberAdded" as const,
          memberId: newMember,
          unitId: newUnit,
          role: "member" as const,
        },
        textFields: [],
        authoredText: [],
      },
    });
    await owner(t).mutation(issueInvite, {
      potId: ids.pot,
      inviteId: id(1_553),
      kind: "perMember",
      pendingMemberId: newMember,
      token: "typed-code-token-0123456789abcdef0123456789ab",
      code: "CODE01",
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    await expectTerminalCode(
      owner(t).mutation(issueInvite, {
        potId: ids.pot,
        inviteId: id(1_556),
        kind: "perMember",
        pendingMemberId: newMember,
        token: "sibling-code-token-0123456789abcdef0123456789",
        code: "CODE02",
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      }),
      "INVITE_PENDING_MEMBER_ALREADY_ACTIVE",
    );

    const response = await t.fetch("/join/code-01", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "x-numa-shared-test-source": "typed-code-claim",
      },
    });
    expect(response.status).toBe(200);
    const preview = await response.json() as { status: string; claimTicket: string };
    expect(preview.status).toBe("active");
    expect(preview.claimTicket).toBeTruthy();

    await ensureOutsiderSession(t);
    await expectTerminalCode(
      outsider(t).query(listEvents, { potId: ids.pot, afterSequence: 0n }),
      "NOT_MEMBER",
    );
    const event = {
      eventId: id(1_554),
      potId: ids.pot,
      actorMemberId: newMember,
      occurredAtMillis: 1_700_000_150_000n,
      originatingTimeZone: "Europe/Madrid",
      schemaVersion: 1n,
      payload: { kind: "memberClaimed" as const, memberId: newMember },
      textFields: [],
      authoredText: [],
    };
    const claim = await outsider(t).mutation(claimPerMemberInviteWithTicket, {
      ticket: preview.claimTicket,
      event: memberClaimMetadata(event),
    });
    expect(claim).toMatchObject({ memberId: newMember });
    await expect(outsider(t).mutation(claimPerMemberInviteWithTicket, {
      ticket: preview.claimTicket,
      event: memberClaimMetadata(event),
    })).resolves.toEqual(claim);
    vi.setSystemTime(ticketNow + 10 * 60_000);
    await expect(outsider(t).mutation(claimPerMemberInviteWithTicket, {
      ticket: preview.claimTicket,
      event: memberClaimMetadata(event),
    })).resolves.toEqual(claim);
    await expectTerminalCode(
      outsider(t).mutation(claimPerMemberInviteWithTicket, {
        ticket: preview.claimTicket,
        event: memberClaimMetadata({ ...event, eventId: id(1_555) }),
      }),
      "INVITE_INVALID",
    );
    await expect((await t.fetch("/join/CODE01", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "x-numa-shared-test-source": "typed-code-after-claim",
      },
    })).json()).resolves.toEqual({ status: "used" });
  });

  test("invite codes and tokens are canonical, unique, and owner-revocable", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    await expectTerminalCode(
      owner(t).mutation(issueInvite, {
        potId: ids.pot,
        inviteId: "short",
        kind: "potLink",
        token: "invalid-id-token-0123456789abcdef0123456789ab",
        code: "BADID1",
        expiresAt: Date.now() + 86_400_000,
      }),
      "INVITE_ID_INVALID",
    );
    await expectTerminalCode(
      owner(t).mutation(issueInvite, {
        potId: ids.pot,
        inviteId: id(1_560),
        kind: "potLink",
        token: "lower-code-token-0123456789abcdef0123456789ab",
        code: "lower1",
        expiresAt: Date.now() + 86_400_000,
      }),
      "INVITE_CODE_INVALID",
    );

    const token = "revocable-token-0123456789abcdef0123456789abcdef";
    const expiresAt = Date.now() + 86_400_000;
    const issued = await owner(t).mutation(issueInvite, {
      potId: ids.pot,
      inviteId: id(1_561),
      kind: "potLink",
      token,
      code: "REVOK1",
      expiresAt,
    });
    await expect(owner(t).mutation(issueInvite, {
      potId: ids.pot,
      inviteId: id(1_561),
      kind: "potLink",
      token,
      code: "REVOK1",
      expiresAt,
    })).resolves.toEqual(issued);
    await expect(owner(t).query(listInvites, {
      potId: ids.pot,
    })).resolves.toEqual([{
      inviteId: id(1_561),
      kind: "potLink",
      expiresAt,
      createdAt: expect.any(Number),
    }]);
    await expectTerminalCode(
      owner(t).mutation(issueInvite, {
        potId: ids.pot,
        inviteId: id(1_562),
        kind: "potLink",
        token: "unique-token-0123456789abcdef0123456789abcdef",
        code: "REVOK1",
        expiresAt: Date.now() + 86_400_000,
      }),
      "INVITE_CODE_UNAVAILABLE",
    );
    await expectTerminalCode(
      owner(t).mutation(issueInvite, {
        potId: ids.pot,
        inviteId: id(1_563),
        kind: "potLink",
        token,
        code: "UNIQ01",
        expiresAt: Date.now() + 86_400_000,
      }),
      "INVITE_SECRET_ALREADY_USED",
    );

    await ensureOutsiderSession(t);
    await expectTerminalCode(
      outsider(t).query(listInvites, { potId: ids.pot }),
      "NOT_MEMBER",
    );
    await expectTerminalCode(
      outsider(t).mutation(revokeInvite, { potId: ids.pot, inviteId: id(1_561) }),
      "NOT_MEMBER",
    );
    await expect(owner(t).mutation(revokeInvite, {
      potId: ids.pot,
      inviteId: id(1_561),
    })).resolves.toEqual({ status: "revoked" });
    await expect(owner(t).query(listInvites, {
      potId: ids.pot,
    })).resolves.toEqual([]);
    await expect(owner(t).mutation(revokeInvite, {
      potId: ids.pot,
      inviteId: id(1_561),
    })).resolves.toEqual({ status: "revoked" });
    await expectTerminalCode(
      outsider(t).mutation(claimPotLinkInvite, { token }),
      "INVITE_INVALID",
    );
    await expect((await t.fetch("/join/REVOK1", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "x-numa-shared-test-source": "revoked-preview",
      },
    })).json()).resolves.toEqual({ status: "revoked" });
  });

  test("a typed pot-link ticket creates only a pending owner-approved claim", async () => {
    const ticketNow = 1_750_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(ticketNow);
    const t = convexTest(schema, modules);
    await promote(t);
    await owner(t).mutation(issueInvite, {
      potId: ids.pot,
      inviteId: id(1_570),
      kind: "potLink",
      token: "typed-potlink-token-0123456789abcdef0123456789",
      code: "POT123",
      expiresAt: Date.now() + 86_400_000,
    });
    const response = await t.fetch("/join/POT123", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "x-numa-shared-test-source": "typed-potlink",
      },
    });
    const preview = await response.json() as { claimTicket: string };
    await ensureOutsiderSession(t);
    await expect(outsider(t).mutation(claimPotLinkInviteWithTicket, {
      ticket: preview.claimTicket,
    })).resolves.toEqual({ status: "pending" });
    vi.setSystemTime(ticketNow + 10 * 60_000);
    await expect(outsider(t).mutation(claimPotLinkInviteWithTicket, {
      ticket: preview.claimTicket,
    })).resolves.toEqual({ status: "pending" });
    await expect(outsider(t).mutation(claimPotLinkInviteWithTicket, {
      ticket: preview.claimTicket,
    })).resolves.toEqual({ status: "pending" });
    await expectTerminalCode(
      outsider(t).query(listEvents, { potId: ids.pot, afterSequence: 0n }),
      "NOT_MEMBER",
    );
    const pending = await owner(t).query(listPendingClaims, { potId: ids.pot });
    expect(pending).toHaveLength(1);
    await owner(t).mutation(rejectPotLinkClaim, { claimId: pending[0].claimId });
    await expectTerminalCode(
      outsider(t).mutation(claimPotLinkInviteWithTicket, {
        ticket: preview.claimTicket,
      }),
      "INVITE_INVALID",
    );
    expect(await owner(t).query(listPendingClaims, { potId: ids.pot }))
      .toHaveLength(0);
  });

  test("rate-limits successful invite issuance per account", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    await t.run(async (ctx) => {
      const account = await ctx.db
        .query("accounts")
        .withIndex("by_public_account_id", (index) =>
          index.eq("publicAccountId", "account-owner-000001"),
        )
        .unique();
      if (!account) throw new Error("missing owner account");
      await ctx.db.insert("accountWriteQuotas", {
        accountId: account._id,
        scope: "inviteIssue",
        windowStartedAt: Date.now(),
        count: inviteIssueLimitPerDay,
        expiresAt: Date.now() + 86_400_000,
      });
    });
    await expectRetryableCode(
      owner(t).mutation(issueInvite, {
        potId: ids.pot,
        inviteId: id(1_580),
        kind: "potLink",
        token: "rate-limited-invite-token-0123456789abcdef012345",
        code: "RATE01",
        expiresAt: Date.now() + 86_400_000,
      }),
      "ACCOUNT_WRITE_RATE_LIMITED",
    );
  });

  test("bars adding a pending member by a non-owner and reusing an existing unit", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    // A non-owner cannot add members.
    await ensureOutsiderSession(t);
    await expectTerminalCode(
      outsider(t).mutation(addPendingMember, {
        displayName: "Maya",
        potId: ids.pot,
        event: {
          ...baseEvent(id(1_600)),
          actorMemberId: ids.otherMember,
          payload: {
            kind: "memberAdded" as const,
            memberId: id(1_601),
            unitId: id(1_602),
            role: "member" as const,
          },
          textFields: [],
          authoredText: [],
        },
      }),
      "NOT_MEMBER",
    );
    // The owner cannot reuse an existing unit id for a new member.
    await expectTerminalCode(
      owner(t).mutation(addPendingMember, {
        displayName: "Maya",
        potId: ids.pot,
        event: {
          ...baseEvent(id(1_603)),
          payload: {
            kind: "memberAdded" as const,
            memberId: id(1_604),
            unitId: ids.payer,
            role: "member" as const,
          },
          textFields: [],
          authoredText: [],
        },
      }),
      "UNIT_ALREADY_EXISTS",
    );
  });

  test("pot-link invite: a claim is gated with no access until the owner approves", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    const leoMember = id(1_701);
    const leoUnit = id(1_702);
    await owner(t).mutation(addPendingMember, {
      displayName: "Maya",
      potId: ids.pot,
      event: {
        ...baseEvent(id(1_700)),
        payload: {
          kind: "memberAdded" as const,
          memberId: leoMember,
          unitId: leoUnit,
          role: "member" as const,
        },
        textFields: [],
        authoredText: [],
      },
    });
    const rawToken = "potlink-token-0123456789abcdef0123456789abcdef";
    await owner(t).mutation(issueInvite, {
      potId: ids.pot,
      inviteId: id(1_703),
      kind: "potLink",
      token: rawToken,
      code: "POTLNK",
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    // A joiner claims "I'm Leo": pending only, and crucially NO read access yet.
    await ensureOutsiderSession(t);
    const claimResult = await outsider(t).mutation(claimPotLinkInvite, {
      token: rawToken,
      chosenMemberId: leoMember,
    });
    expect(claimResult.status).toBe("pending");
    await expect(outsider(t).mutation(claimPotLinkInvite, {
      token: rawToken,
      chosenMemberId: leoMember,
    })).resolves.toEqual(claimResult);
    await expectTerminalCode(
      outsider(t).query(listEvents, { potId: ids.pot, afterSequence: 0n }),
      "NOT_MEMBER",
    );

    // Owner sees the pending claim and approves it.
    const pending = await owner(t).query(listPendingClaims, { potId: ids.pot });
    expect(pending.length).toBe(1);
    expect(pending[0].chosenMemberId).toBe(leoMember);
    const approvalEvent = {
      eventId: id(1_704),
      potId: ids.pot,
      actorMemberId: leoMember,
      occurredAtMillis: 1_700_000_300_000n,
      originatingTimeZone: "Europe/Madrid",
      schemaVersion: 1n,
      payload: { kind: "memberClaimed" as const, memberId: leoMember },
      textFields: [],
      authoredText: [],
    };
    const approvalResult = await owner(t).mutation(approvePotLinkClaim, {
      claimId: pending[0].claimId,
      memberId: leoMember,
      event: approvalEvent,
    });
    await expect(owner(t).mutation(approvePotLinkClaim, {
      claimId: pending[0].claimId,
      memberId: leoMember,
      event: approvalEvent,
    })).resolves.toEqual(approvalResult);

    // Now the claimant is a member and history is visible; the claim leaves the queue.
    const page = await outsider(t).query(listEvents, {
      potId: ids.pot,
      afterSequence: 0n,
    });
    expect(page.events.length).toBeGreaterThan(0);
    const afterApprove = await owner(t).query(listPendingClaims, { potId: ids.pot });
    expect(afterApprove.length).toBe(0);
  });

  test("pot-link claim: owner can reject; a non-owner cannot decide", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    const rawToken = "potlink-reject-0123456789abcdef0123456789abcdef";
    await owner(t).mutation(issueInvite, {
      potId: ids.pot,
      inviteId: id(1_800),
      kind: "potLink",
      token: rawToken,
      code: "REJ777",
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    // "I'm new here": a claim with no chosen identity.
    await ensureOutsiderSession(t);
    await outsider(t).mutation(claimPotLinkInvite, { token: rawToken });
    const pending = await owner(t).query(listPendingClaims, { potId: ids.pot });
    expect(pending.length).toBe(1);
    // The claimant (a non-member) cannot reject their own claim.
    await expectTerminalCode(
      outsider(t).mutation(rejectPotLinkClaim, { claimId: pending[0].claimId }),
      "NOT_MEMBER",
    );
    const rejection = await owner(t).mutation(rejectPotLinkClaim, {
      claimId: pending[0].claimId,
    });
    await expect(owner(t).mutation(rejectPotLinkClaim, {
      claimId: pending[0].claimId,
    })).resolves.toEqual(rejection);
    const after = await owner(t).query(listPendingClaims, { potId: ids.pot });
    expect(after.length).toBe(0);
  });

  test("ownership transfer then archival move roles and access", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    const member2 = id(1_901);
    const unit2 = id(1_902);
    await owner(t).mutation(addPendingMember, {
      displayName: "Maya",
      potId: ids.pot,
      event: {
        ...baseEvent(id(1_900)),
        payload: {
          kind: "memberAdded" as const,
          memberId: member2,
          unitId: unit2,
          role: "member" as const,
        },
        textFields: [],
        authoredText: [],
      },
    });
    const token = "owner-xfer-token-0123456789abcdef0123456789ab";
    await owner(t).mutation(issueInvite, {
      potId: ids.pot,
      inviteId: id(1_903),
      kind: "perMember",
      pendingMemberId: member2,
      token,
      code: "XFER01",
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    await ensureOutsiderSession(t);
    await outsider(t).mutation(claimPerMemberInvite, {
      token,
      event: {
        eventId: id(1_904),
        occurredAtMillis: 1_700_000_400_000n,
        originatingTimeZone: "Europe/Madrid",
        schemaVersion: 1n,
      },
    });

    // Owner transfers ownership to the newly-joined member.
    const transferEvent = {
      eventId: id(1_905),
      potId: ids.pot,
      actorMemberId: ids.ownerMember,
      occurredAtMillis: 1_700_000_500_000n,
      originatingTimeZone: "Europe/Madrid",
      schemaVersion: 1n,
      payload: {
        kind: "ownershipTransferred" as const,
        fromMemberId: ids.ownerMember,
        toMemberId: member2,
      },
      textFields: [],
      authoredText: [],
    };
    const transferResult = await owner(t).mutation(transferOwnership, {
      potId: ids.pot,
      event: transferEvent,
    });
    await expect(owner(t).mutation(transferOwnership, {
      potId: ids.pot,
      event: transferEvent,
    })).resolves.toEqual(transferResult);

    // The original owner is now a plain member and cannot add members.
    await expectTerminalCode(
      owner(t).mutation(addPendingMember, {
        displayName: "Maya",
        potId: ids.pot,
        event: {
          ...baseEvent(id(1_906)),
          payload: {
            kind: "memberAdded" as const,
            memberId: id(1_907),
            unitId: id(1_908),
            role: "member" as const,
          },
          textFields: [],
          authoredText: [],
        },
      }),
      "NOT_OWNER",
    );

    // The new owner archives the former owner; the former owner can read exactly through
    // the archival event so its device can persist a frozen exportable snapshot.
    const archiveEvent = {
      eventId: id(1_909),
      potId: ids.pot,
      actorMemberId: member2,
      occurredAtMillis: 1_700_000_600_000n,
      originatingTimeZone: "Europe/Madrid",
      schemaVersion: 1n,
      payload: { kind: "memberArchived" as const, memberId: ids.ownerMember },
      textFields: [],
      authoredText: [],
    };
    const archiveResult = await outsider(t).mutation(archiveMember, {
      potId: ids.pot,
      event: archiveEvent,
    });
    await expect(outsider(t).mutation(archiveMember, {
      potId: ids.pot,
      event: archiveEvent,
    })).resolves.toEqual(archiveResult);
    const frozen = await owner(t).query(listEvents, {
      potId: ids.pot,
      afterSequence: 0n,
    });
    expect(frozen.events.at(-1)?.event.payload).toEqual({
      kind: "memberArchived",
      memberId: ids.ownerMember,
    });
    expect(frozen.nextAfterSequence).toBe(archiveResult.sequence);
    await outsider(t).mutation(renamePot, {
      potId: ids.pot,
      event: {
        ...baseEvent(id(1_910)),
        actorMemberId: member2,
        payload: { kind: "potRenamed" as const, name: "After removal" },
        textFields: [],
        authoredText: [],
      },
    });
    await expect(owner(t).query(listEvents, {
      potId: ids.pot,
      afterSequence: archiveResult.sequence,
    })).resolves.toMatchObject({ events: [], hasMore: false });
    const page = await outsider(t).query(listEvents, {
      potId: ids.pot,
      afterSequence: 0n,
    });
    expect(page.events.length).toBeGreaterThan(0);
  });

  test("a member can leave and retain a frozen readable snapshot", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    await addOtherMember(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("potMemberProfiles", {
        potId: ids.pot,
        memberId: ids.otherMember,
        unitId: ids.thirdUnit,
        displayName: "Maya",
        role: "member",
        state: "active",
        createdAt: 2,
        updatedAt: 2,
      });
    });
    const archiveEvent = {
      ...baseEvent(id(1_920)),
      actorMemberId: ids.otherMember,
      payload: { kind: "memberArchived" as const, memberId: ids.otherMember },
      textFields: [],
      authoredText: [],
    };
    const request = {
      potId: ids.pot,
      archiveEvent,
      transferEventId: id(1_921),
    };
    const result = await outsider(t).mutation(leavePot, request);
    expect(result).toEqual({
      archiveSequence: 3n,
      successorMemberId: null,
      transferSequence: null,
    });
    await expect(outsider(t).mutation(leavePot, request)).resolves.toEqual(result);
    const frozen = await outsider(t).query(listEvents, {
      potId: ids.pot,
      afterSequence: 0n,
    });
    expect(frozen.nextAfterSequence).toBe(result.archiveSequence);
    expect(frozen.events.at(-1)?.event.payload).toEqual({
      kind: "memberArchived",
      memberId: ids.otherMember,
    });
  });

  test("owner leave atomically succeeds to the longest-standing active member", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    await addOtherMember(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("potMemberProfiles", {
        potId: ids.pot,
        memberId: ids.otherMember,
        unitId: ids.thirdUnit,
        displayName: "Maya",
        role: "member",
        state: "active",
        createdAt: 2,
        updatedAt: 2,
      });
    });
    const archiveEvent = {
      ...baseEvent(id(1_930)),
      payload: { kind: "memberArchived" as const, memberId: ids.ownerMember },
      textFields: [],
      authoredText: [],
    };
    const request = {
      potId: ids.pot,
      archiveEvent,
      transferEventId: id(1_931),
    };
    const result = await owner(t).mutation(leavePot, request);
    expect(result).toEqual({
      archiveSequence: 4n,
      successorMemberId: ids.otherMember,
      transferSequence: 3n,
    });
    await expect(owner(t).mutation(leavePot, request)).resolves.toEqual(result);
    const state = await t.run(async (ctx) => ({
      pot: await ctx.db.query("pots")
        .withIndex("by_pot_id", (index) => index.eq("potId", ids.pot)).unique(),
      former: await ctx.db.query("potMembers")
        .withIndex("by_pot_member", (index) =>
          index.eq("potId", ids.pot).eq("memberId", ids.ownerMember),
        ).unique(),
      successor: await ctx.db.query("potMembers")
        .withIndex("by_pot_member", (index) =>
          index.eq("potId", ids.pot).eq("memberId", ids.otherMember),
        ).unique(),
      formerProfile: await ctx.db.query("potMemberProfiles")
        .withIndex("by_pot_member", (index) =>
          index.eq("potId", ids.pot).eq("memberId", ids.ownerMember),
        ).unique(),
      events: await ctx.db.query("events")
        .withIndex("by_pot_sequence", (index) => index.eq("potId", ids.pot)).collect(),
    }));
    expect(state.pot?.ownerAccountId).toBe(state.successor?.accountId);
    expect(state.former).toMatchObject({
      role: "member",
      status: "archived",
      archivedAtSequence: 4n,
    });
    expect(state.successor?.role).toBe("owner");
    expect(state.formerProfile).toMatchObject({
      displayName: "Arseny",
      role: "member",
      state: "archived",
    });
    expect(state.events.slice(-2).map((event) => event.payload.kind)).toEqual([
      "ownershipTransferred",
      "memberArchived",
    ]);
  });

  test("owner detaches a wrong claim and the identity can be claimed again", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    const member = id(2_001);
    const unit = id(2_002);
    await owner(t).mutation(addPendingMember, {
      displayName: "Maya",
      potId: ids.pot,
      event: {
        ...baseEvent(id(2_000)),
        payload: {
          kind: "memberAdded" as const,
          memberId: member,
          unitId: unit,
          role: "member" as const,
        },
        textFields: [],
        authoredText: [],
      },
    });
    const wrongToken = "wrong-claim-token-0123456789abcdef01234567";
    await owner(t).mutation(issueInvite, {
      potId: ids.pot,
      inviteId: id(2_003),
      kind: "perMember",
      pendingMemberId: member,
      token: wrongToken,
      code: "WRONG1",
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    await ensureOutsiderSession(t);
    await outsider(t).mutation(claimPerMemberInvite, {
      token: wrongToken,
      event: {
        eventId: id(2_004),
        occurredAtMillis: 1_700_000_700_000n,
        originatingTimeZone: "Europe/Madrid",
        schemaVersion: 1n,
      },
    });
    const before = await outsider(t).query(listEvents, {
      potId: ids.pot,
      afterSequence: 0n,
    });
    expect(before.events.length).toBeGreaterThan(0);

    // The owner detaches the wrong claim: that account loses access immediately.
    const reassignmentEvent = {
      ...baseEvent(id(2_005)),
      payload: { kind: "memberClaimReassigned" as const, memberId: member },
      textFields: [],
      authoredText: [],
    };
    const reassignmentResult = await owner(t).mutation(reassignClaim, {
      potId: ids.pot,
      event: reassignmentEvent,
    });
    await expect(owner(t).mutation(reassignClaim, {
      potId: ids.pot,
      event: reassignmentEvent,
    })).resolves.toEqual(reassignmentResult);
    await expectTerminalCode(
      outsider(t).query(listEvents, { potId: ids.pot, afterSequence: 0n }),
      "NOT_MEMBER",
    );

    // The identity is free again and a fresh invite can be claimed for it.
    const rightToken = "right-claim-token-0123456789abcdef01234567";
    await owner(t).mutation(issueInvite, {
      potId: ids.pot,
      inviteId: id(2_006),
      kind: "perMember",
      pendingMemberId: member,
      token: rightToken,
      code: "RIGHT1",
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    const reclaim = await outsider(t).mutation(claimPerMemberInvite, {
      token: rightToken,
      event: {
        eventId: id(2_007),
        occurredAtMillis: 1_700_000_800_000n,
        originatingTimeZone: "Europe/Madrid",
        schemaVersion: 1n,
      },
    });
    expect(reclaim.memberId).toBe(member);
  });

  test("push tokens: a device re-registration moves it and only its owner drops it", async () => {
    const t = convexTest(schema, modules);
    await ensureOwnerSession(t);
    await ensureOutsiderSession(t);
    const deviceToken = "a".repeat(64);
    await expectTerminalCode(
      owner(t).mutation(registerPushToken, {
        deviceToken: "not-hex",
        environment: "sandbox",
        timeZone: "Europe/Madrid",
      }),
      "INVALID_DEVICE_TOKEN",
    );
    await expectTerminalCode(
      owner(t).mutation(registerPushToken, {
        deviceToken: "a".repeat(65),
        environment: "sandbox",
        timeZone: "Europe/Madrid",
      }),
      "INVALID_DEVICE_TOKEN",
    );
    await expectTerminalCode(
      owner(t).mutation(registerPushToken, {
        deviceToken,
        environment: "sandbox",
        timeZone: "Mars/Olympus_Mons",
      }),
      "INVALID_TIME_ZONE",
    );
    await owner(t).mutation(registerPushToken, {
      deviceToken,
      environment: "sandbox",
      timeZone: "Europe/Madrid",
    });
    let rows = await t.run(async (ctx) => await ctx.db.query("pushTokens").collect());
    expect(rows.length).toBe(1);
    const firstAccountId = rows[0].accountId;

    // The same physical device signed into another account re-points the token
    // (uppercase input is normalized), so the old account stops receiving its pushes.
    await outsider(t).mutation(registerPushToken, {
      deviceToken: deviceToken.toUpperCase(),
      environment: "production",
      timeZone: "America/New_York",
    });
    rows = await t.run(async (ctx) => await ctx.db.query("pushTokens").collect());
    expect(rows.length).toBe(1);
    expect(rows[0].accountId).not.toBe(firstAccountId);
    expect(rows[0].environment).toBe("production");
    expect(rows[0].timeZone).toBe("America/New_York");

    await expectTerminalCode(
      owner(t).mutation(unregisterPushToken, { deviceToken }),
      "NOT_TOKEN_OWNER",
    );
    expect(
      (await outsider(t).mutation(unregisterPushToken, { deviceToken })).removed,
    ).toBe(true);
    // A retried sign-out on an unknown token is a no-op, not a failure.
    expect(
      (await outsider(t).mutation(unregisterPushToken, { deviceToken })).removed,
    ).toBe(false);
  });

  test("a delayed APNs 410 cannot delete a newer token registration", async () => {
    const t = convexTest(schema, modules);
    await ensureOwnerSession(t);
    const deviceToken = "c".repeat(64);
    await owner(t).mutation(registerPushToken, {
      deviceToken,
      environment: "sandbox",
      timeZone: "Europe/Madrid",
    });
    const first = await t.run(async (ctx) =>
      await ctx.db
        .query("pushTokens")
        .withIndex("by_token", (index) => index.eq("deviceToken", deviceToken))
        .unique(),
    );
    if (!first) throw new Error("missing first token registration");
    await t.run(async (ctx) => {
      await ctx.db.patch(first._id, { updatedAt: first.updatedAt + 1_000 });
    });

    expect((await t.mutation(dropPushToken, {
      deviceToken,
      invalidatedAtMillis: first.updatedAt,
    })).removed).toBe(false);
    expect((await t.mutation(dropPushToken, {
      deviceToken,
      invalidatedAtMillis: first.updatedAt + 1_000,
    })).removed).toBe(true);
  });

  test("per-pot mute requires membership and toggles idempotently", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    await ensureOutsiderSession(t);
    expect((await owner(t).query(getPotMute, { potId: ids.pot })).muted)
      .toBe(false);
    await expectTerminalCode(
      outsider(t).mutation(setPotMute, { potId: ids.pot, muted: true }),
      "NOT_MEMBER",
    );
    expect(
      (await owner(t).mutation(setPotMute, { potId: ids.pot, muted: true })).muted,
    ).toBe(true);
    await owner(t).mutation(setPotMute, { potId: ids.pot, muted: true });
    expect((await owner(t).query(getPotMute, { potId: ids.pot })).muted)
      .toBe(true);
    let mutes = await t.run(async (ctx) => await ctx.db.query("potMutes").collect());
    expect(mutes.length).toBe(1);
    expect(
      (await owner(t).mutation(setPotMute, { potId: ids.pot, muted: false })).muted,
    ).toBe(false);
    mutes = await t.run(async (ctx) => await ctx.db.query("potMutes").collect());
    expect(mutes.length).toBe(0);
    expect((await owner(t).query(getPotMute, { potId: ids.pot })).muted)
      .toBe(false);
  });

  test("owner renames the pot and the server projects the current name", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    await ensureOutsiderSession(t);
    await expectTerminalCode(
      outsider(t).mutation(renamePot, {
        potId: ids.pot,
        event: {
          ...baseEvent(id(2_101)),
          payload: { kind: "potRenamed" as const, name: "Hijacked" },
          textFields: [],
          authoredText: [],
        },
      }),
      "NOT_MEMBER",
    );
    const renamed = await owner(t).mutation(renamePot, {
      potId: ids.pot,
      event: {
        ...baseEvent(id(2_100)),
        payload: { kind: "potRenamed" as const, name: "Casa Mar" },
        textFields: [],
        authoredText: [],
      },
    });
    expect(renamed.name).toBe("Casa Mar");
    // The name is projected onto the pot so push composition never needs the client.
    const pot = await t.run(async (ctx) =>
      await ctx.db
        .query("pots")
        .withIndex("by_pot_id", (index) => index.eq("potId", ids.pot))
        .unique(),
    );
    expect(pot?.name).toBe("Casa Mar");
  });

  test("replaying an earlier rename preserves the latest projected pot name", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    const firstRename = textlessEvent(id(2_110), {
      kind: "potRenamed", name: "Casa Mar",
    });
    const firstReceipt = await owner(t).mutation(renamePot, {
      potId: ids.pot, event: firstRename,
    });
    const latestRename = textlessEvent(id(2_111), {
      kind: "potRenamed", name: "Casa Sol",
    });
    await owner(t).mutation(renamePot, {
      potId: ids.pot, event: latestRename,
    });
    const snapshot = () => t.run(async (ctx) => ({
      pot: await ctx.db.query("pots")
        .withIndex("by_pot_id", (index) => index.eq("potId", ids.pot)).unique(),
      events: await ctx.db.query("events")
        .withIndex("by_pot_sequence", (index) => index.eq("potId", ids.pot)).collect(),
    }));
    const beforeReplay = await snapshot();
    expect(beforeReplay.pot?.name).toBe("Casa Sol");
    expect(await owner(t).mutation(renamePot, {
      potId: ids.pot, event: firstRename,
    })).toEqual(firstReceipt);
    // Recovering a receipt must not append history or roll back its projection.
    expect(await snapshot()).toEqual(beforeReplay);
    await expectTerminalCode(owner(t).mutation(renamePot, {
      potId: ids.pot,
      event: { ...firstRename, payload: { kind: "potRenamed", name: "Changed retry" } },
    }), "EVENT_ID_CONFLICT");
    expect(await snapshot()).toEqual(beforeReplay);
  });

  test("push fan-out reaches the affected member's device, never the actor", async () => {
    const t = convexTest(schema, modules);
    const { joiner, joinerUnit } = await setupTwoMemberPushPot(t);

    // The owner has a device registered; the joiner spends, splitting with the owner.
    const deviceToken = "b".repeat(64);
    await owner(t).mutation(registerPushToken, {
      deviceToken,
      environment: "sandbox",
      timeZone: "Europe/Madrid",
    });
    const expenseEventId = id(2_207);
    await outsider(t).mutation(appendEvents, {
      potId: ids.pot,
      events: [{
        eventId: expenseEventId,
        potId: ids.pot,
        actorMemberId: joiner,
        occurredAtMillis: 1_700_001_000_000n,
        originatingTimeZone: "Europe/Madrid",
        schemaVersion: 1n,
        payload: {
          kind: "expenseAdded" as const,
          recordId: id(2_208),
          content: {
            expenseKind: "shared" as const,
            amount: money(2_000n),
            payerUnitId: joinerUnit,
            allocations: [
              { unitId: joinerUnit, amount: money(1_000n) },
              { unitId: ids.payer, amount: money(1_000n) },
            ],
          },
        },
        textFields: ["title"],
        authoredText: [{ field: "title" as const, value: "Groceries" }],
      }],
    });

    // The owner is notified on their device; the actor (joiner) is not, and the body
    // is pot-named with no amount.
    const targets = await t.query(pushTargets, {
      potId: ids.pot,
      eventId: expenseEventId,
    });
    expect(targets.body).toBe("New expense in Casa Mar affects your balance");
    expect(targets.tokens.map((row: { deviceToken: string }) => row.deviceToken))
      .toEqual([deviceToken]);

    // Muting the pot stops delivery server-side, before any APNs call.
    await owner(t).mutation(setPotMute, { potId: ids.pot, muted: true });
    expect((await t.query(pushTargets, { potId: ids.pot, eventId: expenseEventId })).tokens)
      .toEqual([]);
    await owner(t).mutation(setPotMute, { potId: ids.pot, muted: false });

    // A 410 Unregistered drops the dead device so the next fan-out skips it.
    expect((await t.mutation(dropPushToken, {
      deviceToken,
      invalidatedAtMillis: Date.now(),
    })).removed).toBe(true);
    expect((await t.query(pushTargets, { potId: ids.pot, eventId: expenseEventId })).tokens)
      .toEqual([]);
  });

  test("edit, void, and settlement fan-out follows actual contribution changes", async () => {
    const t = convexTest(schema, modules);
    const { joinerUnit } = await setupTwoMemberPushPot(t);
    const joinerToken = "f".repeat(64);
    await outsider(t).mutation(registerPushToken, {
      deviceToken: joinerToken,
      environment: "sandbox",
      timeZone: "Europe/Madrid",
    });

    const sharedExpense = (eventId: string, recordId: string) => ({
      ...baseEvent(eventId),
      payload: {
        kind: "expenseAdded" as const,
        recordId,
        content: {
          expenseKind: "shared" as const,
          amount: money(2_000n),
          payerUnitId: ids.payer,
          allocations: [
            { unitId: ids.payer, amount: money(1_000n) },
            { unitId: joinerUnit, amount: money(1_000n) },
          ],
        },
      },
      textFields: ["title"] as const,
      authoredText: [{ field: "title" as const, value: `Shared ${recordId}` }],
    });

    const editedRecordId = id(2_501);
    const editedRoot = sharedExpense(id(2_500), editedRecordId);
    await owner(t).mutation(appendEvents, { potId: ids.pot, events: [editedRoot] });
    const edit = {
      ...baseEvent(id(2_502)),
      payload: {
        kind: "expenseRevised" as const,
        recordId: editedRecordId,
        basis: { kind: "parent" as const, parentEventId: editedRoot.eventId },
        content: {
          kind: "expense" as const,
          expenseKind: "shared" as const,
          amount: money(2_000n),
          payerUnitId: ids.payer,
          allocations: [{ unitId: ids.payer, amount: money(2_000n) }],
        },
      },
      textFields: ["title"] as const,
      authoredText: [{ field: "title" as const, value: "Now owner-only" }],
    };
    await owner(t).mutation(appendEvents, { potId: ids.pot, events: [edit] });
    expect(await t.query(pushTargets, { potId: ids.pot, eventId: edit.eventId }))
      .toEqual({
        body: "A record in Casa Mar was edited and affects your balance",
        tokens: [{ deviceToken: joinerToken, environment: "sandbox" }],
      });

    const voidedRecordId = id(2_504);
    const voidedRoot = sharedExpense(id(2_503), voidedRecordId);
    await owner(t).mutation(appendEvents, { potId: ids.pot, events: [voidedRoot] });
    const voided = voidRecord(id(2_505), voidedRecordId);
    await owner(t).mutation(appendEvents, { potId: ids.pot, events: [voided] });
    expect(await t.query(pushTargets, { potId: ids.pot, eventId: voided.eventId }))
      .toEqual({
        body: "A record in Casa Mar was voided and affects your balance",
        tokens: [{ deviceToken: joinerToken, environment: "sandbox" }],
      });

    const settlementEventId = id(2_506);
    await owner(t).mutation(appendEvents, {
      potId: ids.pot,
      events: [{
        ...baseEvent(settlementEventId),
        payload: {
          kind: "settlementRecorded" as const,
          recordId: id(2_507),
          content: {
            amount: money(500n),
            fromUnitId: joinerUnit,
            toUnitId: ids.payer,
          },
        },
        textFields: ["title"] as const,
        authoredText: [{ field: "title" as const, value: "Manual settlement" }],
      }],
    });
    expect(await t.query(pushTargets, { potId: ids.pot, eventId: settlementEventId }))
      .toEqual({
        body: "A settlement in Casa Mar involves your balance",
        tokens: [{ deviceToken: joinerToken, environment: "sandbox" }],
      });
  });

  test("a new contested branch notifies the other head author, never the actor", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    await addOtherMember(t);
    await owner(t).mutation(renamePot, {
      potId: ids.pot,
      event: {
        ...baseEvent(id(2_300)),
        payload: { kind: "potRenamed" as const, name: "Casa Mar" },
        textFields: [],
        authoredText: [],
      },
    });
    const ownerToken = "d".repeat(64);
    const actorToken = "e".repeat(64);
    await owner(t).mutation(registerPushToken, {
      deviceToken: ownerToken,
      environment: "sandbox",
      timeZone: "Europe/Madrid",
    });
    await outsider(t).mutation(registerPushToken, {
      deviceToken: actorToken,
      environment: "sandbox",
      timeZone: "Europe/Madrid",
    });

    const firstHead = expenseRevision(
      id(2_301),
      ids.expenseRecord,
      { kind: "parent", parentEventId: ids.expenseEvent },
      8_800n,
    );
    const secondHead = {
      ...expenseRevision(
        id(2_302),
        ids.expenseRecord,
        { kind: "parent", parentEventId: ids.expenseEvent },
        8_900n,
      ),
      actorMemberId: ids.otherMember,
    };
    await owner(t).mutation(appendEvents, { potId: ids.pot, events: [firstHead] });
    await outsider(t).mutation(appendEvents, { potId: ids.pot, events: [secondHead] });

    const targets = await t.query(pushTargets, {
      potId: ids.pot,
      eventId: secondHead.eventId,
    });
    expect(targets.body).toBe("A record in Casa Mar needs your choice");
    expect(targets.tokens).toEqual([{ deviceToken: ownerToken, environment: "sandbox" }]);
  });

  test("queues one coalesced push for a new eligible event, never for replay or a silent kind", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await promote(t);
    const pushedEvent = expenseRoot(id(2_400), id(2_401));
    await owner(t).mutation(appendEvents, { potId: ids.pot, events: [pushedEvent] });

    const scheduled = async () => await t.run(async (ctx) =>
      await ctx.db.system.query("_scheduled_functions").collect(),
    );
    const pending = async () => await t.run(async (ctx) =>
      await ctx.db.query("pendingPushes").collect(),
    );
    let rows = await scheduled();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toMatch(/pushQueue(?:\.js)?:flushPendingPush$/);
    expect(rows[0].state).toEqual({ kind: "pending" });
    let queued = await pending();
    expect(queued).toHaveLength(1);
    expect(rows[0].args).toEqual([{ pendingId: queued[0]._id }]);
    expect(queued[0].eventIds).toEqual([pushedEvent.eventId]);

    await owner(t).mutation(appendEvents, { potId: ids.pot, events: [pushedEvent] });
    await owner(t).mutation(appendEvents, {
      potId: ids.pot,
      events: [textlessEvent(id(2_402), {
        kind: "settlementFlagged",
        recordId: ids.settlementRecord,
      })],
    });
    rows = await scheduled();
    expect(rows).toHaveLength(1);
    queued = await pending();
    expect(queued[0].eventIds).toEqual([pushedEvent.eventId]);
  });

  test("coalesces a run of one-event uploads into one summary push per person", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { joinerUnit } = await setupTwoMemberPushPot(t);
    const sharedExpense = (eventId: string, recordId: string) => ({
      ...baseEvent(eventId),
      payload: {
        kind: "expenseAdded" as const,
        recordId,
        content: {
          expenseKind: "shared" as const,
          amount: money(2_000n),
          payerUnitId: ids.payer,
          allocations: [
            { unitId: ids.payer, amount: money(1_000n) },
            { unitId: joinerUnit, amount: money(1_000n) },
          ],
        },
      },
      textFields: ["title"] as const,
      authoredText: [{ field: "title" as const, value: `Shared ${recordId}` }],
    });
    // Drop anything the setup queued so this test sees only its own batch.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("pendingPushes").collect()) {
        await ctx.db.delete(row._id);
      }
    });

    // The sync client sends one event per call, as it did for the bulk upload.
    const uploaded = [0, 1, 2].map((offset) =>
      sharedExpense(id(2_700 + offset * 2), id(2_701 + offset * 2)));
    for (const event of uploaded) {
      await owner(t).mutation(appendEvents, { potId: ids.pot, events: [event] });
      vi.setSystemTime(Date.now() + 5_000);
    }
    const queued = await t.run(async (ctx) => await ctx.db.query("pendingPushes").collect());
    expect(queued).toHaveLength(1);
    expect(queued[0].eventIds).toEqual(uploaded.map((event) => event.eventId));
    const flushes = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect())
        .filter((row) => /flushPendingPush$/.test(row.name)));
    expect(flushes).toHaveLength(1);

    const joinerAccount = await t.run(async (ctx) => (await ctx.db
      .query("potMembers")
      .withIndex("by_pot_account", (index) => index.eq("potId", ids.pot))
      .collect()).find((member) => member.memberId !== ids.ownerMember)!.accountId);

    // Three events affecting Maya become one summary; the owner (the actor) gets none.
    const plan = await t.query(batchPushPlan, {
      potId: ids.pot,
      eventIds: queued[0].eventIds,
    });
    expect(plan.potName).toBe("Casa Mar");
    expect(composeBatchMessages(plan.potName!, plan.plans)).toEqual([
      { accountId: joinerAccount, body: "3 updates in Casa Mar affect your balance" },
    ]);
    // A batch of one keeps the event's own wording.
    const single = await t.query(batchPushPlan, {
      potId: ids.pot,
      eventIds: [uploaded[0].eventId],
    });
    expect(composeBatchMessages(single.potName!, single.plans)).toEqual([
      { accountId: joinerAccount, body: "New expense in Casa Mar affects your balance" },
    ]);
  });

  test("flushes a pending push after a quiet window, or at the ceiling during a long upload", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    await promote(t);
    const pending = async () => await t.run(async (ctx) =>
      await ctx.db.query("pendingPushes").collect(),
    );
    const scheduledNamed = async (pattern: RegExp) => await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect())
        .filter((row) => pattern.test(row.name) && row.state.kind === "pending"));

    // Move the clock with setSystemTime only: it never fires scheduled functions, so
    // each flush below runs exactly when the test calls it.
    await owner(t).mutation(appendEvents, {
      potId: ids.pot,
      events: [expenseRoot(id(2_800), id(2_801))],
    });
    const [row] = await pending();
    expect(await t.mutation(flushPendingPush, { pendingId: row._id }))
      .toEqual({ status: "deferred" });
    vi.setSystemTime(Date.now() + 30_001);
    expect(await t.mutation(flushPendingPush, { pendingId: row._id }))
      .toEqual({ status: "flushed", eventCount: 1 });
    expect(await pending()).toEqual([]);
    const deliveries = await scheduledNamed(/apns(?:\.js)?:deliverBatchPush$/);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].args).toEqual([{ potId: ids.pot, eventIds: [id(2_800)] }]);
    expect(await t.mutation(flushPendingPush, { pendingId: row._id }))
      .toEqual({ status: "gone" });

    // A long upload keeps the pot busy; the ceiling still delivers within ten minutes.
    await owner(t).mutation(appendEvents, {
      potId: ids.pot,
      events: [expenseRoot(id(2_810), id(2_811))],
    });
    const [busy] = await pending();
    for (let step = 0; step < 31; step += 1) {
      vi.setSystemTime(Date.now() + 20_000);
      await owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [expenseRoot(id(2_812 + step * 2), id(2_813 + step * 2))],
      });
    }
    const result = await t.mutation(flushPendingPush, { pendingId: busy._id });
    expect(result).toEqual({ status: "flushed", eventCount: 32 });
  });

  test("batch messages keep a choice request separate and never repeat a person", () => {
    const plans = [
      { kind: "unit" as const, body: "New expense in Casa Mar affects your balance", accountIds: ["a", "b"] },
      { kind: "contested" as const, body: "A record in Casa Mar needs your choice", accountIds: ["a"] },
      { kind: "unit" as const, body: "A settlement in Casa Mar involves your balance", accountIds: ["a", "a"] },
    ];
    expect(composeBatchMessages("Casa Mar", plans)).toEqual([
      { accountId: "a", body: "2 updates in Casa Mar affect your balance" },
      { accountId: "a", body: "A record in Casa Mar needs your choice" },
      { accountId: "b", body: "New expense in Casa Mar affects your balance" },
    ]);
    expect(composeBatchMessages("Casa Mar", [])).toEqual([]);
  });

  test("rejects a blank void even inside atomic legacy adoption", async () => {
    const t = convexTest(schema, modules);
    await ensureOwnerSession(t);
    const blankVoid = {
      ...voidRecord(id(407), ids.expenseRecord),
      authoredText: [{ field: "reason" as const, value: " \n" }],
    };
    await expectTerminalCode(
      owner(t).mutation(promoteLocalPot, {
        ownerDisplayName: "Arseny",
        configuration,
        events: [expense, blankVoid],
        legacyMigrationEventIds: [expense.eventId, blankVoid.eventId],
      }),
      "BLANK_REASON",
    );
    const counts = await t.run(async (ctx) => ({
      pots: (await ctx.db.query("pots").collect()).length,
      members: (await ctx.db.query("potMembers").collect()).length,
      events: (await ctx.db.query("events").collect()).length,
      texts: (await ctx.db.query("eventTexts").collect()).length,
    }));
    expect(counts).toEqual({ pots: 0, members: 0, events: 0, texts: 0 });
  });

  test("rejects duplicate financial roots before sequencing while preserving exact replay", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    const duplicateRoot = {
      ...expense,
      eventId: id(405),
      authoredText: [
        { field: "title" as const, value: "A second root for one record" },
        expense.authoredText[1],
      ],
    };

    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [duplicateRoot],
      }),
      "DUPLICATE_RECORD",
    );
    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [{
          ...settlement,
          eventId: id(406),
          payload: { ...settlement.payload, recordId: ids.expenseRecord },
        }],
      }),
      "DUPLICATE_RECORD",
    );
    await expect(
      owner(t).mutation(appendEvents, { potId: ids.pot, events: [expense] }),
    ).resolves.toEqual({
      events: [{ eventId: ids.expenseEvent, sequence: 1n }],
    });

    const listed = await owner(t).query(listEvents, {
      potId: ids.pot,
      afterSequence: 0n,
    });
    expect(listed.events.map((item: { serverSequence: bigint }) => item.serverSequence))
      .toEqual([1n, 2n]);

    const promotedRoot = expenseRoot(id(6_000), id(6_100), ids.secondPot);
    const duplicateInPromotion = expenseRoot(id(6_001), id(6_100), ids.secondPot);
    await expectTerminalCode(
      owner(t).mutation(promoteLocalPot, {
        ownerDisplayName: "Arseny",
        configuration: { ...configuration, potId: ids.secondPot },
        events: [promotedRoot, duplicateInPromotion],
      }),
      "DUPLICATE_RECORD",
    );
    const rolledBackPot = await t.run(async (ctx) => await ctx.db
      .query("pots")
      .withIndex("by_pot_id", (index) => index.eq("potId", ids.secondPot))
      .unique());
    expect(rolledBackPot).toBeNull();
  });

  test("requires known same-record revision lineage while allowing stale known parents", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [expenseRevision(
          id(500),
          id(499),
          { kind: "parent", parentEventId: ids.expenseEvent },
          9_000n,
        )],
      }),
      "MISSING_RECORD",
    );
    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [expenseRevision(
          id(501),
          ids.expenseRecord,
          { kind: "parent", parentEventId: ids.settlementEvent },
          9_100n,
        )],
      }),
      "UNKNOWN_REVISION",
    );

    const first = expenseRevision(
      id(510),
      ids.expenseRecord,
      { kind: "parent", parentEventId: ids.expenseEvent },
      9_200n,
    );
    const staleParentBranch = expenseRevision(
      id(511),
      ids.expenseRecord,
      { kind: "parent", parentEventId: ids.expenseEvent },
      9_400n,
    );
    await expect(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [first, staleParentBranch],
      }),
    ).resolves.toEqual({
      events: [
        { eventId: first.eventId, sequence: 3n },
        { eventId: staleParentBranch.eventId, sequence: 4n },
      ],
    });

    const nonHeadResolution = expenseRevision(
      id(512),
      ids.expenseRecord,
      {
        kind: "resolution",
        firstEventId: ids.expenseEvent,
        secondEventId: first.eventId,
      },
      9_500n,
    );
    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [nonHeadResolution],
      }),
      "INVALID_RESOLUTION",
    );

    const resolution = expenseRevision(
      id(513),
      ids.expenseRecord,
      {
        kind: "resolution",
        firstEventId: first.eventId,
        secondEventId: staleParentBranch.eventId,
      },
      9_600n,
    );
    await expect(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [resolution],
      }),
    ).resolves.toEqual({
      events: [{ eventId: resolution.eventId, sequence: 5n }],
    });
    await expect(
      owner(t).mutation(appendEvents, { potId: ids.pot, events: [first] }),
    ).resolves.toEqual({
      events: [{ eventId: first.eventId, sequence: 3n }],
    });
  });

  test("enforces revisable record kinds and settlement-only flag targets", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    const openingRecordId = id(520);
    const opening = openingBalanceRoot(id(521), openingRecordId);
    await owner(t).mutation(appendEvents, {
      potId: ids.pot,
      events: [opening],
    });

    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [expenseRevision(
          id(522),
          openingRecordId,
          { kind: "parent", parentEventId: opening.eventId },
          9_000n,
        )],
      }),
      "RECORD_KIND_CHANGED",
    );
    const openingRevision = openingBalanceRevision(
      id(523),
      openingRecordId,
      opening.eventId,
    );
    await expect(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [openingRevision],
      }),
    ).resolves.toEqual({
      events: [{ eventId: openingRevision.eventId, sequence: 4n }],
    });

    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [expenseRevision(
          id(524),
          ids.settlementRecord,
          { kind: "parent", parentEventId: ids.settlementEvent },
          8_000n,
        )],
      }),
      "IMMUTABLE_SETTLEMENT",
    );
    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [voidRecord(id(525), ids.settlementRecord)],
      }),
      "IMMUTABLE_SETTLEMENT",
    );
    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [voidRecord(id(5_250), id(5_251))],
      }),
      "MISSING_RECORD",
    );
    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [textlessEvent(id(5_252), {
          kind: "recordRestored",
          recordId: ids.settlementRecord,
        })],
      }),
      "IMMUTABLE_SETTLEMENT",
    );
    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [textlessEvent(id(526), {
          kind: "settlementFlagged",
          recordId: ids.expenseRecord,
        })],
      }),
      "NON_SETTLEMENT_FLAG_TARGET",
    );
    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [textlessEvent(id(527), {
          kind: "settlementFlagged",
          recordId: id(528),
        })],
      }),
      "MISSING_RECORD",
    );

    const flag = textlessEvent(id(529), {
      kind: "settlementFlagged",
      recordId: ids.settlementRecord,
    });
    const restoreActive = textlessEvent(id(530), {
      kind: "recordRestored",
      recordId: ids.expenseRecord,
    });
    await expect(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [flag, restoreActive],
      }),
    ).resolves.toEqual({
      events: [
        { eventId: flag.eventId, sequence: 5n },
        { eventId: restoreActive.eventId, sequence: 6n },
      ],
    });
  });

  test("accepts only bounded opposite reversals linked to a flagged settlement", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    const unflagged = settlementReversal(
      id(531), id(532), 100n, ids.settlementRecord,
    );
    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [unflagged],
      }),
      "SETTLEMENT_REVERSAL_TARGET_NOT_FLAGGED",
    );

    const flag = textlessEvent(id(533), {
      kind: "settlementFlagged",
      recordId: ids.settlementRecord,
    });
    await owner(t).mutation(appendEvents, {
      potId: ids.pot,
      events: [flag],
    });
    const wrongDirection = settlementReversal(
      id(534), id(535), 100n, ids.settlementRecord, "same",
    );
    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [wrongDirection],
      }),
      "SETTLEMENT_REVERSAL_DIRECTION_MISMATCH",
    );

    const partial = settlementReversal(
      id(536), id(537), 2_000n, ids.settlementRecord,
    );
    const final = settlementReversal(
      id(538), id(539), 2_320n, ids.settlementRecord,
    );
    await expect(owner(t).mutation(appendEvents, {
      potId: ids.pot,
      events: [partial, final],
    })).resolves.toEqual({
      events: [
        { eventId: partial.eventId, sequence: 4n },
        { eventId: final.eventId, sequence: 5n },
      ],
    });

    const excessive = settlementReversal(
      id(540), id(541), 1n, ids.settlementRecord,
    );
    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [excessive],
      }),
      "SETTLEMENT_REVERSAL_EXCEEDS_ORIGINAL",
    );
    const stored = await t.run(async (ctx) => await ctx.db
      .query("events")
      .withIndex("by_pot_reversal", (index) => index
        .eq("potId", ids.pot)
        .eq("reversalOfRecordId", ids.settlementRecord))
      .collect());
    expect(stored.map((event) => event.eventId)).toEqual([
      partial.eventId,
      final.eventId,
    ]);
  });

  test("fails closed for deployment, unauthenticated, non-member, spoofed, and archived access", async () => {
    const t = convexTest(schema, modules);

    vi.stubEnv("NUMA_SHARED_DEPLOYMENT_CLASS", "cloud");
    await expectTerminalCode(
      owner(t).mutation(promoteLocalPot, {
        ownerDisplayName: "Arseny",
        configuration,
        events: [],
      }),
      "DEPLOYMENT_NOT_APPROVED",
    );
    await expectTerminalCode(
      t.mutation(dropPushToken, {
        deviceToken: "a".repeat(64),
        invalidatedAtMillis: Date.now(),
      }),
      "DEPLOYMENT_NOT_APPROVED",
    );
    await expectTerminalCode(
      t.action(deliverEventPush, {
        potId: ids.pot,
        eventId: ids.expenseEvent,
      }),
      "DEPLOYMENT_NOT_APPROVED",
    );
    await expectTerminalCode(
      t.action(deliverBatchPush, { potId: ids.pot, eventIds: [ids.expenseEvent] }),
      "DEPLOYMENT_NOT_APPROVED",
    );
    vi.stubEnv("NUMA_SHARED_DEPLOYMENT_CLASS", "anonymous-local");

    vi.stubEnv("CONVEX_CLOUD_URL", "https://wrong-project.convex.cloud");
    await expectTerminalCode(
      owner(t).mutation(promoteLocalPot, {
        ownerDisplayName: "Arseny",
        configuration,
        events: [],
      }),
      "DEPLOYMENT_NOT_APPROVED",
    );
    vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");

    await expectTerminalCode(
      t.mutation(promoteLocalPot, {
        ownerDisplayName: "Arseny",
        configuration,
        events: [],
      }),
      "AUTH_REQUIRED",
    );
    await promote(t);
    await expectTerminalCode(
      directAppleIdentity(t).query(listMyPots, {}),
      "AUTH_ISSUER_REJECTED",
    );
    await ensureOutsiderSession(t);
    await expectTerminalCode(
      outsider(t).query(listEvents, { potId: ids.pot, afterSequence: 0n }),
      "NOT_MEMBER",
    );
    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [{ ...expense, actorMemberId: ids.otherMember }],
      }),
      "ACTOR_MISMATCH",
    );

    await addOtherMember(t, "archived");
    await expectTerminalCode(
      outsider(t).query(listEvents, { potId: ids.pot, afterSequence: 0n }),
      "MEMBERSHIP_ARCHIVED",
    );
    await expectTerminalCode(
      outsider(t).mutation(appendEvents, { potId: ids.pot, events: [] }),
      "MEMBERSHIP_ARCHIVED",
    );

    await t.run(async (ctx) => {
      const session = await ctx.db
        .query("sessions")
        .withIndex("by_session_id", (index) =>
          index.eq("sessionId", "session-owner-00000001"),
        )
        .unique();
      if (!session) throw new Error("missing owner session");
      await ctx.db.patch(session._id, { revokedAt: Date.now() });
    });
    await expectTerminalCode(owner(t).query(listMyPots, {}), "AUTH_SESSION_REVOKED");
  });

  test("propagates explicit redaction states and replay cannot resurrect text", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    await addOtherMember(t);

    const before = await outsider(t).query(listEvents, {
      potId: ids.pot,
      afterSequence: 0n,
    });
    expect(before.events[0].textStates).toEqual([
      { field: "title", state: "present", value: "Unique secret grocery title" },
      { field: "category", state: "present", value: "Unique private category" },
    ]);
    expect(before.nextAfterSequence).toBe(2n);
    const textSequences = await t.run(async (ctx) =>
      (await ctx.db.query("eventTexts").collect())
        .map((sidecar) => sidecar.sequence));
    expect(textSequences).toEqual([1n, 1n, 2n]);

    const accountId = await t.run(async (ctx) => {
      const account = await ctx.db
        .query("accounts")
        .withIndex("by_public_account_id", (index) =>
          index.eq("publicAccountId", "account-owner-000001"),
        )
        .unique();
      if (!account) throw new Error("missing test account");
      return account._id;
    });
    await expect(
      t.mutation(eraseAuthoredTextForAccount, { accountId }),
    ).resolves.toEqual({ deletedFieldCount: 3n, hasMore: false });

    const changes = await outsider(t).query(listTextChanges, {
      potId: ids.pot,
      afterRevision: 0n,
    });
    expect(changes.changes).toEqual([
      { eventId: ids.expenseEvent, field: "title", revision: 1n, state: "redacted" },
      { eventId: ids.expenseEvent, field: "category", revision: 2n, state: "redacted" },
      { eventId: ids.settlementEvent, field: "title", revision: 3n, state: "redacted" },
    ]);
    expect(changes.nextAfterRevision).toBe(3n);

    const after = await outsider(t).query(listEvents, {
      potId: ids.pot,
      afterSequence: 0n,
    });
    expect(after.events[0].event.payload).toEqual(expense.payload);
    expect(after.events[0].textStates).toEqual([
      { field: "title", state: "redacted" },
      { field: "category", state: "redacted" },
    ]);

    await expect(
      owner(t).mutation(appendEvents, { potId: ids.pot, events: [expense] }),
    ).resolves.toEqual({
      events: [{ eventId: ids.expenseEvent, sequence: 1n }],
    });
    expect(
      await t.run(async (ctx) => await ctx.db.query("eventTexts").collect()),
    ).toEqual([]);
    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [{
          ...expense,
          authoredText: [
            { field: "title", value: "[redacted]" },
            expense.authoredText[1],
          ],
        }],
      }),
      "RESERVED_REDACTED_TEXT",
    );
  });

  test("redacts more than 100 authored fields across pots with continuous revisions", async () => {
    const t = convexTest(schema, modules);
    await ensureOwnerSession(t);
    await owner(t).mutation(promoteLocalPot, {
      ownerDisplayName: "Arseny",
      configuration,
      events: [],
    });
    await owner(t).mutation(promoteLocalPot, {
      ownerDisplayName: "Arseny",
      configuration: { ...configuration, potId: ids.secondPot },
      events: [],
    });
    await addOtherMember(t);

    const firstPotEvents = Array.from({ length: 30 }, (_, index) =>
      expenseRoot(id(3_000 + index), id(4_000 + index)));
    const secondPotEvents = Array.from({ length: 21 }, (_, index) =>
      expenseRoot(id(3_100 + index), id(4_100 + index), ids.secondPot));
    await owner(t).mutation(appendEvents, {
      potId: ids.pot,
      events: firstPotEvents,
    });
    await owner(t).mutation(appendEvents, {
      potId: ids.secondPot,
      events: secondPotEvents,
    });

    const otherAuthorEvent = {
      ...expenseRoot(id(3_200), id(4_200)),
      actorMemberId: ids.otherMember,
      authoredText: [
        { field: "title" as const, value: "Other author retained title" },
        { field: "category" as const, value: "Other author retained category" },
      ],
    };
    await outsider(t).mutation(appendEvents, {
      potId: ids.pot,
      events: [otherAuthorEvent],
    });

    const accountId = await t.run(async (ctx) => {
      const account = await ctx.db
        .query("accounts")
        .withIndex("by_public_account_id", (index) =>
          index.eq("publicAccountId", "account-owner-000001"),
        )
        .unique();
      if (!account) throw new Error("missing test account");
      return account._id;
    });
    await expect(
      t.mutation(eraseAuthoredTextForAccount, { accountId }),
    ).resolves.toEqual({ deletedFieldCount: 100n, hasMore: true });

    const firstPotBatch = await outsider(t).query(listTextChanges, {
      potId: ids.pot,
      afterRevision: 0n,
    });
    const secondPotBatch = await owner(t).query(listTextChanges, {
      potId: ids.secondPot,
      afterRevision: 0n,
    });
    expect(firstPotBatch.changes.map((change: { revision: bigint }) => change.revision))
      .toEqual(Array.from({ length: 60 }, (_, index) => BigInt(index + 1)));
    expect(secondPotBatch.changes.map((change: { revision: bigint }) => change.revision))
      .toEqual(Array.from({ length: 40 }, (_, index) => BigInt(index + 1)));

    await expect(
      t.mutation(eraseAuthoredTextForAccount, { accountId }),
    ).resolves.toEqual({ deletedFieldCount: 2n, hasMore: false });
    const secondPotFinal = await owner(t).query(listTextChanges, {
      potId: ids.secondPot,
      afterRevision: secondPotBatch.nextAfterRevision,
    });
    expect(secondPotFinal.changes.map((change: { revision: bigint }) => change.revision))
      .toEqual([41n, 42n]);
    expect(secondPotFinal.nextAfterRevision).toBe(42n);

    const visible = await outsider(t).query(listEvents, {
      potId: ids.pot,
      afterSequence: 0n,
    });
    const retained = visible.events.find(
      (item: { event: { eventId: string } }) => item.event.eventId === otherAuthorEvent.eventId,
    );
    expect(retained?.textStates).toEqual([
      { field: "title", state: "present", value: "Other author retained title" },
      { field: "category", state: "present", value: "Other author retained category" },
    ]);
    expect(visible.events[0].textStates).toEqual([
      { field: "title", state: "redacted" },
      { field: "category", state: "redacted" },
    ]);
    await expect(owner(t).query(listMyPots, {})).resolves.toMatchObject([
      { potId: ids.pot, lastTextRevision: 60n },
      { potId: ids.secondPot, lastTextRevision: 42n },
    ]);
  });

  test("account deletion anonymizes a shared pot, transfers ownership, and erases identity", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    await ensureOutsiderSession(t);
    const accountIds = await t.run(async (ctx) => {
      const deleting = await ctx.db.query("accounts")
        .withIndex("by_public_account_id", (index) =>
          index.eq("publicAccountId", "account-owner-000001"),
        ).unique();
      const remaining = await ctx.db.query("accounts")
        .withIndex("by_public_account_id", (index) =>
          index.eq("publicAccountId", "account-outsider-001"),
        ).unique();
      if (!deleting || !remaining) throw new Error("missing test accounts");
      await ctx.db.patch(deleting._id, { relayEmail: "relay@example.com" });
      await ctx.db.insert("potMembers", {
        potId: ids.pot,
        accountId: remaining._id,
        memberId: ids.otherMember,
        role: "member",
        status: "active",
        joinedAt: 2,
      });
      await ctx.db.insert("potMemberProfiles", {
        potId: ids.pot,
        memberId: ids.otherMember,
        unitId: ids.thirdUnit,
        displayName: "Maya",
        role: "member",
        state: "active",
        createdAt: 2,
        updatedAt: 2,
      });
      await ctx.db.insert("pushTokens", {
        accountId: deleting._id,
        deviceToken: "a".repeat(64),
        environment: "sandbox",
        timeZone: "Europe/Madrid",
        updatedAt: 2,
      });
      return { deleting: deleting._id, remaining: remaining._id };
    });

    const now = 1_700_002_000_000;
    const started = await t.mutation(beginAccountDeletion, {
      refreshTokenHash: "refresh-owner-hash",
      requestId: id(3_900),
      now,
    });
    expect(started).toMatchObject({ authorized: true, accountId: accountIds.deleting });
    await expectTerminalCode(
      owner(t).query(listEvents, { potId: ids.pot, afterSequence: 0n }),
      "AUTH_SESSION_REVOKED",
    );
    while ((await t.mutation(eraseAuthoredTextForAccount, {
      accountId: accountIds.deleting,
    })).hasMore) {}
    for (let step = 0; step < 10; step += 1) {
      const result = await t.mutation(processNextDeletionPot, {
        accountId: accountIds.deleting,
        transferEventId: id(3_800 + step * 2),
        archiveEventId: id(3_801 + step * 2),
        originatingTimeZone: "Europe/Madrid",
        now,
      });
      if (result.complete) break;
    }
    const requestId = id(3_900);
    const firstErase = await t.mutation(eraseDeletionIdentityBatch, {
      accountId: accountIds.deleting,
      requestId,
      now,
    });
    expect(firstErase.complete).toBe(false);
    await expect(t.mutation(beginAccountDeletion, {
      refreshTokenHash: "credential-already-erased",
      requestId,
      now: now + 1,
    })).resolves.toMatchObject({
      authorized: true,
      accountId: accountIds.deleting,
    });
    for (let step = 0; step < 20; step += 1) {
      const result = await t.mutation(eraseDeletionIdentityBatch, {
        accountId: accountIds.deleting,
        requestId,
        now,
      });
      if (result.complete) break;
    }

    const retained = await t.run(async (ctx) => {
      const pot = await ctx.db.query("pots")
        .withIndex("by_pot_id", (index) => index.eq("potId", ids.pot)).unique();
      const former = await ctx.db.query("potMemberProfiles")
        .withIndex("by_pot_member", (index) =>
          index.eq("potId", ids.pot).eq("memberId", ids.ownerMember),
        ).unique();
      const nextOwner = await ctx.db.query("potMembers")
        .withIndex("by_pot_member", (index) =>
          index.eq("potId", ids.pot).eq("memberId", ids.otherMember),
        ).unique();
      const events = await ctx.db.query("events")
        .withIndex("by_pot_sequence", (index) => index.eq("potId", ids.pot)).collect();
      return {
        pot,
        former,
        nextOwner,
        events,
        deletingAccount: await ctx.db.get(accountIds.deleting),
        deletingTokens: (await ctx.db.query("pushTokens").collect())
          .filter((token) => token.accountId === accountIds.deleting),
        deletingText: (await ctx.db.query("eventTexts").collect())
          .filter((text) => text.authorAccountId === accountIds.deleting),
      };
    });
    expect(retained.pot?.ownerAccountId).toBe(accountIds.remaining);
    expect(retained.nextOwner?.role).toBe("owner");
    expect(retained.former).toMatchObject({
      role: "member",
      state: "archived",
    });
    expect(retained.former?.displayName).toBeUndefined();
    expect(retained.events.map((event) => event.payload.kind)).toEqual(
      expect.arrayContaining(["expenseAdded", "ownershipTransferred", "memberArchived"]),
    );
    expect(retained.deletingAccount).toBeNull();
    expect(retained.deletingTokens).toEqual([]);
    expect(retained.deletingText).toEqual([]);
    await expect(t.query(accountDeletionReceipt, { requestId, now })).resolves.toEqual({
      complete: true,
    });

    const page = await outsider(t).query(listEvents, {
      potId: ids.pot,
      afterSequence: 0n,
    });
    expect(page.events.length).toBe(retained.events.length);
    const retainedExpense = retained.events.find((event) =>
      event.payload.kind === "expenseAdded"
    );
    expect(retainedExpense?.payload).toEqual(expense.payload);
  });

  test("account deletion hard-deletes a pot with no remaining active member", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    const accountId = await t.run(async (ctx) => {
      const account = await ctx.db.query("accounts")
        .withIndex("by_public_account_id", (index) =>
          index.eq("publicAccountId", "account-owner-000001"),
        ).unique();
      if (!account) throw new Error("missing test account");
      return account._id;
    });
    const now = 1_700_003_000_000;
    await t.mutation(beginAccountDeletion, {
      refreshTokenHash: "refresh-owner-hash",
      requestId: id(4_100),
      now,
    });
    while ((await t.mutation(eraseAuthoredTextForAccount, { accountId })).hasMore) {}
    for (let step = 0; step < 30; step += 1) {
      const result = await t.mutation(processNextDeletionPot, {
        accountId,
        transferEventId: id(4_000 + step * 2),
        archiveEventId: id(4_001 + step * 2),
        originatingTimeZone: "Europe/Madrid",
        now,
      });
      if (result.complete) break;
    }
    const requestId = id(4_100);
    for (let step = 0; step < 20; step += 1) {
      const result = await t.mutation(eraseDeletionIdentityBatch, {
        accountId,
        requestId,
        now,
      });
      if (result.complete) break;
    }
    const rows = await t.run(async (ctx) => ({
      pot: await ctx.db.query("pots")
        .withIndex("by_pot_id", (index) => index.eq("potId", ids.pot)).unique(),
      events: await ctx.db.query("events")
        .withIndex("by_pot_sequence", (index) => index.eq("potId", ids.pot)).collect(),
      profiles: await ctx.db.query("potMemberProfiles")
        .withIndex("by_pot_member", (index) => index.eq("potId", ids.pot)).collect(),
      account: await ctx.db.get(accountId),
    }));
    expect(rows).toEqual({ pot: null, events: [], profiles: [], account: null });
  });

  test("keeps money int64, enforces Core-aligned allocation and currency rules", async () => {
    const t = convexTest(schema, modules);
    await ensureOwnerSession(t);
    await expectTerminalCode(
      owner(t).mutation(promoteLocalPot, {
        ownerDisplayName: "Arseny",
        configuration: {
          ...configuration,
          currency: { code: "ZZZ", exponent: 2n },
        },
        events: [],
      }),
      "UNSUPPORTED_CURRENCY_CODE",
    );
    await expectTerminalCode(
      owner(t).mutation(promoteLocalPot, {
        ownerDisplayName: "Arseny",
        configuration: {
          ...configuration,
          currency: { code: "EUR", exponent: 3n },
        },
        events: [],
      }),
      "CURRENCY_EXPONENT_MISMATCH",
    );
    await expect(
      owner(t).mutation(promoteLocalPot, {
        ownerDisplayName: "Arseny",
        configuration,
        events: [{
          ...expense,
          payload: {
            ...expense.payload,
            content: { ...expense.payload.content, amount: { ...money(8_640n), minorUnits: 8640 } },
          },
        }],
      }),
    ).rejects.toThrow();

    const zeroAllocation = {
      ...expense,
      payload: {
        ...expense.payload,
        content: {
          ...expense.payload.content,
          allocations: [
            { unitId: ids.payer, amount: money(0n) },
            { unitId: ids.beneficiary, amount: money(8_640n) },
          ],
        },
      },
    };
    await expect(
      owner(t).mutation(promoteLocalPot, {
        ownerDisplayName: "Arseny",
        configuration,
        events: [zeroAllocation],
      }),
    ).resolves.toMatchObject({ events: [{ sequence: 1n }] });

    const stored = await t.run(async (ctx) => await ctx.db.query("events").collect());
    expect(stored[0].payload.kind).toBe("expenseAdded");
    if (stored[0].payload.kind !== "expenseAdded") throw new Error("expected expense");
    expect(stored[0].payload.content.amount.minorUnits).toBe(8_640n);
    expect(Object.hasOwn(stored[0], "authorAccountId")).toBe(false);
    expect(JSON.stringify(stored[0], (_, value) =>
      typeof value === "bigint" ? value.toString() : value,
    )).not.toContain("Unique secret grocery title");

    const badPersonal = {
      ...expense,
      eventId: id(100),
      payload: {
        ...expense.payload,
        recordId: id(101),
        content: { ...expense.payload.content, expenseKind: "personal" as const },
      },
    };
    await expectTerminalCode(
      owner(t).mutation(appendEvents, { potId: ids.pot, events: [badPersonal] }),
      "INVALID_PERSONAL_ALLOCATIONS",
    );

    const wrongCurrency = {
      ...expense,
      eventId: id(102),
      payload: {
        ...expense.payload,
        recordId: id(103),
        content: {
          ...expense.payload.content,
          amount: { minorUnits: 8_640n, currency: { code: "JPY", exponent: 0n } },
        },
      },
    };
    await expectTerminalCode(
      owner(t).mutation(appendEvents, { potId: ids.pot, events: [wrongCurrency] }),
      "CURRENCY_MISMATCH",
    );
  });

  test("bounds cumulative positive and negative contributions without computing balances", async () => {
    const maximumInt64 = (1n << 63n) - 1n;
    const minimumInt64 = -(1n << 63n);
    const t = convexTest(schema, modules);
    await ensureOwnerSession(t);
    await owner(t).mutation(promoteLocalPot, {
      ownerDisplayName: "Arseny",
      configuration,
      events: [],
    });
    const maximumExpense = {
      ...expenseRoot(id(5_000), id(5_100)),
      payload: {
        ...expense.payload,
        recordId: id(5_100),
        content: {
          ...expense.payload.content,
          amount: money(maximumInt64),
          allocations: [
            { unitId: ids.payer, amount: money(0n) },
            { unitId: ids.beneficiary, amount: money(maximumInt64) },
          ],
        },
      },
    };
    await expect(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [maximumExpense],
      }),
    ).resolves.toEqual({
      events: [{ eventId: maximumExpense.eventId, sequence: 1n }],
    });
    await expect(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [maximumExpense],
      }),
    ).resolves.toEqual({
      events: [{ eventId: maximumExpense.eventId, sequence: 1n }],
    });
    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [expenseRevision(
          id(5_002),
          id(5_100),
          { kind: "parent", parentEventId: maximumExpense.eventId },
          1n,
        )],
      }),
      "POSITIVE_CONTRIBUTION_BUDGET_EXCEEDED",
    );
    const plusOneExpense = {
      ...expenseRoot(id(5_001), id(5_101)),
      payload: {
        ...expense.payload,
        recordId: id(5_101),
        content: {
          ...expense.payload.content,
          amount: money(1n),
          allocations: [
            { unitId: ids.payer, amount: money(0n) },
            { unitId: ids.beneficiary, amount: money(1n) },
          ],
        },
      },
    };
    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [plusOneExpense],
      }),
      "POSITIVE_CONTRIBUTION_BUDGET_EXCEEDED",
    );
    const afterPositiveLimit = await owner(t).query(listEvents, {
      potId: ids.pot,
      afterSequence: 0n,
    });
    expect(afterPositiveLimit.events).toHaveLength(1);
    expect(afterPositiveLimit.nextAfterSequence).toBe(1n);

    const negative = convexTest(schema, modules);
    await ensureOwnerSession(negative);
    await owner(negative).mutation(promoteLocalPot, {
      ownerDisplayName: "Arseny",
      configuration,
      events: [],
    });
    const halfRange = 1n << 62n;
    const minimumOpening = {
      ...openingBalanceRoot(id(5_010), id(5_110)),
      payload: {
        kind: "openingBalanceSet" as const,
        recordId: id(5_110),
        content: {
          entries: [
            { unitId: ids.payer, amount: money(minimumInt64) },
            { unitId: ids.beneficiary, amount: money(halfRange) },
            { unitId: ids.thirdUnit, amount: money(halfRange) },
          ],
        },
      },
    };
    await expectTerminalCode(
      owner(negative).mutation(appendEvents, {
        potId: ids.pot,
        events: [minimumOpening],
      }),
      "POSITIVE_CONTRIBUTION_BUDGET_EXCEEDED",
    );
    expect((await owner(negative).query(listEvents, {
      potId: ids.pot,
      afterSequence: 0n,
    })).events).toHaveLength(0);

    const maximumOpening = {
      ...openingBalanceRoot(id(5_011), id(5_111)),
      payload: {
        kind: "openingBalanceSet" as const,
        recordId: id(5_111),
        content: {
          entries: [
            { unitId: ids.payer, amount: money(-maximumInt64) },
            { unitId: ids.beneficiary, amount: money(halfRange) },
            { unitId: ids.thirdUnit, amount: money(halfRange - 1n) },
          ],
        },
      },
    };
    await expect(
      owner(negative).mutation(appendEvents, {
        potId: ids.pot,
        events: [maximumOpening],
      }),
    ).resolves.toEqual({
      events: [{ eventId: maximumOpening.eventId, sequence: 1n }],
    });
    const positiveOneOpening = {
      ...openingBalanceRoot(id(5_012), id(5_112)),
      payload: {
        kind: "openingBalanceSet" as const,
        recordId: id(5_112),
        content: {
          entries: [
            { unitId: ids.payer, amount: money(-1n) },
            { unitId: ids.beneficiary, amount: money(1n) },
          ],
        },
      },
    };
    await expectTerminalCode(
      owner(negative).mutation(appendEvents, {
        potId: ids.pot,
        events: [positiveOneOpening],
      }),
      "POSITIVE_CONTRIBUTION_BUDGET_EXCEEDED",
    );
    const afterNegativeLimit = await owner(negative).query(listEvents, {
      potId: ids.pot,
      afterSequence: 0n,
    });
    expect(afterNegativeLimit.events).toHaveLength(1);
    expect(afterNegativeLimit.nextAfterSequence).toBe(1n);
  });

  test("reserves exact sign headroom for expense revisions and settlements", async () => {
    const maximumInt64 = (1n << 63n) - 1n;
    const revisionTest = convexTest(schema, modules);
    await ensureOwnerSession(revisionTest);
    await owner(revisionTest).mutation(promoteLocalPot, {
      ownerDisplayName: "Arseny",
      configuration,
      events: [],
    });
    const root = expenseRootWithAmount(
      id(7_000),
      id(7_100),
      maximumInt64 - 1n,
    );
    const revision = expenseRevision(
      id(7_001),
      id(7_100),
      { kind: "parent", parentEventId: root.eventId },
      1n,
    );
    await expect(
      owner(revisionTest).mutation(appendEvents, {
        potId: ids.pot,
        events: [root, revision],
      }),
    ).resolves.toEqual({
      events: [
        { eventId: root.eventId, sequence: 1n },
        { eventId: revision.eventId, sequence: 2n },
      ],
    });
    await expect(
      owner(revisionTest).mutation(appendEvents, {
        potId: ids.pot,
        events: [revision],
      }),
    ).resolves.toEqual({
      events: [{ eventId: revision.eventId, sequence: 2n }],
    });
    const revisionCapacity = await revisionTest.run(async (ctx) => await ctx.db
      .query("pots")
      .withIndex("by_pot_id", (index) => index.eq("potId", ids.pot))
      .unique());
    expect(revisionCapacity).toMatchObject({
      nextSequence: 3n,
      positiveContributionBudget: maximumInt64,
      negativeContributionBudget: -maximumInt64,
    });

    const settlementTest = convexTest(schema, modules);
    await ensureOwnerSession(settlementTest);
    await owner(settlementTest).mutation(promoteLocalPot, {
      ownerDisplayName: "Arseny",
      configuration,
      events: [],
    });
    const maximumSettlement = settlementRootWithAmount(
      id(7_010),
      id(7_110),
      maximumInt64,
    );
    await expect(
      owner(settlementTest).mutation(appendEvents, {
        potId: ids.pot,
        events: [maximumSettlement],
      }),
    ).resolves.toEqual({
      events: [{ eventId: maximumSettlement.eventId, sequence: 1n }],
    });
    await expect(
      owner(settlementTest).mutation(appendEvents, {
        potId: ids.pot,
        events: [maximumSettlement],
      }),
    ).resolves.toEqual({
      events: [{ eventId: maximumSettlement.eventId, sequence: 1n }],
    });
    const settlementCapacity = await settlementTest.run(async (ctx) => await ctx.db
      .query("pots")
      .withIndex("by_pot_id", (index) => index.eq("potId", ids.pot))
      .unique());
    expect(settlementCapacity).toMatchObject({
      nextSequence: 2n,
      positiveContributionBudget: maximumInt64,
      negativeContributionBudget: -maximumInt64,
    });
    await expectTerminalCode(
      owner(settlementTest).mutation(appendEvents, {
        potId: ids.pot,
        events: [settlementRootWithAmount(id(7_011), id(7_111), 1n)],
      }),
      "POSITIVE_CONTRIBUTION_BUDGET_EXCEEDED",
    );
  });

  test("rolls back an entire batch when a later event exhausts contribution capacity", async () => {
    const maximumInt64 = (1n << 63n) - 1n;
    const t = convexTest(schema, modules);
    await ensureOwnerSession(t);
    await owner(t).mutation(promoteLocalPot, {
      ownerDisplayName: "Arseny",
      configuration,
      events: [],
    });
    const existing = expenseRootWithAmount(
      id(7_020),
      id(7_120),
      maximumInt64 - 1n,
    );
    await owner(t).mutation(appendEvents, {
      potId: ids.pot,
      events: [existing],
    });
    const firstNew = expenseRootWithAmount(id(7_021), id(7_121), 1n);
    const overflowing = expenseRootWithAmount(id(7_022), id(7_122), 1n);

    await expectTerminalCode(
      owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: [firstNew, overflowing],
      }),
      "POSITIVE_CONTRIBUTION_BUDGET_EXCEEDED",
    );

    const after = await t.run(async (ctx) => {
      const pot = await ctx.db
        .query("pots")
        .withIndex("by_pot_id", (index) => index.eq("potId", ids.pot))
        .unique();
      const events = await ctx.db
        .query("events")
        .withIndex("by_pot_sequence", (index) => index.eq("potId", ids.pot))
        .collect();
      const sidecars = await ctx.db
        .query("eventTexts")
        .withIndex("by_pot_sequence", (index) => index.eq("potId", ids.pot))
        .collect();
      return { pot, events, sidecars };
    });
    expect(after.pot).toMatchObject({
      nextSequence: 2n,
      positiveContributionBudget: maximumInt64 - 1n,
      negativeContributionBudget: -(maximumInt64 - 1n),
    });
    expect(after.events.map((event) => ({
      eventId: event.eventId,
      sequence: event.sequence,
    }))).toEqual([{ eventId: existing.eventId, sequence: 1n }]);
    expect(after.sidecars).toHaveLength(2);
    expect(new Set(after.sidecars.map((sidecar) => sidecar.eventId)))
      .toEqual(new Set([existing.eventId]));
  });

  test("rejects global event UUID reuse across pots", async () => {
    const t = convexTest(schema, modules);
    await promote(t);
    const secondConfiguration = {
      ...configuration,
      potId: ids.secondPot,
    };
    const reused = {
      ...expense,
      potId: ids.secondPot,
      payload: { ...expense.payload, recordId: id(220) },
    };
    await expectTerminalCode(
      owner(t).mutation(promoteLocalPot, {
        ownerDisplayName: "Arseny",
        configuration: secondConfiguration,
        events: [reused],
      }),
      "EVENT_ID_CONFLICT",
    );
    const secondPot = await t.run(async (ctx) => await ctx.db
      .query("pots")
      .withIndex("by_pot_id", (index) => index.eq("potId", ids.secondPot))
      .unique());
    expect(secondPot).toBeNull();
  });

  test("paginates 501 events without gaps or duplicates", async () => {
    const t = convexTest(schema, modules);
    await ensureOwnerSession(t);
    await owner(t).mutation(promoteLocalPot, {
      ownerDisplayName: "Arseny",
      configuration,
      events: [],
    });
    const events = Array.from({ length: 501 }, (_, index) => expenseRoot(
      id(1_000 + index),
      id(2_000 + index),
    ));
    for (let offset = 0; offset < events.length; offset += 100) {
      await owner(t).mutation(appendEvents, {
        potId: ids.pot,
        events: events.slice(offset, offset + 100),
      });
    }

    const first = await owner(t).query(listEvents, {
      potId: ids.pot,
      afterSequence: 0n,
    });
    expect(first.events).toHaveLength(500);
    expect(first.hasMore).toBe(true);
    expect(first.nextAfterSequence).toBe(500n);
    const second = await owner(t).query(listEvents, {
      potId: ids.pot,
      afterSequence: first.nextAfterSequence,
    });
    expect(second.events).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.nextAfterSequence).toBe(501n);
    const sequences = [...first.events, ...second.events]
      .map((item: { serverSequence: bigint }) => item.serverSequence);
    expect(sequences).toEqual(Array.from({ length: 501 }, (_, index) => BigInt(index + 1)));
    expect(new Set(sequences).size).toBe(501);
  });
});

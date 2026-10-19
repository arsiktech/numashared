import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";
import type { EventInput } from "./lib/eventValidation";
import { historicalSettlementEventLimit } from "./lib/appendEvents";
import { topologyRebuildEventLimit } from "./lib/budgetGroupTopology";

const mutation = (name: string) => makeFunctionReference<"mutation">(name);
const query = (name: string) => makeFunctionReference<"query">(name);
const change = mutation("members:changeBudgetGroups");
const append = mutation("events:appendEvents");
const topologyQuery = query("members:getBudgetGroupTopology");
const id = (n: number) => `01890f5e-7b00-7000-8000-${n.toString(16).padStart(12, "0")}`;
const potId = id(1), ownerId = id(2), partnerId = id(3), neighborId = id(4);
const personal = id(101), partnerUnit = id(102), neighborUnit = id(103), coupleUnit = id(104);
const currency = { code: "EUR", exponent: 2n };
const money = (minorUnits: bigint) => ({ minorUnits, currency });
const couple = { groupId: id(201), unitId: coupleUnit, orderedMemberIds: [ownerId, partnerId], defaultShareWeight: 1n };
function event(n: number, payload: EventInput["payload"], schemaVersion = 2n, actorMemberId = ownerId): EventInput {
  const field = payload.kind === "recordVoided" ? "reason" : "recordId" in payload && payload.kind !== "recordRestored" && payload.kind !== "settlementFlagged" ? "title" : undefined;
  return { eventId: id(1_000 + n), potId, actorMemberId, occurredAtMillis: 1_700_000_000_000n + BigInt(n),
    originatingTimeZone: "Europe/Madrid", schemaVersion, payload,
    textFields: field ? [field] : [], authoredText: field ? [{ field, value: `Synthetic entry ${n}` }] : [] };
}
const groupEvent = (n = 10, groups = [couple]) => event(n, { kind: "groupChanged", groups });
function purchase(n = 20, amount = 4_000n, payer = coupleUnit, beneficiary = neighborUnit, schemaVersion = 2n) {
  return event(n, { kind: "expenseAdded", recordId: id(2_000 + n), content: {
    expenseKind: "personal", amount: money(amount), payerUnitId: payer,
    allocations: [{ unitId: beneficiary, amount: money(amount) }],
  } }, schemaVersion);
}
function repayment(n: number, amount = 4_000n, from = neighborUnit, to = coupleUnit, reversalOfRecordId?: string) {
  return event(n, { kind: "settlementRecorded", recordId: id(2_000 + n), content: {
    amount: money(amount), fromUnitId: from, toUnitId: to,
    ...(reversalOfRecordId ? { reversalOfRecordId } : {}),
  } }, 2n, neighborId);
}

beforeEach(() => {
  vi.stubEnv("NUMA_SHARED_PRODUCT", "numa-shared");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_CLASS", "anonymous-local");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_NAME", "anonymous-budget-groups-test");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
  vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
  vi.stubEnv("NUMA_SHARED_SESSION_ISSUER", "https://auth.numa.shared");
  vi.stubEnv("NUMA_SHARED_SESSION_AUDIENCE", "tech.arsik.numashared");
});
afterEach(() => vi.unstubAllEnvs());

async function fixture(bootstrap = true) {
  const t = convexTest(schema, modules);
  const accounts = await t.run(async (ctx) => {
    const result = [];
    for (const label of ["owner", "partner", "neighbor", "outsider"]) {
      const accountId = await ctx.db.insert("accounts", { publicAccountId: `synthetic-${label}`, appleSubjectHash: `synthetic-hash-${label}`, createdAt: 1 });
      await ctx.db.insert("sessions", { sessionId: `synthetic-session-${label}`, accountId,
        refreshTokenHash: `synthetic-refresh-${label}`, expiresAt: Date.now() + 86_400_000, createdAt: 1, rotatedAt: 1 });
      result.push(accountId);
    }
    return result;
  });
  const client = (label: string) => t.withIdentity({ issuer: "https://auth.numa.shared", subject: `synthetic-${label}`,
    sid: `synthetic-session-${label}`, numa_session_audience: "tech.arsik.numashared", token_use: "access" });
  const owner = client("owner"), neighbor = client("neighbor"), partner = client("partner"), outsider = client("outsider");
  if (bootstrap) {
  await owner.mutation(mutation("pots:promoteLocalPot"), { configuration: { potId, currency,
    orderedUnitIds: [personal, partnerUnit, neighborUnit], ownerMemberId: ownerId, minimumReaderSchemaVersion: 1n },
    ownerDisplayName: "Synthetic owner", events: [] });
  await owner.mutation(mutation("members:bindOwnerUnit"), { potId, event: event(1, { kind: "memberAdded", memberId: ownerId, unitId: personal, role: "owner" }, 1n) });
  for (const [n, memberId, unitId] of [[2, partnerId, partnerUnit], [3, neighborId, neighborUnit]] as const) {
    await owner.mutation(mutation("members:bindPendingMember"), { potId, displayName: `Synthetic ${n}`, event: event(n,
      { kind: "memberAdded", memberId, unitId, role: "member" }, 1n) });
  }
  // Explicit approved-neighbor fixture; the partner stays unclaimed to exercise
  // owner setup before invitation acceptance and prove grouping grants no ACL.
  await t.run(async (ctx) => {
    await ctx.db.insert("potMembers", { potId, accountId: accounts[2], memberId: neighborId, role: "member", status: "active", joinedAt: 2 });
    const profile = await ctx.db.query("potMemberProfiles").withIndex("by_pot_member", (q) => q.eq("potId", potId).eq("memberId", neighborId)).unique();
    await ctx.db.patch(profile!._id, { state: "active" });
  });
  }
  const activate = () => owner.mutation(change, { potId, expectedTopologyRevision: 3n, event: groupEvent() });
  const storedPot = () => t.run((ctx) => ctx.db.query("pots").withIndex("by_pot_id", (q) => q.eq("potId", potId)).unique());
  return { t, owner, neighbor, partner, outsider, accounts, activate, storedPot };
}

async function retireCouple(f: Awaited<ReturnType<typeof fixture>>) {
  await f.owner.mutation(mutation("members:transferOwnership"), { potId, event: event(30,
    { kind: "ownershipTransferred", fromMemberId: ownerId, toMemberId: neighborId }) });
  for (const [n, memberId] of [[31, partnerId], [32, ownerId]] as const) {
    await f.neighbor.mutation(mutation("members:archiveMember"), { potId,
      event: event(n, { kind: "memberArchived", memberId }, 2n, neighborId) });
  }
}

async function expectNoSequenceChange(f: Awaited<ReturnType<typeof fixture>>, operation: Promise<unknown>, code: string, before: bigint) {
  await expect(operation).rejects.toThrow(code);
  expect((await f.storedPot())!.nextSequence).toBe(before);
}

test("owner configures an unclaimed couple atomically without assigning accounts or renaming personal units", async () => {
  const f = await fixture();
  expect(await f.activate()).toEqual({ sequence: 4n, topologyRevision: 4n });
  const topology = await f.owner.query(topologyQuery, { potId });
  expect(topology.minimumSchemaVersion).toBe(2n);
  expect(topology.members.find((m: { memberId: string }) => m.memberId === partnerId)).toMatchObject({ personalUnitId: partnerUnit, unitId: coupleUnit, archived: false });
  expect((await f.storedPot())!.orderedUnitIds).toEqual([personal, partnerUnit, neighborUnit, coupleUnit]);
  const roster = await f.owner.query(query("members:listRoster"), { potId });
  expect(roster.find((m: { memberId: string }) => m.memberId === partnerId)).toMatchObject({ unitId: partnerUnit, budgetUnitId: coupleUnit, state: "pending" });
  for (const denied of [f.partner, f.outsider]) {
    await expect(denied.query(topologyQuery, { potId })).rejects.toThrow("NOT_MEMBER");
    await expect(denied.mutation(append, { potId, events: [purchase()] })).rejects.toThrow("NOT_MEMBER");
  }
  await expect(f.neighbor.mutation(change, { potId, expectedTopologyRevision: 4n, event: { ...groupEvent(11), actorMemberId: neighborId } })).rejects.toThrow("NOT_OWNER");
  await expect(f.owner.mutation(change, { potId, expectedTopologyRevision: 4n,
    event: { ...groupEvent(12), actorMemberId: partnerId } })).rejects.toThrow("ACTOR_MISMATCH");
});

test("groups stay at one or two people until Swift build 11 is fenced out", async () => {
  const f = await fixture();
  await f.activate();
  const household = { ...couple, orderedMemberIds: [ownerId, partnerId, neighborId] };
  await expect(f.owner.mutation(change, { potId, expectedTopologyRevision: 4n, event: groupEvent(11, [household]) }))
    .rejects.toThrow("INVALID_BUDGET_GROUP");
  await f.t.run(async (ctx) => {
    await ctx.db.insert("appConfiguration", { key: "global", minimumSupportedBuild: 11, updatedAt: 1 });
  });
  await expect(f.owner.mutation(change, { potId, expectedTopologyRevision: 4n, event: groupEvent(11, [household]) }))
    .rejects.toThrow("INVALID_BUDGET_GROUP");
});

test("a group of more than two people pays and is charged as one unit", async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    await ctx.db.insert("appConfiguration", { key: "global", minimumSupportedBuild: 12, updatedAt: 1 });
  });
  await f.activate();
  const household = { ...couple, orderedMemberIds: [ownerId, partnerId, neighborId] };
  await f.owner.mutation(change, { potId, expectedTopologyRevision: 4n, event: groupEvent(11, [household]) });
  const topology = await f.owner.query(topologyQuery, { potId });
  expect(topology.groups).toEqual([household]);
  expect(topology.members.find((m: { memberId: string }) => m.memberId === neighborId)).toMatchObject({ unitId: coupleUnit });
  const groceries = event(30, { kind: "expenseAdded", recordId: id(2030), content: { expenseKind: "shared", amount: money(3_000n),
    payerUnitId: coupleUnit, payerMemberId: neighborId, allocations: [{ unitId: coupleUnit, amount: money(3_000n) }] } });
  await f.owner.mutation(append, { potId, events: [groceries] });
  await expect(f.owner.mutation(append, { potId, events: [purchase(31, 100n, coupleUnit, neighborUnit)] })).rejects.toThrow("INACTIVE_UNIT");
});

test("exact retry retains sequence after finances; changed payload/revision and concurrent stale setup fail atomically", async () => {
  const f = await fixture();
  const first = await f.activate();
  await f.owner.mutation(append, { potId, events: [purchase()] });
  expect(await f.activate()).toEqual(first);
  const before = (await f.storedPot())!.nextSequence;
  await expectNoSequenceChange(f, f.owner.mutation(change, { potId, expectedTopologyRevision: 3n, event: groupEvent(10, []) }), "EVENT_ID_CONFLICT", before);
  await expectNoSequenceChange(f, f.owner.mutation(change, { potId, expectedTopologyRevision: 4n, event: groupEvent() }), "EVENT_ID_CONFLICT", before);
  await expectNoSequenceChange(f, f.owner.mutation(change, { potId, expectedTopologyRevision: 3n, event: groupEvent(11) }), "TOPOLOGY_REVISION_CONFLICT", before);
  await expectNoSequenceChange(f, f.owner.mutation(change, { potId, expectedTopologyRevision: 4n, event: groupEvent(12, []) }), "BUDGET_GROUPS_LOCKED", before);
  expect(await f.owner.mutation(change, { potId, expectedTopologyRevision: 4n, event: groupEvent(13) })).toMatchObject({ sequence: before });
});

test("the active original actor recovers only their exact setup receipt after transferring ownership", async () => {
  const f = await fixture();
  const receipt = await f.activate();
  await f.owner.mutation(mutation("members:transferOwnership"), { potId, event: event(13,
    { kind: "ownershipTransferred", fromMemberId: ownerId, toMemberId: neighborId }) });
  const before = await f.storedPot();
  const quota = () => f.t.run((ctx) => ctx.db.query("accountWriteQuotas")
    .withIndex("by_account_scope", (q) => q.eq("accountId", f.accounts[0]).eq("scope", "event")).collect());
  const quotaBefore = await quota();
  expect(await f.activate()).toEqual(receipt);
  expect(await f.storedPot()).toEqual(before);
  expect(await quota()).toEqual(quotaBefore);
  await expect(f.owner.mutation(change, { potId, expectedTopologyRevision: 3n,
    event: groupEvent(10, []) })).rejects.toThrow("EVENT_ID_CONFLICT");
  await expect(f.owner.mutation(change, { potId, expectedTopologyRevision: 4n,
    event: groupEvent() })).rejects.toThrow("EVENT_ID_CONFLICT");
  await expect(f.owner.mutation(change, { potId, expectedTopologyRevision: 5n,
    event: groupEvent(14) })).rejects.toThrow("NOT_OWNER");
  await expect(f.neighbor.mutation(change, { potId, expectedTopologyRevision: 3n,
    event: groupEvent() })).rejects.toThrow("ACTOR_MISMATCH");
  expect(await f.storedPot()).toEqual(before);
  expect(await quota()).toEqual(quotaBefore);
  await f.neighbor.mutation(mutation("members:archiveMember"), { potId,
    event: event(15, { kind: "memberArchived", memberId: ownerId }, 2n, neighborId) });
  await expect(f.activate()).rejects.toThrow("MEMBERSHIP_ARCHIVED");
});

test.each([
  ["oversized", [{ ...couple, orderedMemberIds: [ownerId, partnerId, neighborId, id(901), id(902), id(903), id(904)] }], "INVALID_BUDGET_GROUP"],
  ["per-person weight", [{ ...couple, defaultShareWeight: 2n }], "INVALID_BUDGET_GROUP"],
  ["unknown person", [{ ...couple, orderedMemberIds: [ownerId, id(999)] }], "UNKNOWN_GROUP_MEMBER"],
  ["personal ID reuse", [{ ...couple, unitId: personal }], "GROUP_UNIT_CONFLICTS_WITH_PERSONAL_UNIT"],
  ["overlap", [couple, { groupId: id(202), unitId: id(105), orderedMemberIds: [partnerId], defaultShareWeight: 1n }], "MEMBER_IN_MULTIPLE_GROUPS"],
] as const)("rejects %s without sequenced side effects", async (_label, groups, code) => {
  const f = await fixture();
  await expectNoSequenceChange(f, f.owner.mutation(change, { potId, expectedTopologyRevision: 3n,
    event: groupEvent(10, groups.map((group) => ({ ...group, orderedMemberIds: [...group.orderedMemberIds] }))) }), code, 4n);
});

test("retired group/unit identities cannot be rebound, and archived people cannot join new groups", async () => {
  const f = await fixture(); await f.activate();
  await f.owner.mutation(change, { potId, expectedTopologyRevision: 4n, event: groupEvent(11, []) });
  await expect(f.owner.mutation(change, { potId, expectedTopologyRevision: 5n,
    event: groupEvent(12, [{ ...couple, unitId: id(999) }]) })).rejects.toThrow("GROUP_IDENTITY_REBOUND");
  await expect(f.owner.mutation(change, { potId, expectedTopologyRevision: 5n,
    event: groupEvent(12, [{ ...couple, groupId: id(999) }]) })).rejects.toThrow("GROUP_UNIT_REASSIGNED");
  await f.owner.mutation(mutation("members:archiveMember"), { potId, event: event(13, { kind: "memberArchived", memberId: partnerId }) });
  await expect(f.owner.mutation(change, { potId, expectedTopologyRevision: 6n, event: groupEvent(14) })).rejects.toThrow("ARCHIVED_GROUP_MEMBER");
});

test("generic append never grants structural privilege or activation, and legacy retries remain valid after activation", async () => {
  const f = await fixture();
  await expect(f.owner.mutation(append, { potId, events: [groupEvent()] })).rejects.toThrow("STRUCTURAL_EVENT_NOT_AVAILABLE");
  await expect(f.owner.mutation(append, { potId, events: [purchase(20, 40n, personal)] })).rejects.toThrow("BUDGET_GROUP_ACTIVATION_REQUIRED");
  const old = purchase(21, 40n, personal, neighborUnit, 1n);
  const receipt = await f.owner.mutation(append, { potId, events: [old] });
  await expect(f.activate()).rejects.toThrow("BUDGET_GROUPS_LOCKED");
  await f.owner.mutation(change, { potId, expectedTopologyRevision: 3n, event: groupEvent(11, []) });
  expect(await f.owner.mutation(append, { potId, events: [old] })).toEqual(receipt);
  const before = (await f.storedPot())!.nextSequence;
  await expectNoSequenceChange(f, f.owner.mutation(append, { potId, events: [purchase(22, 1n, personal, neighborUnit, 1n)] }), "SCHEMA_DOWNGRADE", before);
  await expect(f.owner.mutation(mutation("members:renamePot"), { potId,
    event: event(23, { kind: "potRenamed", name: "Old writer" }, 1n) })).rejects.toThrow("SCHEMA_DOWNGRADE");
});

test("new group expenses require active units and truthful optional payer attribution; exact shares survive", async () => {
  const f = await fixture(); await f.activate();
  const paid = purchase();
  if (paid.payload.kind !== "expenseAdded") throw new Error("fixture");
  paid.payload.content.payerMemberId = partnerId;
  await f.owner.mutation(append, { potId, events: [paid] });
  const wrong = purchase(21);
  if (wrong.payload.kind !== "expenseAdded") throw new Error("fixture");
  wrong.payload.content.payerMemberId = neighborId;
  await expect(f.owner.mutation(append, { potId, events: [wrong] })).rejects.toThrow("INVALID_PAYER_MEMBER");
  await expect(f.neighbor.mutation(append, { potId, events: [repayment(99, 1n, coupleUnit, coupleUnit)] })).rejects.toThrow("IDENTICAL_SETTLEMENT_UNITS");
  const internal = purchase(22, 40n, coupleUnit, partnerUnit);
  await expect(f.owner.mutation(append, { potId, events: [internal] })).rejects.toThrow("INACTIVE_UNIT");
  await expect(f.owner.mutation(append, { potId, events: [{ ...paid, eventId: id(999), schemaVersion: 1n }] })).rejects.toThrow("PAYER_ATTRIBUTION_REQUIRES_SCHEMA_2");
  await expect(f.owner.mutation(append, { potId, events: [{ ...paid, eventId: id(999), schemaVersion: 3n }] })).rejects.toThrow("UNSUPPORTED_SCHEMA_VERSION");
  const shared = event(23, { kind: "expenseAdded", recordId: id(2023), content: { expenseKind: "shared", amount: money(12_000n),
    payerUnitId: coupleUnit, payerMemberId: ownerId, allocations: [{ unitId: coupleUnit, amount: money(6_000n) }, { unitId: neighborUnit, amount: money(6_000n) }] } });
  await f.owner.mutation(append, { potId, events: [shared] });
  const rows = await f.owner.query(query("events:listEvents"), { potId, afterSequence: 4n });
  expect(JSON.stringify(rows, (_key, value) => typeof value === "bigint" ? value.toString() : value)).toContain(partnerId);
  const invalidSum = structuredClone(shared);
  invalidSum.eventId = id(998);
  if (invalidSum.payload.kind === "expenseAdded") invalidSum.payload.content.allocations[0].amount = money(5_999n);
  await expect(f.owner.mutation(append, { potId, events: [invalidSum] })).rejects.toThrow("ALLOCATION_SUM_MISMATCH");
});

test("departure retains group debts; a second inactive zero repayment is rejected including within one atomic batch", async () => {
  const f = await fixture(); await f.activate();
  await f.owner.mutation(append, { potId, events: [purchase()] });
  await retireCouple(f);
  const before = (await f.storedPot())!.nextSequence;
  await expectNoSequenceChange(f, f.neighbor.mutation(append, { potId, events: [repayment(40), repayment(41, 1n)] }), "INACTIVE_UNIT", before);
  await f.neighbor.mutation(append, { potId, events: [repayment(42)] });
  await expect(f.neighbor.mutation(append, { potId, events: [repayment(43, 1n)] })).rejects.toThrow("INACTIVE_UNIT");
  const top = await f.neighbor.query(topologyQuery, { potId });
  expect(top.groups).toEqual([couple]);
  expect(top.members.find((m: { memberId: string }) => m.memberId === partnerId)).toMatchObject({ archived: true, unitId: coupleUnit });
  await expect(f.owner.mutation(append, { potId, events: [purchase(44)] })).rejects.toThrow("MEMBERSHIP_ARCHIVED");
});

test("historical corrections and flagged bounded reversals remain valid after departure", async () => {
  const f = await fixture(); await f.activate();
  const paid = purchase();
  await f.owner.mutation(append, { potId, events: [paid] });
  await retireCouple(f);
  const revised = event(40, { kind: "expenseRevised", recordId: id(2020), basis: { kind: "parent", parentEventId: paid.eventId },
    content: { kind: "expense", expenseKind: "personal", amount: money(5_000n), payerUnitId: coupleUnit, payerMemberId: partnerId,
      allocations: [{ unitId: neighborUnit, amount: money(5_000n) }] } }, 2n, neighborId);
  await f.neighbor.mutation(append, { potId, events: [revised, repayment(41, 5_000n),
    event(42, { kind: "settlementFlagged", recordId: id(2041) }, 2n, neighborId),
    repayment(43, 5_000n, coupleUnit, neighborUnit, id(2041))] });
  await expect(f.neighbor.mutation(append, { potId, events: [repayment(44, 1n, coupleUnit, neighborUnit, id(2041))] })).rejects.toThrow("SETTLEMENT_REVERSAL_EXCEEDS_ORIGINAL");
  const unrelated = structuredClone(revised); unrelated.eventId = id(999);
  if (unrelated.payload.kind === "expenseRevised" && unrelated.payload.content.kind === "expense") {
    unrelated.payload.content.payerUnitId = partnerUnit;
    delete unrelated.payload.content.payerMemberId;
  }
  await expect(f.neighbor.mutation(append, { potId, events: [unrelated] })).rejects.toThrow("INACTIVE_UNIT");
});

test("projection loss rebuilds the same durable topology/history lock without changing personal profiles", async () => {
  const f = await fixture(); await f.activate();
  await f.owner.mutation(append, { potId, events: [purchase(), event(21, { kind: "recordVoided", recordId: id(2020) })] });
  await retireCouple(f);
  const original = await f.neighbor.query(topologyQuery, { potId });
  await f.t.run(async (ctx) => { const pot = await ctx.db.query("pots").withIndex("by_pot_id", (q) => q.eq("potId", potId)).unique();
    await ctx.db.patch(pot!._id, { budgetGroupTopology: undefined }); });
  expect(await f.neighbor.query(topologyQuery, { potId })).toEqual(original);
  await expect(f.neighbor.mutation(change, { potId, expectedTopologyRevision: original.revision,
    event: { ...groupEvent(40, []), actorMemberId: neighborId } })).rejects.toThrow("BUDGET_GROUPS_LOCKED");
});

test("account deletion emits schema-2 structural events and erases names without redirecting group debt", async () => {
  const f = await fixture(); await f.activate();
  await f.owner.mutation(append, { potId, events: [purchase()] });
  await f.t.run((ctx) => ctx.db.patch(f.accounts[0], { deletionStartedAt: 1 }));
  await f.t.mutation(mutation("accountDeletion:processNextPot"), { accountId: f.accounts[0],
    transferEventId: id(900), archiveEventId: id(901), originatingTimeZone: "Europe/Madrid", now: Date.now() });
  const topology = await f.neighbor.query(topologyQuery, { potId });
  expect(topology.members.find((m: { memberId: string }) => m.memberId === ownerId)).toMatchObject({ unitId: coupleUnit, archived: true });
  const erased = await f.t.run((ctx) => ctx.db.query("potMemberProfiles").withIndex("by_pot_member", (q) => q.eq("potId", potId).eq("memberId", ownerId)).unique());
  expect(erased!.displayName).toBeUndefined();
  const structural = await f.t.run((ctx) => ctx.db.query("events").withIndex("by_pot_sequence", (q) => q.eq("potId", potId).gte("sequence", 6n)).collect());
  expect(structural.map((row) => row.schemaVersion)).toEqual([2n, 2n]);
  await expect(f.owner.query(topologyQuery, { potId })).rejects.toThrow("AUTH_SESSION_REVOKED");
});

test("bounded inactive-settlement predicate fails closed rather than sequencing uncertain money", async () => {
  const f = await fixture(); await f.activate(); await f.owner.mutation(append, { potId, events: [purchase()] });
  await retireCouple(f);
  await f.t.run(async (ctx) => {
    for (let i = 0; i < historicalSettlementEventLimit; i++) {
      await ctx.db.insert("events", { potId, eventId: id(10_000 + i), actorMemberId: neighborId, occurredAtMillis: BigInt(i),
        originatingTimeZone: "Europe/Madrid", schemaVersion: 2n, sequence: BigInt(100 + i),
        payload: { kind: "potRenamed", name: "Synthetic bounded-history fixture" }, textFields: [], createdAt: i });
    }
  });
  const before = (await f.storedPot())!.nextSequence;
  await expectNoSequenceChange(f, f.neighbor.mutation(append, { potId, events: [repayment(40)] }), "HISTORICAL_SETTLEMENT_VALIDATION_LIMIT", before);
});

test("oversized missing structural projection is explicitly unavailable, not partially rebuilt", async () => {
  const f = await fixture();
  await f.t.run(async (ctx) => {
    for (let i = 0; i < topologyRebuildEventLimit; i++) {
      await ctx.db.insert("events", { potId, eventId: id(20_000 + i), actorMemberId: ownerId, occurredAtMillis: BigInt(i),
        originatingTimeZone: "Europe/Madrid", schemaVersion: 1n, sequence: BigInt(100 + i),
        payload: { kind: "potRenamed", name: "Synthetic bounded topology fixture" }, textFields: [], createdAt: i });
    }
  });
  await expect(f.activate()).rejects.toThrow("TOPOLOGY_REBUILD_LIMIT");
});


test.each(["opening", "repayment"] as const)("%s alone locks setup even without expenses", async (kind) => {
  const f = await fixture(); await f.activate();
  const first = kind === "opening" ? event(50, { kind: "openingBalanceSet", recordId: id(2050),
    content: { entries: [{ unitId: coupleUnit, amount: money(100n) }, { unitId: neighborUnit, amount: money(-100n) }] } })
    : { ...repayment(50, 100n), actorMemberId: ownerId };
  await f.owner.mutation(append, { potId, events: [first] });
  await expect(f.owner.mutation(change, { potId, expectedTopologyRevision: 4n, event: groupEvent(51, []) })).rejects.toThrow("BUDGET_GROUPS_LOCKED");
});

test("unchanged valid legacy group cardinality and weights are not retroactively rejected", async () => {
  const f = await fixture();
  const legacy = { ...couple, orderedMemberIds: [ownerId, partnerId, neighborId], defaultShareWeight: 3n };
  await f.t.run(async (ctx) => {
    const pot = await ctx.db.query("pots").withIndex("by_pot_id", (q) => q.eq("potId", potId)).unique();
    await ctx.db.insert("events", { potId, eventId: id(777), actorMemberId: ownerId, occurredAtMillis: 1n,
      originatingTimeZone: "Europe/Madrid", schemaVersion: 1n, sequence: 4n,
      payload: { kind: "groupChanged", groups: [legacy] }, textFields: [], createdAt: 1 });
    await ctx.db.patch(pot!._id, { nextSequence: 5n, orderedUnitIds: [...pot!.orderedUnitIds, coupleUnit] });
  });
  await f.owner.mutation(change, { potId, expectedTopologyRevision: 4n, event: groupEvent(10, [legacy]) });
  expect((await f.owner.query(topologyQuery, { potId })).groups).toEqual([legacy]);
});


test("an exact legacy receipt is still available when the newer topology needs recovery", async () => {
  const f = await fixture();
  const old = purchase(20, 40n, personal, neighborUnit, 1n);
  const receipt = await f.owner.mutation(append, { potId, events: [old] });
  await f.owner.mutation(change, { potId, expectedTopologyRevision: 3n, event: groupEvent(11, []) });
  await f.t.run(async (ctx) => {
    const pot = await ctx.db.query("pots").withIndex("by_pot_id", (q) => q.eq("potId", potId)).unique();
    await ctx.db.patch(pot!._id, { budgetGroupTopology: { ...pot!.budgetGroupTopology!, minimumSchemaVersion: 3n } });
  });
  expect(await f.owner.mutation(append, { potId, events: [old] })).toEqual(receipt);
  await expect(f.owner.mutation(append, { potId, events: [purchase(21, 40n, personal)] })).rejects.toThrow("TOPOLOGY_PROJECTION_INCOMPATIBLE");
});


function typedPromotion(events: EventInput[], startingSequence = 1n) {
  return {
    configuration: { potId, currency, orderedUnitIds: [personal, partnerUnit, neighborUnit],
      ownerMemberId: ownerId, minimumReaderSchemaVersion: 1n },
    ownerDisplayName: "Synthetic owner", events,
    budgetGroupPromotion: { ownerBindingEventId: id(1_001), startingSequence,
      members: [{ memberId: ownerId, displayName: "Synthetic owner" },
        { memberId: partnerId, displayName: "Synthetic partner" },
        { memberId: neighborId, displayName: "Synthetic neighbor" }] },
  };
}
function bootstrapPrefix() {
  return [event(0, { kind: "potRenamed", name: "Synthetic household" }, 1n),
    event(1, { kind: "memberAdded", memberId: ownerId, unitId: personal, role: "owner" }, 1n),
    event(2, { kind: "memberAdded", memberId: partnerId, unitId: partnerUnit, role: "member" }, 1n),
    event(3, { kind: "memberAdded", memberId: neighborId, unitId: neighborUnit, role: "member" }, 1n), groupEvent()];
}

test("typed promotion atomically orders original prerequisites before money and retries exact receipts", async () => {
  const f = await fixture(false);
  const paid = purchase();
  if (paid.payload.kind === "expenseAdded") paid.payload.content.payerMemberId = partnerId;
  const request = typedPromotion([...bootstrapPrefix(), paid]);
  const result = await f.owner.mutation(mutation("pots:promoteLocalPot"), request);
  expect(result.events).toEqual(request.events.map((e, i) => ({ eventId: e.eventId, sequence: BigInt(i + 1) })));
  const before = await f.storedPot();
  const quotas = await f.t.run((ctx) => ctx.db.query("accountWriteQuotas").collect());
  expect(quotas.find((q) => q.scope === "event")?.count).toBe(6n);
  const discovered = await f.owner.query(query("pots:listMyPots"), {});
  expect(discovered[0]).toMatchObject({ initialOrderedUnitIds: [personal, partnerUnit, neighborUnit],
    orderedUnitIds: [personal, partnerUnit, neighborUnit, coupleUnit] });
  expect(await f.owner.mutation(mutation("pots:promoteLocalPot"), request)).toEqual(result);
  expect(await f.storedPot()).toEqual(before);
  expect(await f.t.run((ctx) => ctx.db.query("accountWriteQuotas").collect())).toEqual(quotas);
  const stored = await f.t.run((ctx) => ctx.db.query("events").withIndex("by_pot_sequence", (q) => q.eq("potId", potId)).collect());
  expect(stored.map((e) => e.payload)).toEqual(request.events.map((e) => e.payload));
  const roster = await f.owner.query(query("members:listRoster"), { potId });
  expect(roster.find((p: { memberId: string }) => p.memberId === partnerId)).toMatchObject({ unitId: partnerUnit, budgetUnitId: coupleUnit, state: "pending" });
  await expect(f.partner.query(topologyQuery, { potId })).rejects.toThrow("NOT_MEMBER");
  for (const units of [[personal, partnerUnit], [personal, partnerUnit, neighborUnit, coupleUnit]]) {
    await expect(f.owner.mutation(mutation("pots:promoteLocalPot"), {
      ...request, configuration: { ...request.configuration, orderedUnitIds: units },
    })).rejects.toThrow("PROMOTION_CONFLICT");
  }
  const changed = typedPromotion([...bootstrapPrefix(), purchase(20, 4_001n)]);
  await expect(f.owner.mutation(mutation("pots:promoteLocalPot"), changed)).rejects.toThrow("EVENT_ID_CONFLICT");
  expect(await f.storedPot()).toEqual(before);
});

test("typed promotion resumes a partial prefix without regenerating identities or resurrecting erased names", async () => {
  const f = await fixture(false);
  const first = typedPromotion(bootstrapPrefix());
  await f.owner.mutation(mutation("pots:promoteLocalPot"), first);
  await f.owner.mutation(mutation("members:anonymizePendingMember"), { potId, memberId: partnerId });
  // Lost acknowledgement retry after profile erasure must not put its old name back.
  await f.owner.mutation(mutation("pots:promoteLocalPot"), first);
  const next = typedPromotion([purchase()], 6n);
  const result = await f.owner.mutation(mutation("pots:promoteLocalPot"), next);
  expect(result.events).toEqual([{ eventId: purchase().eventId, sequence: 6n }]);
  expect(await f.owner.mutation(mutation("pots:promoteLocalPot"), next)).toEqual(result);
  const roster = await f.owner.query(query("members:listRoster"), { potId });
  expect(roster.find((p: { memberId: string }) => p.memberId === partnerId).displayName).toBeNull();
  await expect(f.owner.mutation(mutation("pots:promoteLocalPot"), typedPromotion([purchase(21)], 6n))).rejects.toThrow("PROMOTION_SEQUENCE_CONFLICT");
  expect((await f.storedPot())!.nextSequence).toBe(7n);
});

test("typed promotion missing activation or invalid money rolls back every prerequisite and account claim", async () => {
  const f = await fixture(false);
  await expect(f.owner.mutation(mutation("pots:promoteLocalPot"), typedPromotion(bootstrapPrefix().slice(0, 4)))).rejects.toThrow("PROMOTION_PREREQUISITES_REQUIRED");
  expect(await f.storedPot()).toBeNull();
  await expect(f.owner.mutation(mutation("pots:promoteLocalPot"), typedPromotion([...bootstrapPrefix(), purchase(20, 4_000n, personal)]))).rejects.toThrow("INACTIVE_UNIT");
  expect(await f.storedPot()).toBeNull();
  expect(await f.t.run((ctx) => ctx.db.query("potMembers").collect())).toEqual([]);
});

import type { Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { budgetGroupTopologyValidator } from "../model";
import { fail } from "./access";
import { canonicalValue, type EventInput } from "./eventValidation";
import type { FinancialRecordState } from "./financialRecordState";

export type BudgetGroupTopology = Infer<typeof budgetGroupTopologyValidator>;
type Group = BudgetGroupTopology["groups"][number];
const structuralKinds = [
  "memberAdded", "memberClaimed", "memberClaimReassigned", "memberArchived",
  "ownershipTransferred", "groupChanged", "presetChanged", "potRenamed", "potArchived",
] as const;
export const topologyRebuildEventLimit = 1_024;

/** Bounded replay reads only structural history plus existence of financial roots.
 * Missing/oversized projections fail closed; financial rows never become balances here. */
export async function loadBudgetGroupTopology(
  ctx: QueryCtx | MutationCtx,
  pot: Doc<"pots">,
): Promise<BudgetGroupTopology> {
  if (pot.budgetGroupTopology) {
    const cached = pot.budgetGroupTopology;
    if ((cached.minimumSchemaVersion !== 1n && cached.minimumSchemaVersion !== 2n)
      || cached.minimumSchemaVersion !== pot.minimumReaderSchemaVersion || cached.revision < 0n) {
      fail("TOPOLOGY_PROJECTION_INCOMPATIBLE");
    }
    return structuredClone(cached);
  }
  const events: Doc<"events">[] = [];
  for (const kind of structuralKinds) {
    const rows = await ctx.db.query("events")
      .withIndex("by_pot_kind", (q) => q.eq("potId", pot.potId).eq("payload.kind", kind))
      .take(topologyRebuildEventLimit + 1 - events.length);
    events.push(...rows);
    if (events.length > topologyRebuildEventLimit) fail("TOPOLOGY_REBUILD_LIMIT");
  }
  events.sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0);
  let topology: BudgetGroupTopology = {
    revision: 0n, minimumSchemaVersion: 1n, hasFinancialHistory: false,
    members: [], groups: [], groupUnitBindings: [],
  };
  for (const event of events) {
    topology = applyStructuralTopology(topology, event, event.sequence, pot.orderedUnitIds, true);
  }
  for (const kind of ["expenseAdded", "openingBalanceSet", "settlementRecorded"] as const) {
    if (await ctx.db.query("events")
      .withIndex("by_pot_kind", (q) => q.eq("potId", pot.potId).eq("payload.kind", kind)).first()) {
      topology.hasFinancialHistory = true;
      break;
    }
  }
  topology.minimumSchemaVersion = pot.minimumReaderSchemaVersion;
  if (topology.minimumSchemaVersion !== 1n && topology.minimumSchemaVersion !== 2n) {
    fail("UNSUPPORTED_READER_SCHEMA");
  }
  return topology;
}

export function activeBudgetUnitIds(topology: BudgetGroupTopology, known: readonly string[]): Set<string> {
  const managed = new Set([
    ...topology.members.map((member) => member.personalUnitId),
    ...topology.groupUnitBindings.map((binding) => binding.unitId),
  ]);
  return new Set([
    ...known.filter((unit) => !managed.has(unit)),
    ...topology.members.filter((member) => !member.archived).map((member) => member.unitId),
  ]);
}

export function projectedUnitId(topology: BudgetGroupTopology, unitId: string): string {
  const member = topology.members.find((candidate) => candidate.personalUnitId === unitId);
  return member && (topology.minimumSchemaVersion >= 2n || !member.archived) ? member.unitId : unitId;
}

/** People who pay as one: a single person, a couple, a family, up to six people. */
export const maximumBudgetGroupSize = 6;

function validateGroups(groups: Group[], topology: BudgetGroupTopology, known: readonly string[], schema: bigint): void {
  if (groups.length > 64) fail("TOO_MANY_GROUPS");
  const groupIds = new Set<string>();
  const unitIds = new Set<string>();
  const memberIds = new Set<string>();
  for (const group of groups) {
    const unchanged = topology.groups.some((old) => canonicalValue(old) === canonicalValue(group));
    if (schema === 2n && !unchanged
      && (group.orderedMemberIds.length < 1 || group.orderedMemberIds.length > maximumBudgetGroupSize
        || group.defaultShareWeight !== 1n)) {
      fail("INVALID_BUDGET_GROUP");
    }
    if (group.defaultShareWeight <= 0n) fail("INVALID_GROUP_SHARE_WEIGHT");
    if (groupIds.has(group.groupId)) fail("DUPLICATE_GROUP_ID");
    if (unitIds.has(group.unitId)) fail("DUPLICATE_GROUP_UNIT_ID");
    groupIds.add(group.groupId); unitIds.add(group.unitId);
    if (topology.members.some((member) => member.personalUnitId === group.unitId)) fail("GROUP_UNIT_CONFLICTS_WITH_PERSONAL_UNIT");
    const binding = topology.groupUnitBindings.find((item) => item.groupId === group.groupId);
    if (binding && binding.unitId !== group.unitId) fail("GROUP_IDENTITY_REBOUND");
    const priorGroup = topology.groupUnitBindings.find((item) => item.unitId === group.unitId);
    if (priorGroup && priorGroup.groupId !== group.groupId) fail("GROUP_UNIT_REASSIGNED");
    if (!binding && known.includes(group.unitId)) fail("KNOWN_UNIT_REUSED_AS_GROUP");
    for (const memberId of group.orderedMemberIds) {
      const member = topology.members.find((item) => item.memberId === memberId);
      if (!member) fail("UNKNOWN_GROUP_MEMBER");
      if (member.archived) fail("ARCHIVED_GROUP_MEMBER");
      if (memberIds.has(memberId)) fail("MEMBER_IN_MULTIPLE_GROUPS");
      memberIds.add(memberId);
    }
  }
  if (new Set([...known, ...groups.map((group) => group.unitId)]).size > 64) fail("TOO_MANY_UNITS");
}

export function applyStructuralTopology(
  source: BudgetGroupTopology,
  event: Pick<EventInput, "schemaVersion" | "payload">,
  sequence: bigint,
  knownUnits: readonly string[],
  rebuilding = false,
): BudgetGroupTopology {
  const topology = structuredClone(source);
  if (event.schemaVersion < topology.minimumSchemaVersion) fail("SCHEMA_DOWNGRADE");
  if (event.schemaVersion !== 1n && event.schemaVersion !== 2n) fail("UNSUPPORTED_SCHEMA_VERSION");
  topology.minimumSchemaVersion = event.schemaVersion;
  topology.revision = sequence;
  const payload = event.payload;
  if (payload.kind === "memberAdded") {
    if (topology.members.some((member) => member.memberId === payload.memberId)) fail("MEMBER_ALREADY_EXISTS");
    if (topology.members.some((member) => member.personalUnitId === payload.unitId)
      || topology.groupUnitBindings.some((group) => group.unitId === payload.unitId)) fail("UNIT_ALREADY_BOUND");
    if (topology.members.length >= 64) fail("TOO_MANY_MEMBERS");
    topology.members.push({ memberId: payload.memberId, personalUnitId: payload.unitId, unitId: payload.unitId, archived: false });
  } else if (payload.kind === "memberArchived") {
    const member = topology.members.find((item) => item.memberId === payload.memberId);
    // Legacy server owners can exist before their individual unit is bound.
    if (!member) { if (!rebuilding) fail("UNKNOWN_MEMBER"); return topology; }
    if (member.archived && !rebuilding) fail("MEMBER_ALREADY_ARCHIVED");
    member.archived = true;
    if (event.schemaVersion === 1n) {
      member.unitId = member.personalUnitId;
      topology.groups = topology.groups.flatMap((group) => {
        const orderedMemberIds = group.orderedMemberIds.filter((id) => id !== member.memberId);
        return orderedMemberIds.length ? [{ ...group, orderedMemberIds }] : [];
      });
    }
  } else if (payload.kind === "groupChanged") {
    if (canonicalValue(payload.groups) === canonicalValue(topology.groups)) return topology;
    if (!rebuilding && topology.hasFinancialHistory && event.schemaVersion === 2n) fail("BUDGET_GROUPS_LOCKED");
    if (!rebuilding) validateGroups(payload.groups, topology, knownUnits, event.schemaVersion);
    for (const member of topology.members) member.unitId = member.personalUnitId;
    for (const group of payload.groups) {
      for (const memberId of group.orderedMemberIds) {
        const member = topology.members.find((item) => item.memberId === memberId);
        if (!member) fail("UNKNOWN_GROUP_MEMBER");
        member.unitId = group.unitId;
      }
      const existing = topology.groupUnitBindings.find((item) => item.groupId === group.groupId);
      if (!existing) topology.groupUnitBindings.push({ groupId: group.groupId, unitId: group.unitId });
      else if (existing.unitId !== group.unitId) fail("GROUP_IDENTITY_REBOUND");
    }
    topology.groups = structuredClone(payload.groups);
  }
  return topology;
}

export function historicalRevisionUnits(state: FinancialRecordState): Set<string> {
  const units = new Set<string>();
  for (const revision of state.revisions.values()) {
    const content = revision.payload.content;
    if ("payerUnitId" in content) {
      units.add(content.payerUnitId);
      for (const allocation of content.allocations) units.add(allocation.unitId);
    } else {
      for (const entry of content.entries) units.add(entry.unitId);
    }
  }
  return units;
}

export function validateBudgetFinancialUnits(
  event: EventInput,
  topology: BudgetGroupTopology,
  knownUnits: readonly string[],
  record: FinancialRecordState | undefined,
): void {
  const active = activeBudgetUnitIds(topology, knownUnits);
  const payload = event.payload;
  if (payload.kind !== "expenseAdded" && payload.kind !== "expenseRevised" && payload.kind !== "openingBalanceSet") return;
  const eligible = payload.kind === "expenseRevised" && record
    ? new Set([...active, ...historicalRevisionUnits(record)]) : active;
  const content = payload.content;
  const units = "payerUnitId" in content
    ? [content.payerUnitId, ...content.allocations.map((allocation) => allocation.unitId)]
    : content.entries.map((entry) => entry.unitId);
  for (const unit of units) if (!eligible.has(unit)) fail("INACTIVE_UNIT");
  if ("payerMemberId" in content && content.payerMemberId !== undefined && "payerUnitId" in content) {
    const member = topology.members.find((item) => item.memberId === content.payerMemberId);
    if (!member) fail("INVALID_PAYER_MEMBER");
    if (payload.kind === "expenseAdded") {
      if (member.archived || member.unitId !== content.payerUnitId) fail("INVALID_PAYER_MEMBER");
    } else {
      const historicalPayer = record && [...record.revisions.values()].some((revision) =>
        "payerUnitId" in revision.payload.content && revision.payload.content.payerUnitId === content.payerUnitId);
      if (member.unitId !== content.payerUnitId
        && !(member.personalUnitId === content.payerUnitId && historicalPayer)) fail("INVALID_PAYER_MEMBER");
    }
  }
}

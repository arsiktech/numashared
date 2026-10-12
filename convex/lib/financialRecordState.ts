import type { Doc } from "../_generated/dataModel";
import { fail } from "./access";
import type { EventInput } from "./eventValidation";

type FinancialRootKind = "expense" | "openingBalance" | "settlement";
type FinancialEvent = Pick<EventInput, "eventId" | "actorMemberId" | "payload">;
type StoredFinancialEvent = Pick<
  Doc<"events">,
  "eventId" | "recordId" | "actorMemberId" | "sequence" | "payload"
>;

type Revision = {
  actorMemberId: string;
  order: number;
  payload: Extract<
    EventInput["payload"],
    { kind: "expenseAdded" | "openingBalanceSet" | "expenseRevised" }
  >;
};

export type FinancialRecordState = {
  rootKind?: FinancialRootKind;
  revisionEventIds: Set<string>;
  revisions: Map<string, Revision>;
  heads: Set<string>;
  resolvedContests: Map<string, string>;
  settlement?: Extract<EventInput["payload"], { kind: "settlementRecorded" }>;
  isFlagged: boolean;
  isVoided: boolean;
  nextOrder: number;
};

export function financialRecordId(
  event: Pick<EventInput, "payload">,
): string | undefined {
  switch (event.payload.kind) {
    case "expenseAdded":
    case "expenseRevised":
    case "recordVoided":
    case "recordRestored":
    case "settlementRecorded":
    case "settlementFlagged":
    case "openingBalanceSet":
      return event.payload.recordId;
    default:
      return undefined;
  }
}

function createFinancialRecordState(): FinancialRecordState {
  return {
    revisionEventIds: new Set(),
    revisions: new Map(),
    heads: new Set(),
    resolvedContests: new Map(),
    isFlagged: false,
    isVoided: false,
    nextOrder: 0,
  };
}

function financialRootKind(
  event: Pick<EventInput, "payload">,
): FinancialRootKind | undefined {
  switch (event.payload.kind) {
    case "expenseAdded":
      return "expense";
    case "openingBalanceSet":
      return "openingBalance";
    case "settlementRecorded":
      return "settlement";
    default:
      return undefined;
  }
}

function revisionPairKey(firstEventId: string, secondEventId: string): string {
  return `${firstEventId}:${secondEventId}`;
}

function requireRevisableRecord(
  state: FinancialRecordState,
): Exclude<FinancialRootKind, "settlement"> {
  if (state.rootKind === undefined) fail("MISSING_RECORD");
  if (state.rootKind === "settlement") fail("IMMUTABLE_SETTLEMENT");
  return state.rootKind;
}

export function applyFinancialEventState(
  state: FinancialRecordState,
  event: FinancialEvent,
): void {
  const recordId = financialRecordId(event);
  if (recordId === undefined) return;

  const rootKind = financialRootKind(event);
  if (rootKind !== undefined) {
    if (state.rootKind !== undefined) fail("DUPLICATE_RECORD");
    state.rootKind = rootKind;
    if (event.payload.kind === "settlementRecorded") {
      state.settlement = event.payload;
    } else if (
      event.payload.kind === "expenseAdded"
      || event.payload.kind === "openingBalanceSet"
    ) {
      state.revisionEventIds.add(event.eventId);
      state.heads.add(event.eventId);
      state.revisions.set(event.eventId, {
        actorMemberId: event.actorMemberId,
        order: state.nextOrder,
        payload: event.payload,
      });
    }
    state.nextOrder += 1;
    return;
  }

  switch (event.payload.kind) {
    case "expenseRevised": {
      const existingKind = requireRevisableRecord(state);
      if (existingKind !== event.payload.content.kind) fail("RECORD_KIND_CHANGED");
      if (event.payload.basis.kind === "parent") {
        const parentEventId = event.payload.basis.parentEventId;
        if (!state.revisionEventIds.has(parentEventId)) fail("UNKNOWN_REVISION");
        state.heads.delete(parentEventId);
        state.heads.add(event.eventId);
        for (const [pair, resolutionEventId] of state.resolvedContests) {
          if (resolutionEventId === parentEventId) {
            state.resolvedContests.set(pair, event.eventId);
          }
        }
      } else {
        const { firstEventId, secondEventId } = event.payload.basis;
        if (
          !state.revisionEventIds.has(firstEventId)
          || !state.revisionEventIds.has(secondEventId)
        ) {
          fail("INVALID_RESOLUTION");
        }
        const pair = revisionPairKey(firstEventId, secondEventId);
        if (state.heads.has(firstEventId) && state.heads.has(secondEventId)) {
          state.heads.delete(firstEventId);
          state.heads.delete(secondEventId);
        } else {
          const priorResolutionEventId = state.resolvedContests.get(pair);
          if (priorResolutionEventId === undefined) fail("INVALID_RESOLUTION");
          state.heads.delete(priorResolutionEventId);
        }
        state.heads.add(event.eventId);
        state.resolvedContests.set(pair, event.eventId);
      }
      state.revisionEventIds.add(event.eventId);
      state.revisions.set(event.eventId, {
        actorMemberId: event.actorMemberId,
        order: state.nextOrder,
        payload: event.payload,
      });
      state.nextOrder += 1;
      return;
    }
    case "recordVoided":
      requireRevisableRecord(state);
      state.isVoided = true;
      state.nextOrder += 1;
      return;
    case "recordRestored":
      requireRevisableRecord(state);
      state.isVoided = false;
      state.nextOrder += 1;
      return;
    case "settlementFlagged":
      if (state.rootKind === undefined) fail("MISSING_RECORD");
      if (state.rootKind !== "settlement") fail("NON_SETTLEMENT_FLAG_TARGET");
      state.isFlagged = true;
      state.nextOrder += 1;
      return;
    default:
      return;
  }
}

export function buildFinancialRecordState(
  events: readonly FinancialEvent[],
): FinancialRecordState {
  const state = createFinancialRecordState();
  for (const event of events) applyFinancialEventState(state, event);
  return state;
}

function addContribution(
  contributions: Map<string, bigint>,
  unitId: string,
  value: bigint,
): void {
  contributions.set(unitId, (contributions.get(unitId) ?? 0n) + value);
}

export type FinancialEventContribution = {
  units: Map<string, bigint>;
  spend: bigint;
};

function expenseContribution(content: {
  amount: { minorUnits: bigint };
  payerUnitId: string;
  allocations: readonly { unitId: string; amount: { minorUnits: bigint } }[];
}): FinancialEventContribution {
  const units = new Map<string, bigint>();
  addContribution(units, content.payerUnitId, content.amount.minorUnits);
  for (const allocation of content.allocations) {
    addContribution(units, allocation.unitId, -allocation.amount.minorUnits);
  }
  return { units, spend: content.amount.minorUnits };
}

function openingBalanceContribution(content: {
  entries: readonly { unitId: string; amount: { minorUnits: bigint } }[];
}): FinancialEventContribution {
  const units = new Map<string, bigint>();
  for (const entry of content.entries) {
    addContribution(units, entry.unitId, entry.amount.minorUnits);
  }
  return { units, spend: 0n };
}

export function financialEventContribution(
  payload: EventInput["payload"],
): FinancialEventContribution | null {
  if (payload.kind === "expenseAdded") {
    return expenseContribution(payload.content);
  }
  if (payload.kind === "openingBalanceSet") {
    return openingBalanceContribution(payload.content);
  }
  if (payload.kind === "settlementRecorded") {
    const units = new Map<string, bigint>();
    addContribution(
      units,
      payload.content.fromUnitId,
      payload.content.amount.minorUnits,
    );
    addContribution(
      units,
      payload.content.toUnitId,
      -payload.content.amount.minorUnits,
    );
    return { units, spend: 0n };
  }
  if (payload.kind !== "expenseRevised") return null;
  return payload.content.kind === "expense"
    ? expenseContribution(payload.content)
    : openingBalanceContribution(payload.content);
}

export function currentContribution(state: FinancialRecordState): Map<string, bigint> {
  if (state.rootKind === "settlement" && state.settlement) {
    return financialEventContribution(state.settlement)?.units ?? new Map();
  }
  if (state.isVoided) return new Map();
  let applied: Revision | undefined;
  for (const eventId of state.heads) {
    const revision = state.revisions.get(eventId);
    if (revision && (!applied || revision.order > applied.order)) applied = revision;
  }
  return applied
    ? financialEventContribution(applied.payload)?.units ?? new Map()
    : new Map();
}

function eventsThroughTrigger(
  events: readonly StoredFinancialEvent[],
  triggeringEventId: string,
): { trigger: StoredFinancialEvent; events: StoredFinancialEvent[] } | null {
  const trigger = events.find((event) => event.eventId === triggeringEventId);
  if (!trigger?.recordId) return null;
  return {
    trigger,
    events: [...events]
      .filter((event) =>
        event.recordId === trigger.recordId && event.sequence <= trigger.sequence,
      )
      .sort((left, right) => left.sequence < right.sequence ? -1 : 1),
  };
}

export function financialTransitionAffectedUnitIds(
  events: readonly StoredFinancialEvent[],
  triggeringEventId: string,
): string[] | null {
  const through = eventsThroughTrigger(events, triggeringEventId);
  if (!through) return null;
  const state = createFinancialRecordState();
  let before: Map<string, bigint> | undefined;
  let after: Map<string, bigint> | undefined;
  for (const event of through.events) {
    if (event.eventId === triggeringEventId) before = currentContribution(state);
    applyFinancialEventState(state, event);
    if (event.eventId === triggeringEventId) {
      after = currentContribution(state);
      break;
    }
  }
  if (!before || !after) return null;
  const units = new Set([...before.keys(), ...after.keys()]);
  return [...units]
    .filter((unitId) => (before?.get(unitId) ?? 0n) !== (after?.get(unitId) ?? 0n))
    .sort();
}

export function contestedHeadAuthorMemberIds(
  events: readonly StoredFinancialEvent[],
  triggeringEventId: string,
): string[] | null {
  const through = eventsThroughTrigger(events, triggeringEventId);
  if (
    !through
    || through.trigger.payload.kind !== "expenseRevised"
    || through.trigger.payload.basis.kind !== "parent"
  ) {
    return null;
  }
  const state = buildFinancialRecordState(through.events);
  if (state.heads.size < 2) return null;
  return [...new Set([...state.heads].flatMap((eventId) => {
    const author = state.revisions.get(eventId)?.actorMemberId;
    return author ? [author] : [];
  }))].sort();
}

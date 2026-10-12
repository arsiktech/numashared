import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { EventInput, PotConfigurationInput, TextField } from "./eventValidation";
import { canonicalValue, validateEvent } from "./eventValidation";
import { fail } from "./access";
import {
  consumeAccountWriteQuota,
  eventWriteLimitPerHour,
} from "./accountWriteQuota";
import {
  applyFinancialEventState,
  buildFinancialRecordState,
  currentContribution,
  financialEventContribution,
  financialRecordId,
  type FinancialRecordState,
} from "./financialRecordState";

import {
  activeBudgetUnitIds,
  loadBudgetGroupTopology,
  projectedUnitId,
  validateBudgetFinancialUnits,
  type BudgetGroupTopology,
} from "./budgetGroupTopology";

export const historicalSettlementEventLimit = 2_048;

function requireP2EventKind(event: Pick<EventInput, "payload">): void {
  switch (event.payload.kind) {
    case "memberAdded":
    case "memberClaimed":
    case "memberClaimReassigned":
    case "memberArchived":
    case "ownershipTransferred":
    case "groupChanged":
    case "presetChanged":
    case "potRenamed":
    case "potArchived":
      fail("STRUCTURAL_EVENT_NOT_AVAILABLE");
    default:
      return;
  }
}

type ContributionBudget = { positive: bigint; negative: bigint };

const minimumInt64 = -(1n << 63n);
const maximumInt64 = (1n << 63n) - 1n;

function contributionTotals(
  contributions: Map<string, bigint>,
  positiveFloor = 0n,
): ContributionBudget {
  let positive = 0n;
  let negative = 0n;
  for (const contribution of contributions.values()) {
    if (contribution > 0n) positive += contribution;
    if (contribution < 0n) negative += contribution;
  }
  return { positive: positive > positiveFloor ? positive : positiveFloor, negative };
}

function financialContributionBudget(
  event: Pick<EventInput, "payload">,
): ContributionBudget {
  const contribution = financialEventContribution(event.payload);
  if (!contribution) return { positive: 0n, negative: 0n };
  // Expense spend is also an Int64 projection, so its positive contribution
  // participates in the same conservative headroom budget.
  return contributionTotals(contribution.units, contribution.spend);
}

function eventComparisonShape(event: {
  eventId: string;
  potId: string;
  actorMemberId: string;
  occurredAtMillis: bigint;
  originatingTimeZone: string;
  schemaVersion: bigint;
  payload: unknown;
  textFields: TextField[];
}) {
  return {
    eventId: event.eventId,
    potId: event.potId,
    actorMemberId: event.actorMemberId,
    occurredAtMillis: event.occurredAtMillis,
    originatingTimeZone: event.originatingTimeZone,
    schemaVersion: event.schemaVersion,
    payload: event.payload,
    textFields: event.textFields,
  };
}

export async function appendEventsToPot(
  ctx: MutationCtx,
  args: {
    pot: Doc<"pots">;
    accountId: Id<"accounts">;
    actorMemberId: string;
    events: EventInput[];
    authorizedLegacyEventIds?: ReadonlySet<string>;
  },
) {
  if (args.events.length > 100) fail("EVENT_BATCH_TOO_LARGE");
  const authorizedLegacyEventIds = args.authorizedLegacyEventIds ?? new Set<string>();
  const incomingEventIds = new Set(args.events.map((event) => event.eventId));
  for (const eventId of authorizedLegacyEventIds) {
    if (!incomingEventIds.has(eventId)) fail("INVALID_LEGACY_MIGRATION_EVENT");
  }
  const batchIds = new Set<string>();
  let nextSequence = args.pot.nextSequence;
  let archivedAtSequence = args.pot.archivedAtSequence;
  let positiveContributionBudget = args.pot.positiveContributionBudget;
  let negativeContributionBudget = args.pot.negativeContributionBudget;
  const configuration: PotConfigurationInput = {
    potId: args.pot.potId,
    currency: {
      code: args.pot.currencyCode,
      exponent: args.pot.currencyExponent,
    },
    orderedUnitIds: args.pot.orderedUnitIds,
    ownerMemberId: args.actorMemberId,
    minimumReaderSchemaVersion: args.pot.minimumReaderSchemaVersion,
  };
  const result: Array<{ eventId: string; sequence: bigint }> = [];
  const insertedEventIds: string[] = [];
  const recordStates = new Map<string, FinancialRecordState>();
  const existingReversedAmounts = new Map<string, bigint>();
  const batchReversedAmounts = new Map<string, bigint>();
  let insertedEventCount = 0n;
  // Exact retries need only their immutable receipt, even if a projection later
  // becomes unavailable. Load admission metadata lazily for new writes only.
  let topology: BudgetGroupTopology | undefined;
  let loadedAllRecordStates = false;

  async function validateOrdinarySettlementUnits(event: EventInput): Promise<void> {
    if (!topology || event.payload.kind !== "settlementRecorded"
      || event.payload.content.reversalOfRecordId !== undefined) return;
    const active = activeBudgetUnitIds(topology, args.pot.orderedUnitIds);
    const inactive = [event.payload.content.fromUnitId, event.payload.content.toUnitId].filter((unit) => !active.has(unit));
    if (inactive.length === 0) return;
    if (!loadedAllRecordStates) {
      // Rare admission predicate only. Reuse existing record/revision semantics;
      // never persist or return server-computed balances. Prior batch inserts are
      // visible in this transaction, and subsequent events update these states.
      const history = await ctx.db.query("events")
        .withIndex("by_pot_sequence", (q) => q.eq("potId", args.pot.potId))
        .order("asc").take(historicalSettlementEventLimit + 1);
      if (history.length > historicalSettlementEventLimit) fail("HISTORICAL_SETTLEMENT_VALIDATION_LIMIT");
      const byRecord = new Map<string, typeof history>();
      for (const row of history) {
        const id = financialRecordId(row);
        if (id !== undefined) {
          const rows = byRecord.get(id) ?? [];
          rows.push(row); byRecord.set(id, rows);
        }
      }
      for (const [id, rows] of byRecord) if (!recordStates.has(id)) recordStates.set(id, buildFinancialRecordState(rows));
      loadedAllRecordStates = true;
    }
    for (const unit of inactive) {
      let amount = 0n;
      for (const record of recordStates.values()) {
        for (const [rawUnit, contribution] of currentContribution(record)) {
          if (projectedUnitId(topology, rawUnit) === unit) amount += contribution;
        }
      }
      if (amount === 0n) fail("INACTIVE_UNIT");
    }
  }

  async function loadRecordState(recordId: string): Promise<FinancialRecordState> {
    let recordState = recordStates.get(recordId);
    if (recordState) return recordState;
    const recordEvents = await ctx.db
      .query("events")
      .withIndex("by_pot_record", (query) =>
        query.eq("potId", args.pot.potId).eq("recordId", recordId),
      )
      .order("asc")
      .collect();
    recordState = buildFinancialRecordState(recordEvents);
    recordStates.set(recordId, recordState);
    return recordState;
  }

  async function validateSettlementReversal(event: EventInput): Promise<void> {
    if (
      event.payload.kind !== "settlementRecorded"
      || event.payload.content.reversalOfRecordId === undefined
    ) return;
    const targetRecordId = event.payload.content.reversalOfRecordId;
    const target = await loadRecordState(targetRecordId);
    if (target.rootKind === undefined) fail("SETTLEMENT_REVERSAL_TARGET_MISSING");
    if (target.rootKind !== "settlement" || !target.settlement) {
      fail("SETTLEMENT_REVERSAL_TARGET_INVALID");
    }
    if (!target.isFlagged) fail("SETTLEMENT_REVERSAL_TARGET_NOT_FLAGGED");
    if (
      event.payload.content.fromUnitId !== target.settlement.content.toUnitId
      || event.payload.content.toUnitId !== target.settlement.content.fromUnitId
    ) fail("SETTLEMENT_REVERSAL_DIRECTION_MISMATCH");

    let priorAmount = existingReversedAmounts.get(targetRecordId);
    if (priorAmount === undefined) {
      const priorReversals = await ctx.db
        .query("events")
        .withIndex("by_pot_reversal", (query) =>
          query
            .eq("potId", args.pot.potId)
            .eq("reversalOfRecordId", targetRecordId),
        )
        .collect();
      priorAmount = priorReversals.reduce((sum, prior) =>
        prior.payload.kind === "settlementRecorded"
          ? sum + prior.payload.content.amount.minorUnits
          : sum, 0n);
      existingReversedAmounts.set(targetRecordId, priorAmount);
    }
    const batchAmount = batchReversedAmounts.get(targetRecordId) ?? 0n;
    const nextAmount = priorAmount + batchAmount
      + event.payload.content.amount.minorUnits;
    if (nextAmount > target.settlement.content.amount.minorUnits) {
      fail("SETTLEMENT_REVERSAL_EXCEEDS_ORIGINAL");
    }
    batchReversedAmounts.set(
      targetRecordId,
      batchAmount + event.payload.content.amount.minorUnits,
    );
  }

  for (const event of args.events) {
    if (batchIds.has(event.eventId)) fail("DUPLICATE_BATCH_EVENT");
    batchIds.add(event.eventId);
    if (event.actorMemberId !== args.actorMemberId) fail("ACTOR_MISMATCH");

    const existing = await ctx.db
      .query("events")
      .withIndex("by_event_id", (query) => query.eq("eventId", event.eventId))
      .unique();
    if (existing) {
      validateEvent(event, configuration, {
        allowLegacyAuthoredText: existing.legacyAuthoredText === true,
      });
      requireP2EventKind(event);
      const incomingShape = eventComparisonShape(event);
      const storedShape = eventComparisonShape({
        eventId: existing.eventId,
        potId: existing.potId,
        actorMemberId: existing.actorMemberId,
        occurredAtMillis: existing.occurredAtMillis,
        originatingTimeZone: existing.originatingTimeZone,
        schemaVersion: existing.schemaVersion,
        payload: existing.payload,
        textFields: existing.textFields,
      });
      if (canonicalValue(incomingShape) !== canonicalValue(storedShape)) {
        fail("EVENT_ID_CONFLICT");
      }
      const retainedText = await ctx.db
        .query("eventTexts")
        .withIndex("by_pot_event", (query) =>
          query.eq("potId", args.pot.potId).eq("eventId", event.eventId),
        )
        .collect();
      const incomingText = new Map(
        event.authoredText.map(({ field, value }) => [field, value]),
      );
      for (const sidecar of retainedText) {
        if (incomingText.get(sidecar.field as TextField) !== sidecar.value) {
          fail("EVENT_TEXT_CONFLICT");
        }
      }
      result.push({ eventId: event.eventId, sequence: existing.sequence });
      continue;
    }

    validateEvent(event, configuration, {
      allowLegacyAuthoredText: authorizedLegacyEventIds.has(event.eventId),
    });
    requireP2EventKind(event);

    if (archivedAtSequence !== undefined) fail("POT_ARCHIVED");
    if (event.schemaVersion < args.pot.minimumReaderSchemaVersion) fail("SCHEMA_DOWNGRADE");
    if (event.schemaVersion === 2n) {
      if (args.pot.minimumReaderSchemaVersion !== 2n) fail("BUDGET_GROUP_ACTIVATION_REQUIRED");
      topology ??= await loadBudgetGroupTopology(ctx, args.pot);
    }

    await validateSettlementReversal(event);
    await validateOrdinarySettlementUnits(event);

    const recordId = financialRecordId(event);
    if (recordId !== undefined) {
      const recordState = await loadRecordState(recordId);
      if (topology) validateBudgetFinancialUnits(event, topology, args.pot.orderedUnitIds, recordState);
      applyFinancialEventState(recordState, event);
      if (topology) topology.hasFinancialHistory = true;
    }

    const contribution = financialContributionBudget(event);
    const nextPositiveContributionBudget = positiveContributionBudget
      + contribution.positive;
    if (nextPositiveContributionBudget > maximumInt64) {
      fail("POSITIVE_CONTRIBUTION_BUDGET_EXCEEDED");
    }
    const nextNegativeContributionBudget = negativeContributionBudget
      + contribution.negative;
    if (nextNegativeContributionBudget < minimumInt64) {
      fail("NEGATIVE_CONTRIBUTION_BUDGET_EXCEEDED");
    }
    positiveContributionBudget = nextPositiveContributionBudget;
    negativeContributionBudget = nextNegativeContributionBudget;

    const createdAt = Date.now();
    const sequence = nextSequence;
    nextSequence += 1n;
    await ctx.db.insert("events", {
      potId: args.pot.potId,
      eventId: event.eventId,
      ...(recordId === undefined ? {} : { recordId }),
      ...(event.payload.kind === "settlementRecorded"
          && event.payload.content.reversalOfRecordId !== undefined
        ? { reversalOfRecordId: event.payload.content.reversalOfRecordId }
        : {}),
      actorMemberId: event.actorMemberId,
      occurredAtMillis: event.occurredAtMillis,
      originatingTimeZone: event.originatingTimeZone,
      schemaVersion: event.schemaVersion,
      sequence,
      payload: event.payload,
      textFields: event.textFields,
      ...(authorizedLegacyEventIds.has(event.eventId)
        ? { legacyAuthoredText: true }
        : {}),
      createdAt,
    });
    insertedEventCount += 1n;
    insertedEventIds.push(event.eventId);
    for (const authored of event.authoredText) {
      await ctx.db.insert("eventTexts", {
        potId: args.pot.potId,
        eventId: event.eventId,
        sequence,
        field: authored.field,
        value: authored.value,
        authorAccountId: args.accountId,
        createdAt,
      });
    }
    if (event.payload.kind === "potArchived") {
      archivedAtSequence = sequence;
    }
    result.push({ eventId: event.eventId, sequence });
  }

  if (insertedEventCount > 0n) {
    await consumeAccountWriteQuota(ctx, {
      accountId: args.accountId,
      scope: "event",
      amount: insertedEventCount,
      limit: eventWriteLimitPerHour,
      windowMillis: 3_600_000,
      now: Date.now(),
    });
  }

  if (nextSequence !== args.pot.nextSequence) {
    await ctx.db.patch(args.pot._id, {
      nextSequence,
      archivedAtSequence,
      positiveContributionBudget,
      negativeContributionBudget,
      ...(topology ? { budgetGroupTopology: topology } : {}),
    });
  }
  return { events: result, insertedEventIds };
}

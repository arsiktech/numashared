import { v } from "convex/values";

export const memberRoleValidator = v.union(
  v.literal("owner"),
  v.literal("member"),
);

export const membershipStatusValidator = v.union(
  v.literal("active"),
  v.literal("archived"),
);

export const textFieldValidator = v.union(
  v.literal("title"),
  v.literal("category"),
  v.literal("note"),
  v.literal("reason"),
);

export const currencyValidator = v.object({
  code: v.string(),
  exponent: v.int64(),
});

export const moneyValidator = v.object({
  minorUnits: v.int64(),
  currency: currencyValidator,
});

export const allocationValidator = v.object({
  unitId: v.string(),
  amount: moneyValidator,
});

export const expenseContentValidator = v.object({
  expenseKind: v.union(v.literal("shared"), v.literal("personal")),
  amount: moneyValidator,
  payerUnitId: v.string(),
  payerMemberId: v.optional(v.string()),
  allocations: v.array(allocationValidator),
});

export const openingBalanceContentValidator = v.object({
  entries: v.array(v.object({
    unitId: v.string(),
    amount: moneyValidator,
  })),
});

export const settlementContentValidator = v.object({
  amount: moneyValidator,
  fromUnitId: v.string(),
  toUnitId: v.string(),
  reversalOfRecordId: v.optional(v.string()),
});

export const revisionBasisValidator = v.union(
  v.object({
    kind: v.literal("parent"),
    parentEventId: v.string(),
  }),
  v.object({
    kind: v.literal("resolution"),
    firstEventId: v.string(),
    secondEventId: v.string(),
  }),
);

export const revisableContentValidator = v.union(
  v.object({
    kind: v.literal("expense"),
    expenseKind: v.union(v.literal("shared"), v.literal("personal")),
    amount: moneyValidator,
    payerUnitId: v.string(),
    payerMemberId: v.optional(v.string()),
    allocations: v.array(allocationValidator),
  }),
  v.object({
    kind: v.literal("openingBalance"),
    entries: v.array(v.object({
      unitId: v.string(),
      amount: moneyValidator,
    })),
  }),
);

export const expenseAddedPayloadValidator = v.object({
  kind: v.literal("expenseAdded"),
  recordId: v.string(),
  content: expenseContentValidator,
});

export const expenseRevisedPayloadValidator = v.object({
  kind: v.literal("expenseRevised"),
  recordId: v.string(),
  basis: revisionBasisValidator,
  content: revisableContentValidator,
});

export const recordVoidedPayloadValidator = v.object({
  kind: v.literal("recordVoided"),
  recordId: v.string(),
});

export const recordRestoredPayloadValidator = v.object({
  kind: v.literal("recordRestored"),
  recordId: v.string(),
});

export const settlementRecordedPayloadValidator = v.object({
  kind: v.literal("settlementRecorded"),
  recordId: v.string(),
  content: settlementContentValidator,
});

export const settlementFlaggedPayloadValidator = v.object({
  kind: v.literal("settlementFlagged"),
  recordId: v.string(),
});

export const openingBalanceSetPayloadValidator = v.object({
  kind: v.literal("openingBalanceSet"),
  recordId: v.string(),
  content: openingBalanceContentValidator,
});

export const memberAddedPayloadValidator = v.object({
  kind: v.literal("memberAdded"),
  memberId: v.string(),
  unitId: v.string(),
  role: memberRoleValidator,
});

export const memberClaimedPayloadValidator = v.object({
  kind: v.literal("memberClaimed"),
  memberId: v.string(),
});

export const memberClaimReassignedPayloadValidator = v.object({
  kind: v.literal("memberClaimReassigned"),
  memberId: v.string(),
});

export const memberArchivedPayloadValidator = v.object({
  kind: v.literal("memberArchived"),
  memberId: v.string(),
});

export const ownershipTransferredPayloadValidator = v.object({
  kind: v.literal("ownershipTransferred"),
  fromMemberId: v.string(),
  toMemberId: v.string(),
});

export const settlementGroupValidator = v.object({
  groupId: v.string(),
  unitId: v.string(),
  orderedMemberIds: v.array(v.string()),
  defaultShareWeight: v.int64(),
});

export const groupChangedPayloadValidator = v.object({
  kind: v.literal("groupChanged"),
  groups: v.array(settlementGroupValidator),
});

// Rebuildable admission metadata, never authoritative balances or profile text.
export const budgetGroupTopologyValidator = v.object({
  revision: v.int64(),
  minimumSchemaVersion: v.int64(),
  hasFinancialHistory: v.boolean(),
  members: v.array(v.object({
    memberId: v.string(),
    personalUnitId: v.string(),
    unitId: v.string(),
    archived: v.boolean(),
  })),
  groups: v.array(settlementGroupValidator),
  groupUnitBindings: v.array(v.object({ groupId: v.string(), unitId: v.string() })),
});

export const presetChangedPayloadValidator = v.object({
  kind: v.literal("presetChanged"),
  name: v.string(),
  orderedUnitIds: v.array(v.string()),
});

export const potRenamedPayloadValidator = v.object({
  kind: v.literal("potRenamed"),
  name: v.string(),
});

export const potArchivedPayloadValidator = v.object({
  kind: v.literal("potArchived"),
});

export const eventPayloadValidator = v.union(
  expenseAddedPayloadValidator,
  expenseRevisedPayloadValidator,
  recordVoidedPayloadValidator,
  recordRestoredPayloadValidator,
  settlementRecordedPayloadValidator,
  settlementFlaggedPayloadValidator,
  openingBalanceSetPayloadValidator,
  memberAddedPayloadValidator,
  memberClaimedPayloadValidator,
  memberClaimReassignedPayloadValidator,
  memberArchivedPayloadValidator,
  ownershipTransferredPayloadValidator,
  groupChangedPayloadValidator,
  presetChangedPayloadValidator,
  potRenamedPayloadValidator,
  potArchivedPayloadValidator,
);

export const authoredTextValidator = v.object({
  field: textFieldValidator,
  value: v.string(),
});

export const eventInputValidator = v.object({
  eventId: v.string(),
  potId: v.string(),
  actorMemberId: v.string(),
  occurredAtMillis: v.int64(),
  originatingTimeZone: v.string(),
  schemaVersion: v.int64(),
  payload: eventPayloadValidator,
  textFields: v.array(textFieldValidator),
  authoredText: v.array(authoredTextValidator),
});

export const potConfigurationInputValidator = v.object({
  potId: v.string(),
  currency: currencyValidator,
  orderedUnitIds: v.array(v.string()),
  ownerMemberId: v.string(),
  minimumReaderSchemaVersion: v.int64(),
});

export const textPresentStateValidator = v.object({
  field: textFieldValidator,
  state: v.literal("present"),
  value: v.string(),
});

export const textRedactedStateValidator = v.object({
  field: textFieldValidator,
  state: v.literal("redacted"),
});

export const textStateValidator = v.union(
  textPresentStateValidator,
  textRedactedStateValidator,
);

export const redactedTextPlaceholder = "[redacted]";

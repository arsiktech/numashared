// Wire format V1, as the Convex backend validates it (convex/model.ts). int64 fields are bigint.
export type TextField = 'title' | 'category' | 'note' | 'reason';
export const TEXT_FIELD_ORDER: readonly TextField[] = ['title', 'category', 'note', 'reason'];

export type WireCurrency = { code: string; exponent: bigint };
export type WireMoney = { minorUnits: bigint; currency: WireCurrency };
export type WireAllocation = { unitId: string; amount: WireMoney };

export type WireExpense = {
  expenseKind: 'shared' | 'personal';
  amount: WireMoney;
  payerUnitId: string;
  payerMemberId?: string;
  allocations: WireAllocation[];
};
export type WireOpeningEntry = { unitId: string; amount: WireMoney };
export type WireSettlement = { amount: WireMoney; fromUnitId: string; toUnitId: string; reversalOfRecordId?: string };
export type WireBasis =
  | { kind: 'parent'; parentEventId: string }
  | { kind: 'resolution'; firstEventId: string; secondEventId: string };
export type WireSettlementGroup = { groupId: string; unitId: string; orderedMemberIds: string[]; defaultShareWeight: bigint };

export type WirePayload =
  | { kind: 'expenseAdded'; recordId: string; content: WireExpense }
  | { kind: 'expenseRevised'; recordId: string; basis: WireBasis;
      content: ({ kind: 'expense' } & WireExpense) | { kind: 'openingBalance'; entries: WireOpeningEntry[] } }
  | { kind: 'recordVoided'; recordId: string }
  | { kind: 'recordRestored'; recordId: string }
  | { kind: 'settlementRecorded'; recordId: string; content: WireSettlement }
  | { kind: 'settlementFlagged'; recordId: string }
  | { kind: 'openingBalanceSet'; recordId: string; content: { entries: WireOpeningEntry[] } }
  | { kind: 'memberAdded'; memberId: string; unitId: string; role: 'owner' | 'member' }
  | { kind: 'memberClaimed'; memberId: string }
  | { kind: 'memberClaimReassigned'; memberId: string }
  | { kind: 'memberArchived'; memberId: string }
  | { kind: 'ownershipTransferred'; fromMemberId: string; toMemberId: string }
  | { kind: 'groupChanged'; groups: WireSettlementGroup[] }
  | { kind: 'presetChanged'; name: string; orderedUnitIds: string[] }
  | { kind: 'potRenamed'; name: string }
  | { kind: 'potArchived' };

export type WireEvent = {
  eventId: string;
  potId: string;
  actorMemberId: string;
  occurredAtMillis: bigint;
  originatingTimeZone: string;
  schemaVersion: bigint;
  payload: WirePayload;
  textFields: TextField[];
  authoredText: { field: TextField; value: string }[];
};

export type TextState = { field: TextField; state: 'present'; value: string } | { field: TextField; state: 'redacted' };

export type ListedEvent = {
  event: Omit<WireEvent, 'authoredText'> & { authoredText: []; legacyAuthoredText?: true };
  serverSequence: bigint;
  textStates: TextState[];
};

export type PotConfiguration = {
  potId: string;
  currency: WireCurrency;
  orderedUnitIds: string[];
  ownerMemberId: string;
  minimumReaderSchemaVersion: bigint;
};

export const REDACTED = '[redacted]';

/** Builds the manifest and authored text in the canonical field order, dropping blank values. */
export function authored(text: Partial<Record<TextField, string | undefined>>) {
  const fields = TEXT_FIELD_ORDER.filter((f) => isPresent(text[f]));
  return {
    textFields: fields,
    authoredText: fields.map((field) => ({ field, value: text[field]!.slice(0, 512) })),
  };
}

// Matches the backend's Foundation whitespace set (JavaScript trim() differs).
const BLANK = /^[\u0009-\u000D \u0085   -​ -   　]*$/u;
export const isPresent = (s: string | undefined): s is string => typeof s === 'string' && !BLANK.test(s) && s !== REDACTED;

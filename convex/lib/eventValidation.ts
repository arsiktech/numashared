import type { Infer } from "convex/values";

import {
  eventInputValidator,
  potConfigurationInputValidator,
  redactedTextPlaceholder,
} from "../model";
import { iso4217MinorUnits } from "../iso4217";
import { fail } from "./access";
import { ios18TimeZoneIdentifiers } from "./ios18TimeZoneIdentifiers";

export type EventInput = Infer<typeof eventInputValidator>;
export type PotConfigurationInput = Infer<typeof potConfigurationInputValidator>;
export type TextField = "title" | "category" | "note" | "reason";
export type MoneyInput = {
  minorUnits: bigint;
  currency: { code: string; exponent: bigint };
};

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const currencyCodePattern = /^[A-Z]{3}$/;
const textFieldOrder: readonly TextField[] = ["title", "category", "note", "reason"];
const minimumInt64 = -(1n << 63n);
const maximumInt64 = (1n << 63n) - 1n;
// Keep authored-text admission scalar-for-scalar compatible with Foundation's
// CharacterSet.whitespacesAndNewlines, which the Swift wire decoder uses.
// JavaScript trim() is not equivalent: it admits U+0085 and U+200B while
// rejecting U+FEFF, the opposite of Foundation for those scalars.
const foundationWhitespaceAndNewlinesOnlyPattern =
  /^[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200B\u2028-\u2029\u202F\u205F\u3000]*$/u;

function assert(condition: boolean, code: string): asserts condition {
  if (!condition) fail(code);
}

export function validateUUIDv7(value: string, code = "INVALID_UUID_V7"): void {
  assert(uuidV7Pattern.test(value), code);
}

export function validateTimeZone(value: string): void {
  // Intl accepts case variants and aliases that Foundation's IANATimeZone
  // rejects. Admission must be the frozen iOS v1 wire contract, not the
  // backend process's ICU version or canonicalization behavior.
  assert(ios18TimeZoneIdentifiers.has(value), "INVALID_TIME_ZONE");
}

function validateNonblankText(value: string, field: TextField): void {
  assert(
    !foundationWhitespaceAndNewlinesOnlyPattern.test(value),
    `BLANK_${field.toUpperCase()}`,
  );
  assert(value.length <= 512, `TEXT_TOO_LONG_${field.toUpperCase()}`);
  assert(value !== redactedTextPlaceholder, "RESERVED_REDACTED_TEXT");
}

export function validateDisplayName(value: string): void {
  assert(
    !foundationWhitespaceAndNewlinesOnlyPattern.test(value),
    "BLANK_DISPLAY_NAME",
  );
  assert(value.length <= 128, "DISPLAY_NAME_TOO_LONG");
  assert(value !== redactedTextPlaceholder, "RESERVED_REDACTED_TEXT");
}

function validateStructuralName(value: string, code: string): void {
  assert(value.trim().length > 0, code);
  assert(value.length <= 128, `${code}_TOO_LONG`);
}

function validateCurrencyShape(currency: MoneyInput["currency"]): void {
  assert(currencyCodePattern.test(currency.code), "INVALID_CURRENCY_CODE");
  assert(currency.exponent >= 0n && currency.exponent <= 4n, "INVALID_CURRENCY_EXPONENT");
  const expectedExponent = iso4217MinorUnits[currency.code];
  assert(expectedExponent !== undefined, "UNSUPPORTED_CURRENCY_CODE");
  assert(BigInt(expectedExponent) === currency.exponent, "CURRENCY_EXPONENT_MISMATCH");
}

function validateMoneyCurrency(
  money: MoneyInput,
  configuration: PotConfigurationInput,
): void {
  validateCurrencyShape(money.currency);
  assert(
    money.currency.code === configuration.currency.code
      && money.currency.exponent === configuration.currency.exponent,
    "CURRENCY_MISMATCH",
  );
}

function validateManifestAndText(
  event: EventInput,
  required: readonly TextField[],
  allowed: readonly TextField[],
  allowLegacyAuthoredText: boolean,
): void {
  const fields = event.textFields;
  assert(fields.length === new Set(fields).size, "DUPLICATE_TEXT_FIELD");
  const canonical = textFieldOrder.filter((field) => fields.includes(field));
  assert(
    canonical.length === fields.length
      && canonical.every((field, index) => fields[index] === field),
    "NONCANONICAL_TEXT_FIELDS",
  );
  for (const field of fields) {
    assert(allowed.includes(field), `TEXT_FIELD_NOT_ALLOWED_${field.toUpperCase()}`);
  }
  for (const field of required) {
    assert(fields.includes(field), `TEXT_FIELD_REQUIRED_${field.toUpperCase()}`);
  }

  assert(event.authoredText.length === fields.length, "AUTHORED_TEXT_MANIFEST_MISMATCH");
  const authoredFields = event.authoredText.map(({ field }) => field);
  assert(
    authoredFields.every((field, index) => field === fields[index]),
    "AUTHORED_TEXT_MANIFEST_MISMATCH",
  );
  for (const authored of event.authoredText) {
    // A v1 database could retain title/category/note values that predate the
    // P2 value policy. Reducer-semantic reasons were already nonblank in P1
    // and are never grandfathered, because a blank void would freeze replay.
    if (!allowLegacyAuthoredText || authored.field === "reason") {
      validateNonblankText(authored.value, authored.field);
    }
  }
}

function validateUnit(unitId: string, configuration: PotConfigurationInput): void {
  validateUUIDv7(unitId, "INVALID_UNIT_ID");
  assert(configuration.orderedUnitIds.includes(unitId), "UNKNOWN_UNIT");
}

function validateMember(memberId: string): void {
  validateUUIDv7(memberId, "INVALID_MEMBER_ID");
}

function validateRecord(recordId: string): void {
  validateUUIDv7(recordId, "INVALID_RECORD_ID");
}

function addChecked(total: bigint, value: bigint, overflowCode: string): bigint {
  const next = total + value;
  assert(next >= minimumInt64 && next <= maximumInt64, overflowCode);
  return next;
}

function validateExpense(
  content: {
    expenseKind: "shared" | "personal";
    amount: MoneyInput;
    payerUnitId: string;
    allocations: Array<{ unitId: string; amount: MoneyInput }>;
  },
  configuration: PotConfigurationInput,
): void {
  validateMoneyCurrency(content.amount, configuration);
  assert(content.amount.minorUnits > 0n, "INVALID_EXPENSE_AMOUNT");
  validateUnit(content.payerUnitId, configuration);
  assert(content.allocations.length > 0, "EMPTY_ALLOCATIONS");
  if (content.expenseKind === "personal") {
    assert(
      content.allocations.length === 1
        && content.allocations[0].unitId !== content.payerUnitId,
      "INVALID_PERSONAL_ALLOCATIONS",
    );
  }

  const seen = new Set<string>();
  let total = 0n;
  for (const allocation of content.allocations) {
    validateUnit(allocation.unitId, configuration);
    assert(!seen.has(allocation.unitId), "DUPLICATE_ALLOCATION_UNIT");
    seen.add(allocation.unitId);
    validateMoneyCurrency(allocation.amount, configuration);
    assert(allocation.amount.minorUnits >= 0n, "INVALID_ALLOCATION_AMOUNT");
    total = addChecked(total, allocation.amount.minorUnits, "ALLOCATION_SUM_OVERFLOW");
  }
  assert(total === content.amount.minorUnits, "ALLOCATION_SUM_MISMATCH");
}

function validateOpeningBalance(
  entries: Array<{ unitId: string; amount: MoneyInput }>,
  configuration: PotConfigurationInput,
): void {
  assert(entries.length > 0, "EMPTY_OPENING_BALANCE");
  const seen = new Set<string>();
  let total = 0n;
  for (const entry of entries) {
    validateUnit(entry.unitId, configuration);
    assert(!seen.has(entry.unitId), "DUPLICATE_OPENING_BALANCE_UNIT");
    seen.add(entry.unitId);
    validateMoneyCurrency(entry.amount, configuration);
    // Inputs are already validated Int64 values. Core accumulates opening
    // entries in a wider domain and requires only the final sum to be zero, so
    // acceptance must not depend on an arbitrary entry order's Int64 prefix.
    total += entry.amount.minorUnits;
  }
  assert(total === 0n, "OPENING_BALANCE_NOT_ZERO_SUM");
}

function validateRevisionBasis(basis: EventInput["payload"] extends never ? never : unknown): void {
  const value = basis as
    | { kind: "parent"; parentEventId: string }
    | { kind: "resolution"; firstEventId: string; secondEventId: string };
  if (value.kind === "parent") {
    validateUUIDv7(value.parentEventId, "INVALID_PARENT_EVENT_ID");
    return;
  }
  validateUUIDv7(value.firstEventId, "INVALID_RESOLUTION_EVENT_ID");
  validateUUIDv7(value.secondEventId, "INVALID_RESOLUTION_EVENT_ID");
  assert(value.firstEventId < value.secondEventId, "NONCANONICAL_REVISION_PAIR");
}

export function validateConfiguration(configuration: PotConfigurationInput): void {
  validateUUIDv7(configuration.potId, "INVALID_POT_ID");
  validateUUIDv7(configuration.ownerMemberId, "INVALID_OWNER_MEMBER_ID");
  validateCurrencyShape(configuration.currency);
  assert(configuration.minimumReaderSchemaVersion === 1n, "UNSUPPORTED_READER_SCHEMA");
  assert(configuration.orderedUnitIds.length > 0, "EMPTY_UNIT_ORDER");
  assert(configuration.orderedUnitIds.length <= 64, "TOO_MANY_UNITS");
  const uniqueUnits = new Set(configuration.orderedUnitIds);
  assert(uniqueUnits.size === configuration.orderedUnitIds.length, "DUPLICATE_UNIT_ID");
  for (const unitId of configuration.orderedUnitIds) {
    validateUUIDv7(unitId, "INVALID_UNIT_ID");
  }
}

export function validateEvent(
  event: EventInput,
  configuration: PotConfigurationInput,
  options: { allowLegacyAuthoredText?: boolean } = {},
): void {
  const allowLegacyAuthoredText = options.allowLegacyAuthoredText === true;
  validateUUIDv7(event.eventId, "INVALID_EVENT_ID");
  assert(event.potId === configuration.potId, "EVENT_POT_MISMATCH");
  validateUUIDv7(event.actorMemberId, "INVALID_ACTOR_MEMBER_ID");
  assert(event.occurredAtMillis >= 0n, "INVALID_OCCURRED_AT");
  assert(event.schemaVersion === 1n || event.schemaVersion === 2n, "UNSUPPORTED_SCHEMA_VERSION");
  const attributedExpense = event.payload.kind === "expenseAdded"
    || (event.payload.kind === "expenseRevised" && event.payload.content.kind === "expense")
    ? event.payload.content : undefined;
  if (attributedExpense && "payerMemberId" in attributedExpense && attributedExpense.payerMemberId !== undefined) {
    assert(event.schemaVersion === 2n, "PAYER_ATTRIBUTION_REQUIRES_SCHEMA_2");
    validateMember(attributedExpense.payerMemberId);
  }
  validateTimeZone(event.originatingTimeZone);

  switch (event.payload.kind) {
    case "expenseAdded":
      validateRecord(event.payload.recordId);
      validateExpense(event.payload.content, configuration);
      validateManifestAndText(
        event, ["title"], ["title", "category"], allowLegacyAuthoredText,
      );
      return;
    case "expenseRevised":
      validateRecord(event.payload.recordId);
      validateRevisionBasis(event.payload.basis);
      if (event.payload.content.kind === "expense") {
        validateExpense(event.payload.content, configuration);
        validateManifestAndText(
          event, ["title"], ["title", "category"], allowLegacyAuthoredText,
        );
      } else {
        validateOpeningBalance(event.payload.content.entries, configuration);
        validateManifestAndText(
          event, ["title"], ["title", "note"], allowLegacyAuthoredText,
        );
      }
      return;
    case "recordVoided":
      validateRecord(event.payload.recordId);
      validateManifestAndText(
        event, ["reason"], ["reason"], allowLegacyAuthoredText,
      );
      return;
    case "recordRestored":
      validateRecord(event.payload.recordId);
      validateManifestAndText(event, [], [], allowLegacyAuthoredText);
      return;
    case "settlementRecorded":
      validateRecord(event.payload.recordId);
      validateMoneyCurrency(event.payload.content.amount, configuration);
      assert(event.payload.content.amount.minorUnits > 0n, "INVALID_SETTLEMENT_AMOUNT");
      validateUnit(event.payload.content.fromUnitId, configuration);
      validateUnit(event.payload.content.toUnitId, configuration);
      assert(
        event.payload.content.fromUnitId !== event.payload.content.toUnitId,
        "IDENTICAL_SETTLEMENT_UNITS",
      );
      if (event.payload.content.reversalOfRecordId !== undefined) {
        validateRecord(event.payload.content.reversalOfRecordId);
        assert(
          event.payload.content.reversalOfRecordId !== event.payload.recordId,
          "SETTLEMENT_REVERSAL_SELF_TARGET",
        );
      }
      validateManifestAndText(event, ["title"], ["title"], allowLegacyAuthoredText);
      return;
    case "settlementFlagged":
      validateRecord(event.payload.recordId);
      validateManifestAndText(event, [], ["reason"], allowLegacyAuthoredText);
      return;
    case "openingBalanceSet":
      validateRecord(event.payload.recordId);
      validateOpeningBalance(event.payload.content.entries, configuration);
      validateManifestAndText(
        event, ["title"], ["title", "note"], allowLegacyAuthoredText,
      );
      return;
    case "memberAdded":
      validateMember(event.payload.memberId);
      validateUUIDv7(event.payload.unitId, "INVALID_UNIT_ID");
      validateManifestAndText(event, [], [], allowLegacyAuthoredText);
      return;
    case "memberClaimed":
    case "memberClaimReassigned":
      validateMember(event.payload.memberId);
      validateManifestAndText(event, [], [], allowLegacyAuthoredText);
      return;
    case "memberArchived":
      validateMember(event.payload.memberId);
      validateManifestAndText(event, [], ["reason"], allowLegacyAuthoredText);
      return;
    case "ownershipTransferred":
      validateMember(event.payload.fromMemberId);
      validateMember(event.payload.toMemberId);
      assert(
        event.payload.fromMemberId !== event.payload.toMemberId,
        "IDENTICAL_OWNERSHIP_MEMBERS",
      );
      validateManifestAndText(event, [], [], allowLegacyAuthoredText);
      return;
    case "groupChanged": {
      assert(event.payload.groups.length <= 64, "TOO_MANY_GROUPS");
      const groupIds = new Set<string>();
      const unitIds = new Set<string>();
      for (const group of event.payload.groups) {
        validateUUIDv7(group.groupId, "INVALID_GROUP_ID");
        validateUUIDv7(group.unitId, "INVALID_UNIT_ID");
        assert(!groupIds.has(group.groupId), "DUPLICATE_GROUP_ID");
        groupIds.add(group.groupId);
        assert(!unitIds.has(group.unitId), "DUPLICATE_GROUP_UNIT_ID");
        unitIds.add(group.unitId);
        assert(group.orderedMemberIds.length > 0, "EMPTY_GROUP_MEMBERS");
        assert(
          group.orderedMemberIds.length === new Set(group.orderedMemberIds).size,
          "DUPLICATE_GROUP_MEMBER",
        );
        for (const memberId of group.orderedMemberIds) validateMember(memberId);
        assert(group.defaultShareWeight > 0n, "INVALID_GROUP_SHARE_WEIGHT");
      }
      validateManifestAndText(event, [], [], allowLegacyAuthoredText);
      return;
    }
    case "presetChanged":
      validateStructuralName(event.payload.name, "INVALID_PRESET_NAME");
      assert(event.payload.orderedUnitIds.length > 0, "EMPTY_PRESET_UNITS");
      assert(
        event.payload.orderedUnitIds.length === new Set(event.payload.orderedUnitIds).size,
        "DUPLICATE_PRESET_UNIT",
      );
      for (const unitId of event.payload.orderedUnitIds) {
        validateUUIDv7(unitId, "INVALID_UNIT_ID");
      }
      validateManifestAndText(event, [], [], allowLegacyAuthoredText);
      return;
    case "potRenamed":
      validateStructuralName(event.payload.name, "INVALID_POT_NAME");
      validateManifestAndText(event, [], [], allowLegacyAuthoredText);
      return;
    case "potArchived":
      validateManifestAndText(event, [], ["reason"], allowLegacyAuthoredText);
      return;
  }
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") return { $int64: value.toString() };
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function canonicalValue(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

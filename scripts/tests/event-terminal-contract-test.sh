#!/bin/zsh

set -euo pipefail

repo_root=${0:A:h:h:h}
node --input-type=module - \
  "$repo_root/contracts/event-terminal-codes.json" \
  "$repo_root/convex/lib/eventValidation.ts" \
  "$repo_root/convex/lib/appendEvents.ts" \
  "$repo_root/convex/lib/financialRecordState.ts" \
  "$repo_root/NumaSharedSync/Sources/NumaSharedSync/SyncCoordinator.swift" <<'NODE'
import { readFileSync } from "node:fs";

const [contractPath, validationPath, appendPath, recordStatePath, swiftPath]
  = process.argv.slice(2);
const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const sorted = [...contract].sort();
if (JSON.stringify(contract) !== JSON.stringify(sorted)
    || new Set(contract).size !== contract.length) {
  throw new Error("Event-terminal contract must be unique and sorted");
}

const backendSource = readFileSync(validationPath, "utf8")
  + "\n" + readFileSync(appendPath, "utf8")
  + "\n" + readFileSync(recordStatePath, "utf8");
const backend = new Set(
  Array.from(backendSource.matchAll(/"([A-Z][A-Z0-9_]+)"/gu), (match) => match[1]),
);
for (const nonEventCode of [
  "BLANK_DISPLAY_NAME",
  "BUDGET_GROUP_ACTIVATION_REQUIRED",
  "DISPLAY_NAME_TOO_LONG",
  "EVENT_BATCH_TOO_LARGE",
  "HISTORICAL_SETTLEMENT_VALIDATION_LIMIT",
  "INACTIVE_UNIT",
  "INVALID_UUID_V7",
  "POT_ARCHIVED",
  "SCHEMA_DOWNGRADE",
  "UNSUPPORTED_READER_SCHEMA",
]) backend.delete(nonEventCode);
for (const field of ["TITLE", "CATEGORY", "NOTE", "REASON"]) {
  backend.add(`BLANK_${field}`);
  backend.add(`TEXT_TOO_LONG_${field}`);
  backend.add(`TEXT_FIELD_NOT_ALLOWED_${field}`);
  backend.add(`TEXT_FIELD_REQUIRED_${field}`);
}
backend.add("INVALID_PRESET_NAME_TOO_LONG");
backend.add("INVALID_POT_NAME_TOO_LONG");
backend.add("UNSUPPORTED_WIRE_EVENT");

const swiftBlock = readFileSync(swiftPath, "utf8")
  .split("static let eventTerminalCodes", 2)[1]
  .split("]", 1)[0];
const swift = new Set(
  Array.from(swiftBlock.matchAll(/"([A-Z][A-Z0-9_]+)"/gu), (match) => match[1]),
);
for (const [label, actual] of [["backend", backend], ["Swift", swift]]) {
  const actualSorted = [...actual].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(sorted)) {
    const missing = sorted.filter((code) => !actual.has(code));
    const extra = actualSorted.filter((code) => !contract.includes(code));
    throw new Error(`${label} taxonomy drift: missing=${missing} extra=${extra}`);
  }
}
process.stdout.write(`event-terminal contract passed: ${contract.length} codes\n`);
NODE

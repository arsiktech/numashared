#!/usr/bin/env node

import { readFileSync } from "node:fs";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(66);
}

function parseInteger(name, value, minimum = 0) {
  if (!/^(0|[1-9][0-9]*)$/u.test(value ?? "")) {
    fail(`Invalid ${name}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    fail(`Invalid ${name}`);
  }
  return parsed;
}

function loopbackOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("Local sync URL is invalid");
  }
  if (
    url.protocol !== "http:"
    || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    fail("Local sync URL must be a credential-free loopback origin");
  }
  return url.origin;
}

function validateLoopback(value) {
  process.stdout.write(loopbackOrigin(value));
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function resolveDevice(name, runtimeKey) {
  const requiredDeviceType = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max";
  let listing;
  try {
    listing = JSON.parse(await readStandardInput());
  } catch {
    fail("Simulator device listing is invalid");
  }
  const candidates = listing?.devices?.[runtimeKey]?.filter(
    (device) => device?.name === name
      && device?.isAvailable === true
      && device?.deviceTypeIdentifier === requiredDeviceType,
  ) ?? [];
  if (candidates.length !== 1 || !/^[A-F0-9-]{36}$/u.test(candidates[0].udid)) {
    fail(`Expected exactly one available ${name} on ${runtimeKey}`);
  }
  process.stdout.write(candidates[0].udid);
}

function syncFailureSummary(value) {
  const error = typeof value?.lastError === "string"
      && /^[A-Z0-9_]{1,80}$/u.test(value.lastError)
    ? value.lastError
    : "unavailable";
  const outcomes = new Set([
    "completed", "already-running", "retry-scheduled", "paused",
  ]);
  const outcome = outcomes.has(value?.lastSyncOutcome)
    ? value.lastSyncOutcome
    : "unavailable";
  return `lastError=${error}; lastSyncOutcome=${outcome}`;
}

function validateArtifact(value, expected) {
  if (!value || typeof value !== "object" || value.ready !== true) {
    throw new Error("artifact is not ready");
  }
  for (const [name, target] of [
    ["runID", expected.runID],
    ["role", expected.role],
    ["command", expected.command],
  ]) {
    if (value[name] !== target) throw new Error(`${name} mismatch`);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.accountID ?? "")) {
    throw new Error("authenticated account ID is missing or invalid");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.activePotID ?? "")) {
    throw new Error("active pot ID is missing or invalid");
  }
  if (!["local", "connecting", "offline", "syncing", "paused", "connected"].includes(value.connectionState)) {
    throw new Error("connection state is invalid");
  }
  if (!expected.states.has(value.connectionState)) {
    throw new Error(
      `connection state ${String(value.connectionState)} not accepted; ${syncFailureSummary(value)}`,
    );
  }
  if (value.pendingCount !== expected.pending) {
    throw new Error(`pending count ${String(value.pendingCount)} != ${expected.pending}`);
  }
  if (value.totalEventCount !== expected.total) {
    throw new Error(`event count ${String(value.totalEventCount)} != ${expected.total}`);
  }
  if (!Array.isArray(value.uniqueEventIDs)
      || value.uniqueEventIDs.length !== expected.total
      || new Set(value.uniqueEventIDs).size !== expected.total
      || value.uniqueEventIDs.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("event IDs are not exactly-once unique");
  }
  if (!Array.isArray(value.localOrdinalEventIDs)
      || value.localOrdinalEventIDs.length !== expected.total
      || new Set(value.localOrdinalEventIDs).size !== expected.total
      || value.localOrdinalEventIDs.some(
        (eventID) => typeof eventID !== "string" || !value.uniqueEventIDs.includes(eventID),
      )) {
    throw new Error("local append-order event identities are missing or invalid");
  }
  const expectedSequences = Array.from(
    { length: expected.sequenceCount },
    (_, index) => index + 1,
  );
  if (!Array.isArray(value.acknowledgedServerSequences)
      || value.acknowledgedServerSequences.length !== expectedSequences.length
      || value.acknowledgedServerSequences.some(
        (sequence, index) => sequence !== expectedSequences[index],
      )) {
    throw new Error("server sequences are not contiguous and ordered");
  }
  if (!Array.isArray(value.acknowledgedEvents)
      || value.acknowledgedEvents.length !== expectedSequences.length) {
    throw new Error("acknowledged event pairs are missing or incomplete");
  }
  const acknowledgedIDs = [];
  for (const [index, acknowledgement] of value.acknowledgedEvents.entries()) {
    if (!acknowledgement || typeof acknowledgement !== "object"
        || acknowledgement.serverSequence !== expectedSequences[index]
        || typeof acknowledgement.eventID !== "string"
        || acknowledgement.eventID.length === 0) {
      throw new Error("acknowledged event pairs are not contiguous and ordered");
    }
    acknowledgedIDs.push(acknowledgement.eventID);
  }
  if (new Set(acknowledgedIDs).size !== acknowledgedIDs.length
      || acknowledgedIDs.some((eventID) => !value.uniqueEventIDs.includes(eventID))) {
    throw new Error("acknowledged event pairs are not exactly-once event identities");
  }
  if (acknowledgedIDs.some(
    (eventID, index) => eventID !== value.localOrdinalEventIDs[index],
  )) {
    throw new Error("acknowledged event pairs do not preserve local append order");
  }
  if (expected.sequenceCount === expected.total
      && (acknowledgedIDs.length !== value.uniqueEventIDs.length
          || value.uniqueEventIDs.some((eventID) => !acknowledgedIDs.includes(eventID)))) {
    throw new Error("fully acknowledged event identities do not match the local ledger");
  }
  if (value.acknowledgedServerSequences.some(
    (sequence, index) => sequence !== value.acknowledgedEvents[index].serverSequence,
  )) {
    throw new Error("legacy sequence evidence disagrees with ordered event pairs");
  }
  if (expected.errorMode === "none" && value.lastError != null) {
    throw new Error("unexpected sync error");
  }
  if (expected.errorMode === "required"
      && (typeof value.lastError !== "string" || value.lastError.length === 0)) {
    throw new Error("missing transport-offline error");
  }
  if (expected.outcome !== "any" && value.lastSyncOutcome !== expected.outcome) {
    throw new Error(`sync outcome ${String(value.lastSyncOutcome)} != ${expected.outcome}`);
  }
  if (!Number.isFinite(Date.parse(value.timestamp))) {
    throw new Error("artifact timestamp is invalid");
  }
}

function validateDiagnosticArtifact(value, expected) {
  if (!value || typeof value !== "object"
      || value.kind !== "NUMA_SHARED_E2E_DIAGNOSTIC_V1"
      || value.ready !== false
      || typeof value.terminal !== "boolean") {
    throw new Error("diagnostic artifact is malformed");
  }
  if (value.runID !== expected.runID
      || value.role !== expected.role
      || value.command !== expected.command) {
    throw new Error("diagnostic artifact runID, role, or command mismatch");
  }
  const stages = new Set([
    "configuration",
    "repository-bootstrap",
    "runtime-initialization",
    "command-preparation",
    "authentication",
    "journey-action",
    "artifact-reporting",
  ]);
  if (!stages.has(value.stage) || !Number.isFinite(Date.parse(value.timestamp))) {
    throw new Error("diagnostic artifact stage or timestamp is invalid");
  }
  if (value.terminal) {
    if (!/^E2E_[A-Z0-9_]{1,60}$/u.test(value.failureCode ?? "")) {
      throw new Error("terminal diagnostic code is invalid");
    }
  } else if (value.failureCode != null) {
    throw new Error("running diagnostic unexpectedly has a failure code");
  }
  return {
    terminal: value.terminal,
    stage: value.stage,
    failureCode: value.failureCode,
  };
}

async function resolveInviteTicket(args) {
  if (args.length !== 2) fail("Invalid invite-ticket arguments");
  const [siteValue, code] = args;
  const site = loopbackOrigin(siteValue);
  if (!/^[A-Z0-9]{6}$/u.test(code)) fail("Invite code is invalid");
  let response;
  try {
    response = await fetch(`${site}/join/${code}`, {
      method: "POST",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    fail("Invite preview request failed");
  }
  let preview;
  try {
    preview = await response.json();
  } catch {
    fail("Invite preview response is invalid");
  }
  if (!response.ok
      || preview?.status !== "active"
      || typeof preview.claimTicket !== "string"
      || preview.claimTicket.length < 32
      || preview.claimTicket.length > 4_096
      || !/^[!-~]+$/u.test(preview.claimTicket)) {
    fail("Invite preview did not return an active claim ticket");
  }
  process.stdout.write(preview.claimTicket);
}

function assertP3State(args) {
  if (args.length !== 7) fail("Invalid P3 state arguments");
  const [
    path,
    roleValue,
    activeMembersValue,
    expensesValue,
    settlementsValue,
    contestedValue,
    maximumRevisionsValue,
  ] = args;
  if (!new Set(["owner", "member", "none"]).has(roleValue)) {
    fail("Invalid P3 member role");
  }
  const expected = {
    currentMemberRole: roleValue === "none" ? null : roleValue,
    activeMemberCount: parseInteger("active member count", activeMembersValue),
    expenseRecordCount: parseInteger("expense record count", expensesValue),
    settlementRecordCount: parseInteger("settlement record count", settlementsValue),
    contestedRecordCount: parseInteger("contested record count", contestedValue),
    maximumRevisionCount: parseInteger("maximum revision count", maximumRevisionsValue),
  };
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("P3 state artifact is missing or invalid");
  }
  if (value?.ready !== true) fail("P3 state artifact is not ready");
  for (const [name, target] of Object.entries(expected)) {
    const actual = name === "currentMemberRole" && value[name] === undefined
      ? null
      : value[name];
    if (actual !== target) fail(`P3 state mismatch: ${name}`);
  }
  process.stdout.write(
    `P3 state PASS: role=${roleValue} members=${expected.activeMemberCount} expenses=${expected.expenseRecordCount} settlements=${expected.settlementRecordCount} contested=${expected.contestedRecordCount} revisions=${expected.maximumRevisionCount}\n`,
  );
}

function readAcknowledgedPairs(path, expectedCount) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`Acknowledgement artifact is missing or invalid: ${path}`);
  }
  if (!Array.isArray(value.acknowledgedEvents)
      || value.acknowledgedEvents.length !== expectedCount) {
    fail(`Acknowledgement pair count mismatch: ${path}`);
  }
  return value.acknowledgedEvents.map((pair) => {
    if (!pair || typeof pair !== "object"
        || !Number.isSafeInteger(pair.serverSequence)
        || pair.serverSequence < 1
        || typeof pair.eventID !== "string"
        || pair.eventID.length === 0) {
      fail(`Acknowledgement pair is invalid: ${path}`);
    }
    // Object key order is not part of JSON semantics and JSONEncoder does not
    // promise the same order across processes. Compare the explicit tuple.
    return [pair.serverSequence, pair.eventID];
  });
}

function assertAcknowledgedPairsEqual(args) {
  if (args.length !== 3) fail("Invalid acknowledgement comparison arguments");
  const [leftPath, rightPath, countValue] = args;
  const count = parseInteger("acknowledgement pair count", countValue);
  const left = readAcknowledgedPairs(leftPath, count);
  const right = readAcknowledgedPairs(rightPath, count);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    fail("Replica acknowledgement pairs differ in sequence or event identity");
  }
  process.stdout.write(`ordered acknowledgement pairs PASS: count=${count}\n`);
}

function readArtifactIdentity(args) {
  if (args.length !== 4) fail("Invalid artifact identity arguments");
  const [path, runID, role, command] = args;
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("Identity artifact is missing or invalid");
  }
  try {
    validateArtifact(value, {
      runID,
      role,
      command,
      states: new Set([value.connectionState]),
      pending: value.pendingCount,
      total: value.totalEventCount,
      sequenceCount: value.acknowledgedServerSequences?.length,
      errorMode: "any",
      outcome: "any",
    });
  } catch (error) {
    fail(`Identity artifact rejected: ${error?.message ?? "invalid"}`);
  }
  process.stdout.write(`${value.accountID}\t${value.activePotID}`);
}

async function waitForArtifact(args) {
  if (args.length !== 11) fail("Invalid artifact waiter arguments");
  const [
    path,
    runID,
    role,
    command,
    statesValue,
    pendingValue,
    totalValue,
    sequenceCountValue,
    errorMode,
    outcome,
    timeoutValue,
  ] = args;
  const states = new Set(statesValue.split(",").filter(Boolean));
  if (
    states.size === 0
    || ![...states].every((state) => [
      "local", "connecting", "offline", "syncing", "paused", "connected",
    ].includes(state))
    || !["none", "required", "any"].includes(errorMode)
    || !["completed", "already-running", "retry-scheduled", "paused", "any"].includes(outcome)
  ) {
    fail("Invalid artifact expectation");
  }
  const expected = {
    runID,
    role,
    command,
    states,
    pending: parseInteger("pending count", pendingValue),
    total: parseInteger("event count", totalValue),
    sequenceCount: parseInteger("sequence count", sequenceCountValue),
    errorMode,
    outcome,
  };
  if (expected.sequenceCount > expected.total) fail("Sequence count exceeds event count");
  const timeout = parseInteger("artifact timeout", timeoutValue, 1);
  const deadline = Date.now() + timeout;
  let lastFailure = "artifact has not been written";
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (value?.ready === false) {
        const diagnostic = validateDiagnosticArtifact(value, expected);
        if (diagnostic.terminal) {
          fail(
            `E2E failure: role=${role} command=${command} stage=${diagnostic.stage} code=${diagnostic.failureCode}`,
          );
        }
        lastFailure = `stage ${diagnostic.stage} is still running`;
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      validateArtifact(value, expected);
      process.stdout.write(
        `artifact PASS: role=${role} command=${command} state=${value.connectionState} pending=${expected.pending} events=${expected.total} sequences=${expected.sequenceCount}\n`,
      );
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") lastFailure = error?.message ?? "artifact is invalid";
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail(`Timed out waiting for role ${role} command ${command}: ${lastFailure}`);
}

async function sanitizeLog(args) {
  if (args.length !== 2) fail("Invalid simulator-log sanitizer arguments");
  const maxLines = parseInteger("simulator-log line limit", args[0], 1);
  const maxBytes = parseInteger("simulator-log byte limit", args[1], 256);
  if (maxLines > 500 || maxBytes > 131_072) {
    fail("Simulator-log sanitizer bound is too large");
  }
  const raw = await readStandardInput();
  const sanitized = raw
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => line
      .replace(/https?:\/\/[^\s"']+/giu, "[REDACTED]")
      .replace(/wss?:\/\/[^\s"']+/giu, "[REDACTED]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
      .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED]")
      .replace(/NUMA_SHARED_E2E_BOOTSTRAP_SECRET\s*[=:]\s*[^\s"']+/giu, "NUMA_SHARED_E2E_BOOTSTRAP_SECRET=[REDACTED]")
      .replace(/\b([A-Z][A-Z0-9_]{2,})\s*=\s*[^\s"']+/gu, "$1=[REDACTED]")
      .replace(/(^|\s)\/(?:Users|private|var|tmp)\/[^\s"']+/gu, "$1[REDACTED]")
      .replace(/\b[A-Za-z0-9_+/=-]{32,}\b/gu, "[REDACTED]"));
  const candidateLines = sanitized.slice(-maxLines);
  const header = `[DEBUG-E2E-LOG] bounded maxLines=${maxLines} maxBytes=${maxBytes}`;
  const selected = [];
  let usedBytes = Buffer.byteLength(`${header}\n`, "utf8");
  for (let index = candidateLines.length - 1; index >= 0; index -= 1) {
    const line = candidateLines[index];
    const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
    if (usedBytes + lineBytes > maxBytes) break;
    selected.unshift(line);
    usedBytes += lineBytes;
  }
  process.stdout.write(`${header}\n`);
  if (selected.length > 0) process.stdout.write(`${selected.join("\n")}\n`);
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "loopback" && args.length === 1) {
  validateLoopback(args[0]);
} else if (mode === "device" && args.length === 2) {
  await resolveDevice(args[0], args[1]);
} else if (mode === "identity") {
  readArtifactIdentity(args);
} else if (mode === "wait") {
  await waitForArtifact(args);
} else if (mode === "pairs-equal") {
  assertAcknowledgedPairsEqual(args);
} else if (mode === "resolve-ticket") {
  await resolveInviteTicket(args);
} else if (mode === "p3-state") {
  assertP3State(args);
} else if (mode === "sanitize-log") {
  await sanitizeLog(args);
} else {
  fail("Usage: sync-test-support.mjs loopback <url> | device <name> <runtime-key> | identity <artifact> <run> <role> <command> | wait <artifact> <run> <role> <command> <states> <pending> <total> <sequence-count> <none|required|any> <outcome|any> <timeout-ms> | pairs-equal <left-artifact> <right-artifact> <count> | resolve-ticket <site-url> <code> | p3-state <artifact> <role|none> <active-members> <expenses> <settlements> <contested> <max-revisions> | sanitize-log <max-lines> <max-bytes>");
}

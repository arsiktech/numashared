#!/usr/bin/env node

const candidateText = process.argv[2] ?? "";
if (!/^[1-9][0-9]*$/.test(candidateText)) {
  console.error("RELEASE PREFLIGHT FAIL: candidate build must be a positive integer");
  process.exit(64);
}

let inventory = "";
for await (const chunk of process.stdin) inventory += chunk;
const floors = [...inventory.matchAll(/^ASC_BUILD_FLOOR ([0-9]+)$/gm)];
if (floors.length !== 1) {
  console.error(
    `RELEASE PREFLIGHT FAIL: expected exactly one ASC_BUILD_FLOOR receipt, found ${floors.length}`,
  );
  process.exit(65);
}

const candidate = Number.parseInt(candidateText, 10);
const floor = Number.parseInt(floors[0][1], 10);
if (!Number.isSafeInteger(candidate) || !Number.isSafeInteger(floor)) {
  console.error("RELEASE PREFLIGHT FAIL: candidate or ASC build floor exceeds the safe integer range");
  process.exit(65);
}
if (candidate <= floor) {
  console.error(
    `RELEASE PREFLIGHT FAIL: candidate build ${candidate} must exceed ASC build/upload floor ${floor}`,
  );
  process.exit(1);
}

console.log(`ASC_BUILD_NUMBER PASS: candidate=${candidate} floor=${floor}`);

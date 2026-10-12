#!/usr/bin/env node

import { buildUploadState, combinedBuildFloor } from "../asc-build-floor.mjs";

const build = (version) => ({ attributes: { version } });
const upload = (version, state) => ({
  attributes: { cfBundleVersion: version, state: { state, errors: [], warnings: [] } },
});

if (combinedBuildFloor([], []) !== 0) throw new Error("Empty inventory floor must be zero");
if (combinedBuildFloor([], [upload("1", "PROCESSING")]) !== 1) {
  throw new Error("A processing upload must reserve its build number");
}
if (combinedBuildFloor([], [upload("2", "FAILED")]) !== 0) {
  throw new Error("A failed upload must not reserve its reusable build number");
}
if (combinedBuildFloor([build("3")], [upload("2", "COMPLETE")]) !== 3) {
  throw new Error("Processed and uploaded builds must share one maximum floor");
}
if (combinedBuildFloor([], [upload("9007199254740992", "PROCESSING")]) !== 0) {
  throw new Error("Unsafe build integers must not enter the floor");
}
if (buildUploadState({ attributes: { state: "AWAITING_UPLOAD" } }) !== "AWAITING_UPLOAD") {
  throw new Error("String upload state was not normalized");
}
if (buildUploadState({ attributes: {} }) !== "UNKNOWN") {
  throw new Error("Missing upload state must fail closed as UNKNOWN");
}

console.log("ASC build-floor contract test passed: processing/complete reserve, failed remains reusable");

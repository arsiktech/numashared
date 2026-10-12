export function buildUploadState(upload) {
  const stateDetails = upload?.attributes?.state;
  return typeof stateDetails === "string" ? stateDetails : stateDetails?.state ?? "UNKNOWN";
}

function positiveInteger(value) {
  const text = String(value ?? "");
  if (!/^[1-9][0-9]*$/.test(text)) return null;
  const number = Number.parseInt(text, 10);
  return Number.isSafeInteger(number) ? number : null;
}

export function combinedBuildFloor(builds, uploads) {
  const reserved = [];
  for (const build of builds) {
    const number = positiveInteger(build?.attributes?.version);
    if (number !== null) reserved.push(number);
  }
  for (const upload of uploads) {
    if (buildUploadState(upload) === "FAILED") continue;
    const number = positiveInteger(upload?.attributes?.cfBundleVersion);
    if (number !== null) reserved.push(number);
  }
  return reserved.length === 0 ? 0 : Math.max(...reserved);
}

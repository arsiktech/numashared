#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const approvedReleaseOrigin = "https://adept-camel-457.convex.site";
const approvedConvexURL = "https://adept-camel-457.convex.cloud";

function fail(message) {
  throw new Error(`RELEASE WEB PREFLIGHT FAIL: ${message}`);
}

function requireContentType(response, expected, path) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith(expected)) {
    fail(`${path} content type must start with ${expected}`);
  }
}

export function validateReleaseConvexURL(value) {
  if (value !== approvedConvexURL) {
    fail(`Convex URL must equal ${approvedConvexURL}`);
  }
}

export async function validateReleaseSite(siteOrigin, expectedAppID, fetchImpl = fetch) {
  let origin;
  try {
    const parsed = new URL(siteOrigin);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
      fail("site URL must be an HTTPS origin without credentials or a port");
    }
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
      fail("site URL must be an origin without a path, query, or fragment");
    }
    origin = parsed.origin;
  } catch (error) {
    if (error.message?.startsWith("RELEASE WEB PREFLIGHT FAIL:")) throw error;
    fail("site URL is invalid");
  }
  if (origin !== approvedReleaseOrigin) {
    fail(`release origin must equal ${approvedReleaseOrigin}`);
  }
  if (!/^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/.test(expectedAppID)) {
    fail("expected application identifier is invalid");
  }

  async function get(path, expectedContentType) {
    let response;
    try {
      response = await fetchImpl(new URL(path, `${origin}/`), {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      fail(`${path} request failed: ${error.message ?? "unknown error"}`);
    }
    if (response.status !== 200) fail(`${path} returned HTTP ${response.status}`);
    requireContentType(response, expectedContentType, path);
    return response.text();
  }

  const marketing = await get("/", "text/html");
  if (!marketing.includes("Numa Shared") || !marketing.includes("Shared expenses, made clear")) {
    fail("marketing root is not the configured Numa Shared site");
  }

  const invitePath = `/join/${"A".repeat(32)}?code=ABC123`;
  const invite = await get(invitePath, "text/html");
  if (
    !invite.includes("Numa Shared invite")
    || !invite.includes('<meta name="robots" content="noindex,nofollow">')
    || !invite.includes('<form method="post">')
  ) {
    fail("invite GET route is not the generic private Numa Shared landing page");
  }

  const privacy = await get("/privacy", "text/html");
  if (!privacy.includes("Numa Shared privacy policy")) {
    fail("privacy page is not the configured Numa Shared notice");
  }

  const support = await get("/support", "text/html");
  if (!support.includes("Numa Shared support")) {
    fail("support page is not the configured Numa Shared support page");
  }

  const associationText = await get(
    "/.well-known/apple-app-site-association",
    "application/json",
  );
  let association;
  try {
    association = JSON.parse(associationText);
  } catch {
    fail("AASA response is not valid JSON");
  }
  const details = association?.applinks?.details;
  const matchingDetails = Array.isArray(details)
    ? details.filter((detail) => {
      const appIDs = Array.isArray(detail?.appIDs)
        ? detail.appIDs
        : typeof detail?.appID === "string" ? [detail.appID] : [];
      return appIDs.includes(expectedAppID);
    })
    : [];
  if (matchingDetails.length === 0) {
    fail("AASA does not contain the release application identifier");
  }
  const allowsJoinOnly = matchingDetails.every((detail) => {
    if (Array.isArray(detail.components)) {
      return detail.components.length === 1
        && detail.components[0]?.["/"] === "/join/*"
        && detail.components[0]?.exclude !== true;
    }
    return Array.isArray(detail.paths)
      && detail.paths.length === 1
      && detail.paths[0] === "/join/*";
  });
  if (!allowsJoinOnly) {
    fail("AASA release application identifier must allow /join/* only");
  }

  const configurationText = await get("/app-config", "application/json");
  let configuration;
  try {
    configuration = JSON.parse(configurationText);
  } catch {
    fail("app-config response is not valid JSON");
  }
  const floor = configuration?.minimumSupportedBuild;
  if (!(floor === null || (Number.isSafeInteger(floor) && floor > 0))) {
    fail("app-config minimumSupportedBuild must be null or a positive integer");
  }

  return `RELEASE WEB PREFLIGHT PASS: origin=${origin} appID=${expectedAppID} minimumSupportedBuild=${floor ?? "none"}`;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (process.argv.length !== 5) {
    console.error("Usage: release-web-preflight.mjs <https-origin> <convex-url> <application-identifier>");
    process.exit(64);
  }
  try {
    validateReleaseConvexURL(process.argv[3]);
    console.log(await validateReleaseSite(process.argv[2], process.argv[4]));
  } catch (error) {
    console.error(error.message ?? String(error));
    process.exit(1);
  }
}

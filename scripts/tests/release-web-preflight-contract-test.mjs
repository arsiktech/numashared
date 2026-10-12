#!/usr/bin/env node

import {
  validateReleaseConvexURL,
  validateReleaseSite,
} from "../release-web-preflight.mjs";

const appID = "794UJ787LZ.tech.arsik.numashared";
const invitePath = `/join/${"A".repeat(32)}`;
const fixtures = new Map([
  ["/", [200, "text/html", "<h1>Numa Shared</h1><p>Shared expenses, made clear</p>"]],
  [
    invitePath,
    [
      200,
      "text/html",
      '<title>Numa Shared invite</title><meta name="robots" content="noindex,nofollow"><form method="post">',
    ],
  ],
  ["/privacy", [200, "text/html", "<h1>Numa Shared privacy policy</h1>"]],
  ["/support", [200, "text/html", "<h1>Numa Shared support</h1>"]],
  [
    "/.well-known/apple-app-site-association",
    [
      200,
      "application/json",
      JSON.stringify({
        applinks: {
          details: [{ appIDs: [appID], components: [{ "/": "/join/*" }] }],
        },
      }),
    ],
  ],
  ["/app-config", [200, "application/json", JSON.stringify({ minimumSupportedBuild: null })]],
]);

function response([status, contentType, body]) {
  return {
    status,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? contentType : null },
    text: async () => body,
  };
}

const fetchFixture = async (url) => response(fixtures.get(url.pathname));
const approvedOrigin = "https://adept-camel-457.convex.site";
validateReleaseConvexURL("https://adept-camel-457.convex.cloud");
try {
  validateReleaseConvexURL("https://another-project.convex.cloud");
  throw new Error("Unapproved Convex deployment unexpectedly passed");
} catch (error) {
  if (!error.message.includes("Convex URL must equal")) throw error;
}
const receipt = await validateReleaseSite(approvedOrigin, appID, fetchFixture);
if (!receipt.includes("RELEASE WEB PREFLIGHT PASS")) {
  throw new Error("Valid release web fixture did not pass");
}

try {
  await validateReleaseSite("https://shared.example.com", appID, fetchFixture);
  throw new Error("Unapproved release origin unexpectedly passed");
} catch (error) {
  if (!error.message.includes("release origin must equal")) throw error;
}

async function expectFailure(name, mutate, expected) {
  const altered = new Map(fixtures);
  mutate(altered);
  try {
    await validateReleaseSite(
      approvedOrigin,
      appID,
      async (url) => response(altered.get(url.pathname)),
    );
  } catch (error) {
    if (error.message.includes(expected)) return;
    throw new Error(`${name} failed for the wrong reason: ${error.message}`);
  }
  throw new Error(`${name} unexpectedly passed`);
}

await expectFailure(
  "missing marketing root",
  (items) => items.set("/", [404, "text/plain", "missing"]),
  "/ returned HTTP 404",
);
await expectFailure(
  "broken invite landing",
  (items) => items.set(invitePath, [200, "text/html", "<h1>Invite</h1>"]),
  "invite GET route",
);
await expectFailure(
  "redirect",
  (items) => items.set("/privacy", [302, "text/html", ""]),
  "/privacy returned HTTP 302",
);
await expectFailure(
  "wrong AASA app id",
  (items) => items.set(
    "/.well-known/apple-app-site-association",
    [
      200,
      "application/json",
      JSON.stringify({
        applinks: {
          details: [{ appIDs: ["OTHER.app"], components: [{ "/": "/join/*" }] }],
        },
      }),
    ],
  ),
  "AASA does not contain",
);
await expectFailure(
  "wrong AASA path",
  (items) => items.set(
    "/.well-known/apple-app-site-association",
    [
      200,
      "application/json",
      JSON.stringify({
        applinks: {
          details: [{ appIDs: [appID], components: [{ "/": "/*" }] }],
        },
      }),
    ],
  ),
  "must allow /join/* only",
);
await expectFailure(
  "additional AASA path",
  (items) => items.set(
    "/.well-known/apple-app-site-association",
    [
      200,
      "application/json",
      JSON.stringify({
        applinks: {
          details: [
            { appIDs: [appID], components: [{ "/": "/join/*" }] },
            { appIDs: [appID], components: [{ "/": "/*" }] },
          ],
        },
      }),
    ],
  ),
  "must allow /join/* only",
);
await expectFailure(
  "invalid app config",
  (items) => items.set(
    "/app-config",
    [200, "application/json", JSON.stringify({ minimumSupportedBuild: 0 })],
  ),
  "minimumSupportedBuild",
);

console.log("release web preflight contract test passed: marketing, invite GET, legal routes, AASA, and app-config fail closed");

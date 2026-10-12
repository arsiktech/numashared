#!/usr/bin/env node

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing local E2E input: ${name}`);
  return value;
}

function loopbackURL(name) {
  const value = required(name);
  const url = new URL(value);
  if (
    url.protocol !== "http:"
    || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
  ) {
    throw new Error(`Rejected non-loopback local E2E input: ${name}`);
  }
  return url.origin;
}

const randomSuffix = new Uint8Array(6);
crypto.getRandomValues(randomSuffix);
const runBase = randomSuffix.reduce(
  (value, byte) => (value << 8n) | BigInt(byte),
  0n,
);
const suffixMask = (1n << 48n) - 1n;

function id(value) {
  const suffix = (runBase + BigInt(value)) & suffixMask;
  return `01890f5e-7b00-7000-8000-${suffix.toString(16).padStart(12, "0")}`;
}

const cloudURL = loopbackURL("NUMA_SHARED_LOCAL_CLOUD_URL");
const siteURL = loopbackURL("NUMA_SHARED_LOCAL_SITE_URL");
const bootstrapSecret = required("NUMA_SHARED_E2E_BOOTSTRAP_SECRET");

const aasa = await fetch(`${siteURL}/.well-known/apple-app-site-association`, {
  redirect: "manual",
});
if (
  aasa.status !== 200
  || aasa.headers.get("content-type") !== "application/json; charset=utf-8"
  || aasa.headers.has("location")
) {
  throw new Error("Local AASA route did not return direct JSON");
}
const aasaBody = await aasa.json();
if (
  aasaBody?.applinks?.details?.[0]?.components?.[0]?.["/"] !== "/join/*"
  || aasaBody.applinks.details[0].appIDs?.length !== 1
) {
  throw new Error("Local AASA route returned an invalid contract");
}

const genericInvite = await fetch(`${siteURL}/join/LOCAL1`);
const genericInviteBody = await genericInvite.text();
if (
  genericInvite.status !== 200
  || !genericInviteBody.includes("Numa Shared invite")
  || !genericInviteBody.includes("<form method=\"post\">")
) {
  throw new Error("Local invite landing route was not generic and actionable");
}
const invalidPreview = await fetch(`${siteURL}/join/LOCAL1`, {
  method: "POST",
  headers: { accept: "application/json" },
});
if (
  invalidPreview.status !== 200
  || (await invalidPreview.json())?.status !== "invalid"
) {
  throw new Error("Local typed-code preview route did not fail closed");
}
for (const path of ["privacy", "support"]) {
  const response = await fetch(`${siteURL}/${path}`);
  if (response.status !== 200 || !(await response.text()).includes("Numa Shared")) {
    throw new Error(`Local ${path} route was unavailable`);
  }
}
process.stdout.write(
  "anonymous-local web entry proof passed: aasa=direct join=generic preview=invalid privacy=ready support=ready\n",
);

const bootstrap = await fetch(`${siteURL}/auth/e2e/bootstrap`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    bootstrapSecret,
    accountKey: "convex-local-smoke-single-account",
  }),
});
if (!bootstrap.ok) {
  throw new Error(`Local E2E bootstrap rejected with HTTP ${bootstrap.status}`);
}
const session = await bootstrap.json();
if (
  typeof session?.accessToken !== "string"
  || session.accessToken.split(".").length !== 3
  || session.e2e !== true
) {
  throw new Error("Local E2E bootstrap returned an invalid session");
}

const client = new ConvexHttpClient(cloudURL, { logger: false });
client.setAuth(session.accessToken);
const promoteLocalPot = makeFunctionReference("pots:promoteLocalPot");
const listMyPots = makeFunctionReference("pots:listMyPots");
const potId = id(9_001);
const ownerMemberId = id(9_002);
const configuration = {
  potId,
  currency: { code: "EUR", exponent: 2n },
  orderedUnitIds: [id(9_003), id(9_004), id(9_005)],
  ownerMemberId,
  minimumReaderSchemaVersion: 1n,
};
const event = {
  eventId: id(9_006),
  potId,
  actorMemberId: ownerMemberId,
  occurredAtMillis: 1_700_000_009_006n,
  originatingTimeZone: "Europe/Madrid",
  schemaVersion: 1n,
  payload: {
    kind: "expenseAdded",
    recordId: id(9_007),
    content: {
      expenseKind: "shared",
      amount: { minorUnits: 100n, currency: { code: "EUR", exponent: 2n } },
      payerUnitId: configuration.orderedUnitIds[0],
      allocations: [
        {
          unitId: configuration.orderedUnitIds[0],
          amount: { minorUnits: 50n, currency: { code: "EUR", exponent: 2n } },
        },
        {
          unitId: configuration.orderedUnitIds[1],
          amount: { minorUnits: 50n, currency: { code: "EUR", exponent: 2n } },
        },
      ],
    },
  },
  textFields: ["title"],
  authoredText: [{ field: "title", value: "Local authenticated smoke" }],
};
const promoted = await client.mutation(promoteLocalPot, {
  configuration,
  events: [event],
  ownerDisplayName: "Arseny",
});
if (
  promoted?.potId !== potId
  || promoted?.events?.length !== 1
  || promoted.events[0].eventId !== event.eventId
  || promoted.events[0].sequence !== 1n
) {
  throw new Error("Authenticated local promotion returned an invalid receipt");
}
const pots = await client.query(listMyPots, {});
if (
  !Array.isArray(pots)
  || pots.length !== 1
  || pots[0].potId !== potId
  || pots[0].lastSequence !== 1n
) {
  throw new Error("Authenticated local query did not read its own write");
}
process.stdout.write(
  "authenticated anonymous-local Convex mutation proof passed: promotion sequence=1 read-own-write=yes\n",
);

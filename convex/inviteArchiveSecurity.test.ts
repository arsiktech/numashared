import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import schema from "./schema";
import { modules } from "./test.setup";

const promote = makeFunctionReference<"mutation">("pots:promoteLocalPot");
const bindOwner = makeFunctionReference<"mutation">("members:bindOwnerUnit");
const bindPending = makeFunctionReference<"mutation">("members:bindPendingMember");
const changeGroups = makeFunctionReference<"mutation">("members:changeBudgetGroups");
const issue = makeFunctionReference<"mutation">("members:issueInvite");
const revoke = makeFunctionReference<"mutation">("members:revokeInvite");
const archive = makeFunctionReference<"mutation">("members:archiveMember");
const claimToken = makeFunctionReference<"mutation">("members:claimPerMemberInvite");
const claimTicket = makeFunctionReference<"mutation">("members:claimPerMemberInviteWithTicket");
const claimLink = makeFunctionReference<"mutation">("members:claimPotLinkInvite");
const approve = makeFunctionReference<"mutation">("members:approvePotLinkClaim");
const pendingClaims = makeFunctionReference<"query">("members:listPendingClaims");
const listEvents = makeFunctionReference<"query">("events:listEvents");

const id = (n: number) => `01890f5e-7b00-7000-8000-${n.toString(16).padStart(12, "0")}`;
const potId = id(1);
const ownerMemberId = id(2);
const pendingMemberId = id(3);
const token = "archive-test-token-0123456789abcdef0123456789abcdef";
const issuer = "https://auth.numa.shared";
const audience = "tech.arsik.numashared";

function identity(name: string) {
  return {
    issuer,
    subject: `security-account-${name}`,
    sid: `security-session-${name}`,
    numa_session_audience: audience,
    token_use: "access",
  };
}

function metadata(n: number, schemaVersion: bigint) {
  return {
    eventId: id(n),
    occurredAtMillis: BigInt(Date.now()),
    originatingTimeZone: "Europe/Madrid",
    schemaVersion,
  };
}

function event(n: number, schemaVersion: bigint, payload: Record<string, unknown>, actorMemberId = ownerMemberId) {
  return { ...metadata(n, schemaVersion), potId, actorMemberId, payload, textFields: [], authoredText: [] };
}

beforeEach(() => {
  vi.stubEnv("NUMA_SHARED_PRODUCT", "numa-shared");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_CLASS", "anonymous-local");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_NAME", "anonymous-security-test");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
  vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
  vi.stubEnv("NUMA_SHARED_TOKEN_HASH_SECRET", "archive-test-secret-at-least-thirty-two-bytes");
  vi.stubEnv("NUMA_SHARED_SESSION_ISSUER", issuer);
  vi.stubEnv("NUMA_SHARED_SESSION_AUDIENCE", audience);
});

afterEach(() => vi.unstubAllEnvs());

async function fixture(schemaVersion: bigint, kind: "perMember" | "potLink" = "perMember") {
  const t = convexTest(schema, modules);
  // Only identity fixtures are seeded. All membership/archival operations use
  // the same public mutations as the application, not direct ACL writes.
  await t.run(async (ctx) => {
    for (const name of ["owner", "joiner"]) {
      const accountId = await ctx.db.insert("accounts", {
        publicAccountId: identity(name).subject,
        appleSubjectHash: `security-subject-${name}`,
        createdAt: Date.now(),
      });
      await ctx.db.insert("sessions", {
        sessionId: identity(name).sid,
        accountId,
        refreshTokenHash: `security-refresh-${name}`,
        expiresAt: Date.now() + 86_400_000,
        createdAt: Date.now(),
        rotatedAt: Date.now(),
      });
    }
  });
  const owner = t.withIdentity(identity("owner"));
  const joiner = t.withIdentity(identity("joiner"));
  await owner.mutation(promote, {
    ownerDisplayName: "Fixture owner",
    configuration: {
      potId,
      currency: { code: "EUR", exponent: 2n },
      orderedUnitIds: [id(4), id(5)],
      ownerMemberId,
      minimumReaderSchemaVersion: 1n,
    },
    events: [],
  });
  await owner.mutation(bindOwner, {
    potId,
    event: event(10, 1n, { kind: "memberAdded", memberId: ownerMemberId, unitId: id(4), role: "owner" }),
  });
  await owner.mutation(bindPending, {
    potId,
    displayName: "Fixture pending member",
    event: event(11, 1n, { kind: "memberAdded", memberId: pendingMemberId, unitId: id(5), role: "member" }),
  });
  if (schemaVersion === 2n) {
    await owner.mutation(changeGroups, {
      potId,
      expectedTopologyRevision: 2n,
      event: event(12, 2n, { kind: "groupChanged", groups: [] }),
    });
  }
  const invite = {
    potId, inviteId: id(20), kind, token, code: "ARCH01",
    ...(kind === "perMember" ? { pendingMemberId } : {}),
    expiresAt: Date.now() + 86_400_000,
  };
  await owner.mutation(issue, invite);
  const response = await t.fetch("/join/ARCH01", {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  expect(response.status).toBe(200);
  const preview = await response.json() as { status: string; claimTicket: string };
  expect(preview.status).toBe("active");
  expect(typeof preview.claimTicket).toBe("string");
  const archivePending = () => owner.mutation(archive, {
    potId, event: event(30, schemaVersion, { kind: "memberArchived", memberId: pendingMemberId }),
  });
  const claimEvent = metadata(40, schemaVersion);
  const claim = (credential: "token" | "ticket") => credential === "token"
    ? joiner.mutation(claimToken, { token, event: claimEvent })
    : joiner.mutation(claimTicket, { ticket: preview.claimTicket, event: claimEvent });
  return { t, owner, joiner, invite, archivePending, claim };
}

async function snapshot(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ({
    pots: await ctx.db.query("pots").collect(),
    members: await ctx.db.query("potMembers").collect(),
    profiles: await ctx.db.query("potMemberProfiles").collect(),
    events: await ctx.db.query("events").collect(),
    invites: await ctx.db.query("invites").collect(),
    claims: await ctx.db.query("inviteClaims").collect(),
  }));
}

async function denied(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ data: { code, retryable: false } });
}

describe.each([1n, 2n])("archived invitation boundaries with schema %s", (schemaVersion) => {
  test.each(["token", "ticket"] as const)("an old %s cannot activate an archived pending member", async (credential) => {
    const f = await fixture(schemaVersion);
    await f.archivePending();
    const before = await snapshot(f.t);
    await denied(f.claim(credential), "MEMBER_ALREADY_ARCHIVED");
    expect(await snapshot(f.t)).toEqual(before);
    await denied(f.joiner.query(listEvents, { potId, afterSequence: 0n }), "NOT_MEMBER");
  });

  test.each(["token", "ticket"] as const)("a current %s still claims and retries without granting another account access", async (credential) => {
    const f = await fixture(schemaVersion);
    await denied(f.joiner.query(listEvents, { potId, afterSequence: 0n }), "NOT_MEMBER");
    const result = await f.claim(credential);
    expect(result).toMatchObject({ memberId: pendingMemberId, potId });
    const beforeReplay = await snapshot(f.t);
    expect(await f.claim(credential)).toEqual(result);
    expect(await snapshot(f.t)).toEqual(beforeReplay);
    const page = await f.joiner.query(listEvents, { potId, afterSequence: 0n });
    expect(page.events.length).toBeGreaterThan(0);
    // A session ID belonging to the owner cannot be paired with the joiner's subject.
    await denied(f.t.withIdentity({ ...identity("joiner"), sid: identity("owner").sid })
      .query(listEvents, { potId, afterSequence: 0n }), "AUTH_SESSION_REVOKED");
  });

  test("does not issue a new invite for an archived identity but retains exact issue receipts", async () => {
    const f = await fixture(schemaVersion);
    // Remove the sibling-invite blocker so the regression proves that archival,
    // rather than a still-active old credential, prevents new issuance.
    await f.owner.mutation(revoke, { potId, inviteId: f.invite.inviteId });
    await f.archivePending();
    const before = await snapshot(f.t);
    expect(await f.owner.mutation(issue, f.invite)).toEqual({ inviteId: f.invite.inviteId });
    await denied(f.owner.mutation(issue, {
      ...f.invite, inviteId: id(21), code: "ARCH02", token: `${token}-new`,
    }), "MEMBER_ALREADY_ARCHIVED");
    expect(await snapshot(f.t)).toEqual(before);
  });

  test("does not create a new pot-link claim naming an archived identity", async () => {
    const f = await fixture(schemaVersion, "potLink");
    await f.archivePending();
    const before = await snapshot(f.t);
    await denied(f.joiner.mutation(claimLink, { token, chosenMemberId: pendingMemberId }), "MEMBER_ALREADY_ARCHIVED");
    expect(await snapshot(f.t)).toEqual(before);
    await denied(f.joiner.query(listEvents, { potId, afterSequence: 0n }), "NOT_MEMBER");
  });

  test("a pending pot-link approval still grants access and returns the same receipt on retry", async () => {
    const f = await fixture(schemaVersion, "potLink");
    await f.joiner.mutation(claimLink, { token, chosenMemberId: pendingMemberId });
    await denied(f.joiner.query(listEvents, { potId, afterSequence: 0n }), "NOT_MEMBER");
    const claims = await f.owner.query(pendingClaims, { potId });
    expect(claims).toHaveLength(1);
    const request = {
      claimId: claims[0].claimId,
      memberId: pendingMemberId,
      event: event(40, schemaVersion, { kind: "memberClaimed", memberId: pendingMemberId }, pendingMemberId),
    };
    const result = await f.owner.mutation(approve, request);
    const beforeReplay = await snapshot(f.t);
    expect(await f.owner.mutation(approve, request)).toEqual(result);
    expect(await snapshot(f.t)).toEqual(beforeReplay);
    expect((await f.joiner.query(listEvents, { potId, afterSequence: 0n })).events.length).toBeGreaterThan(0);
  });

  test.each([true, false])("approval cannot activate an archived identity, chosen beforehand = %s", async (chosenBeforehand) => {
    const f = await fixture(schemaVersion, "potLink");
    const request = { token, ...(chosenBeforehand ? { chosenMemberId: pendingMemberId } : {}) };
    await f.joiner.mutation(claimLink, request);
    const claims = await f.owner.query(pendingClaims, { potId });
    expect(claims).toHaveLength(1);
    await f.archivePending();
    const before = await snapshot(f.t);
    await denied(f.owner.mutation(approve, {
      claimId: claims[0].claimId,
      memberId: pendingMemberId,
      event: event(40, schemaVersion, { kind: "memberClaimed", memberId: pendingMemberId }, pendingMemberId),
    }), "MEMBER_ALREADY_ARCHIVED");
    expect(await snapshot(f.t)).toEqual(before);
    // Recovering an existing pending receipt confers no access and remains idempotent.
    expect(await f.joiner.mutation(claimLink, request)).toEqual({ status: "pending" });
    await denied(f.joiner.query(listEvents, { potId, afterSequence: 0n }), "NOT_MEMBER");
  });
});

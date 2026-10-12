import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import schema from "./schema";
import { modules } from "./test.setup";

const legacy = makeFunctionReference<"query">("events:listTextChanges");
const current = makeFunctionReference<"query">("events:listTextChangesWithSkippedRevisions");
const potId = "archived-pot";

beforeEach(() => {
  vi.stubEnv("NUMA_SHARED_SESSION_ISSUER", "https://auth.numa.shared");
  vi.stubEnv("NUMA_SHARED_SESSION_AUDIENCE", "tech.arsik.numashared");
});
afterEach(() => vi.unstubAllEnvs());

async function fixture(sequences: bigint[], archived = true) {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const accountId = await ctx.db.insert("accounts", {
      publicAccountId: "reader", appleSubjectHash: "reader-subject", createdAt: 1,
    });
    await ctx.db.insert("sessions", {
      accountId, sessionId: "reader-session-000001", refreshTokenHash: "unused",
      createdAt: 1, rotatedAt: 1, expiresAt: Date.now() + 60_000,
    });
    await ctx.db.insert("potMembers", {
      accountId, potId, memberId: "reader-member", role: "member", joinedAt: 1,
      status: archived ? "archived" : "active",
      ...(archived ? { archivedAtSequence: 10n } : {}),
    });
    for (const [index, sequence] of sequences.entries()) {
      await ctx.db.insert("textRedactions", {
        potId, eventId: `event-${index + 1}`, sequence, revision: BigInt(index + 1),
        field: "title", redactedAt: 1,
      });
    }
  });
  return t.withIdentity({
    issuer: "https://auth.numa.shared", subject: "reader", sid: "reader-session-000001",
    numa_session_audience: "tech.arsik.numashared", token_use: "access",
  });
}

test("archived readers receive explicit skips without inaccessible IDs or fields", async () => {
  const client = await fixture([11n, 2n, 12n, 3n]);
  const page = await client.query(current, { potId, afterRevision: 0n });
  expect(page).toEqual({
    changes: [
      { eventId: "event-2", field: "title", revision: 2n, state: "redacted" },
      { eventId: "event-4", field: "title", revision: 4n, state: "redacted" },
    ],
    skippedRevisions: [1n, 3n], hasMore: false, nextAfterRevision: 4n,
  });
});

test("a fully filtered 500-row page advances and never includes row 501", async () => {
  const client = await fixture([...Array<bigint>(500).fill(11n), 1n]);
  const first = await client.query(current, { potId, afterRevision: 0n });
  expect(first.changes).toEqual([]);
  expect(first.skippedRevisions).toEqual(Array.from({ length: 500 }, (_, i) => BigInt(i + 1)));
  expect(first.hasMore).toBe(true);
  expect(first.nextAfterRevision).toBe(500n);
  const second = await client.query(current, { potId, afterRevision: first.nextAfterRevision });
  expect(second).toEqual({
    changes: [{ eventId: "event-501", field: "title", revision: 501n, state: "redacted" }],
    skippedRevisions: [], hasMore: false, nextAfterRevision: 501n,
  });
  const legacyFirst = await client.query(legacy, { potId, afterRevision: 0n });
  expect(legacyFirst).toEqual({ changes: [], hasMore: true, nextAfterRevision: 500n });
});

test("active and installed clients retain the original contiguous changes and shape", async () => {
  const client = await fixture([11n, 2n], false);
  const oldPage = await client.query(legacy, { potId, afterRevision: 0n });
  const newPage = await client.query(current, { potId, afterRevision: 0n });
  expect(newPage).toEqual({ ...oldPage, skippedRevisions: [] });
  expect(oldPage.changes.map((change: { revision: bigint }) => change.revision)).toEqual([1n, 2n]);
  expect(Object.keys(oldPage).sort()).toEqual(["changes", "hasMore", "nextAfterRevision"]);
});

test("new endpoint still denies nonmember pots", async () => {
  const client = await fixture([1n]);
  await expect(client.query(current, { potId: "another-pot", afterRevision: 0n }))
    .rejects.toThrow("NOT_MEMBER");
});

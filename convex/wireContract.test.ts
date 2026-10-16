import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import authoredTextBlankParityJSON from "../NumaSharedCore/Tests/NumaSharedCoreTests/Fixtures/authored-text-blank-parity.json";
import wireEventsJSON from "../NumaSharedCore/Tests/NumaSharedCoreTests/Fixtures/wire-events-v1.json";
import schema from "./schema";
import {
  validateEvent,
  type EventInput,
  type PotConfigurationInput,
} from "./lib/eventValidation";
import { modules } from "./test.setup";

const promoteLocalPot = makeFunctionReference<"mutation">("pots:promoteLocalPot");
const listEvents = makeFunctionReference<"query">("events:listEvents");

type JSONValue = null | boolean | string | number | JSONValue[] | {
  [key: string]: JSONValue;
};
type ConvexFixtureValue = null | boolean | string | number | bigint
  | ConvexFixtureValue[] | { [key: string]: ConvexFixtureValue };

const int64Fields = new Set([
  "occurredAtMillis",
  "schemaVersion",
  "minorUnits",
  "exponent",
  "defaultShareWeight",
]);

function withConvexInt64(value: JSONValue, field?: string): ConvexFixtureValue {
  if (typeof value === "number" && field !== undefined && int64Fields.has(field)) {
    if (!Number.isSafeInteger(value)) throw new Error(`Unsafe fixture int64: ${field}`);
    return BigInt(value);
  }
  if (Array.isArray(value)) return value.map((nested) => withConvexInt64(nested));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, withConvexInt64(nested, key)]),
    );
  }
  return value;
}

function collectUnitIds(value: ConvexFixtureValue, field?: string, result = new Set<string>()) {
  if (typeof value === "string" && field !== undefined && (
    field === "unitId" || field === "payerUnitId" || field === "fromUnitId"
    || field === "toUnitId"
  )) {
    result.add(value);
  } else if (Array.isArray(value)) {
    for (const nested of value) collectUnitIds(nested, field, result);
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (key === "orderedUnitIds" && Array.isArray(nested)) {
        for (const unitId of nested) {
          if (typeof unitId === "string") result.add(unitId);
        }
      } else {
        collectUnitIds(nested, key, result);
      }
    }
  }
  return result;
}

beforeEach(() => {
  vi.stubEnv("NUMA_SHARED_PRODUCT", "numa-shared");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_CLASS", "anonymous-local");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_NAME", "anonymous-agent");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
  vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
  vi.stubEnv("NUMA_SHARED_SESSION_ISSUER", "https://auth.numa.shared");
  vi.stubEnv("NUMA_SHARED_SESSION_AUDIENCE", "tech.arsik.numashared");
});

afterEach(() => vi.unstubAllEnvs());

describe("Swift and Convex v1 wire contract", () => {
  test("matches Foundation blank admission for required title and reason text", () => {
    const fixture = withConvexInt64(wireEventsJSON as unknown as JSONValue) as Array<{
      potId: string;
      actorMemberId: string;
      payload: { kind: string };
      authoredText: Array<{ field: string; value: string }>;
      [key: string]: ConvexFixtureValue;
    }>;
    const configuration = {
      potId: fixture[0].potId,
      currency: { code: "EUR", exponent: 2n },
      orderedUnitIds: [...collectUnitIds(fixture)],
      ownerMemberId: fixture[0].actorMemberId,
      minimumReaderSchemaVersion: 1n,
    } satisfies PotConfigurationInput;
    const expense = fixture.find(({ payload }) => payload.kind === "expenseAdded");
    const voided = fixture.find(({ payload }) => payload.kind === "recordVoided");
    expect(expense).toBeDefined();
    expect(voided).toBeDefined();

    for (const parityCase of authoredTextBlankParityJSON) {
      for (const [source, field] of [
        [expense!, "title"],
        [voided!, "reason"],
      ] as const) {
        const candidate = {
          ...source,
          authoredText: source.authoredText.map((authored) => (
            authored.field === field
              ? { ...authored, value: parityCase.value }
              : authored
          )),
        } as unknown as EventInput;
        const validate = () => validateEvent(candidate, configuration);
        const message = `${field}: ${parityCase.name}`;
        if (parityCase.isBlank) {
          expect(validate, message).toThrow();
        } else {
          expect(validate, message).not.toThrow();
        }
      }
    }
  });

  test("accepts Core-valid zero-sum openings regardless of Int64 prefix order", () => {
    const configuration = {
      potId: "01890f5e-7b00-7000-8000-000000009000",
      currency: { code: "EUR", exponent: 2n },
      orderedUnitIds: [
        "01890f5e-7b00-7000-8000-000000009002",
        "01890f5e-7b00-7000-8000-000000009003",
        "01890f5e-7b00-7000-8000-000000009004",
      ],
      ownerMemberId: "01890f5e-7b00-7000-8000-000000009001",
      minimumReaderSchemaVersion: 1n,
    } satisfies PotConfigurationInput;
    const event = {
      eventId: "01890f5e-7b00-7000-8000-000000009006",
      potId: configuration.potId,
      actorMemberId: configuration.ownerMemberId,
      occurredAtMillis: 1_700_000_009_006n,
      originatingTimeZone: "Europe/Madrid",
      schemaVersion: 1n,
      payload: {
        kind: "openingBalanceSet",
        recordId: "01890f5e-7b00-7000-8000-000000009005",
        content: {
          entries: [
            {
              unitId: configuration.orderedUnitIds[0],
              amount: {
                minorUnits: (1n << 63n) - 1n,
                currency: configuration.currency,
              },
            },
            {
              unitId: configuration.orderedUnitIds[1],
              amount: { minorUnits: 1n, currency: configuration.currency },
            },
            {
              unitId: configuration.orderedUnitIds[2],
              amount: {
                minorUnits: -(1n << 63n),
                currency: configuration.currency,
              },
            },
          ],
        },
      },
      textFields: ["title"],
      authoredText: [{ field: "title", value: "Opening balances" }],
    } satisfies EventInput;

    expect(() => validateEvent(event, configuration)).not.toThrow();
  });

  test("validates every golden shape and round-trips the state-valid P2 subset without loss", async () => {
    const fixture = withConvexInt64(wireEventsJSON as unknown as JSONValue) as Array<{
      eventId: string;
      potId: string;
      actorMemberId: string;
      authoredText: Array<{ field: string; value: string }>;
      [key: string]: ConvexFixtureValue;
    }>;
    expect(fixture).toHaveLength(17);
    const configuration = {
      potId: fixture[0].potId,
      currency: { code: "EUR", exponent: 2n },
      orderedUnitIds: [...collectUnitIds(fixture)],
      ownerMemberId: fixture[0].actorMemberId,
      minimumReaderSchemaVersion: 1n,
    } satisfies PotConfigurationInput;
    for (const event of fixture) {
      expect(() => validateEvent(event as unknown as EventInput, configuration))
        .not.toThrow();
    }

    // The shared fixture is a wire-shape catalog, not a valid event history:
    // its revisions intentionally reference omitted parents and it includes P3
    // structural kinds. Only the ordered, state-valid P2 subset may sequence.
    const p2EventIndexes = new Set([0, 3, 4, 5, 6, 7]);
    const sequenced = fixture.filter((_, index) => p2EventIndexes.has(index));
    const t = convexTest(schema, modules);
    const accountId = await t.run(async (ctx) => await ctx.db.insert("accounts", {
      publicAccountId: "wire-contract-account",
      appleSubjectHash: "wire-contract-apple-subject",
      createdAt: 1,
    }));
    await t.run(async (ctx) => await ctx.db.insert("sessions", {
      sessionId: "wire-contract-session-0001",
      accountId,
      refreshTokenHash: "wire-contract-refresh-hash",
      expiresAt: Date.now() + 60_000,
      createdAt: 1,
      rotatedAt: 1,
    }));
    const identity = t.withIdentity({
      issuer: "https://auth.numa.shared",
      subject: "wire-contract-account",
      sid: "wire-contract-session-0001",
      numa_session_audience: "tech.arsik.numashared",
      token_use: "access",
    });

    await identity.mutation(promoteLocalPot, {
      ownerDisplayName: "Arseny",
      configuration,
      events: sequenced,
    });
    const listed = await identity.query(listEvents, {
      potId: fixture[0].potId,
      afterSequence: 0n,
    });

    expect(listed.events).toHaveLength(sequenced.length);
    for (const [index, uploaded] of sequenced.entries()) {
      expect(listed.events[index]).toEqual({
        event: { ...uploaded, authoredText: [] },
        serverSequence: BigInt(index + 1),
        textStates: uploaded.authoredText.map(({ field, value }) => ({
          field,
          state: "present",
          value,
        })),
      });
    }
  });
  test("accepts an expense note, a repayment method and note, and an edit reason", () => {
    const fixture = withConvexInt64(wireEventsJSON as unknown as JSONValue) as Array<{
      potId: string;
      actorMemberId: string;
      payload: { kind: string; content?: { kind?: string } };
      textFields: string[];
      authoredText: Array<{ field: string; value: string }>;
      [key: string]: ConvexFixtureValue;
    }>;
    const configuration = {
      potId: fixture[0].potId,
      currency: { code: "EUR", exponent: 2n },
      orderedUnitIds: [...collectUnitIds(fixture)],
      ownerMemberId: fixture[0].actorMemberId,
      minimumReaderSchemaVersion: 1n,
    } satisfies PotConfigurationInput;
    const withText = (
      source: (typeof fixture)[number],
      text: Array<{ field: string; value: string }>,
    ) => ({
      ...source,
      textFields: text.map(({ field }) => field),
      authoredText: text,
    }) as unknown as EventInput;
    const expense = fixture.find(({ payload }) => payload.kind === "expenseAdded")!;
    const revision = fixture.find(({ payload }) => (
      payload.kind === "expenseRevised" && payload.content?.kind === "expense"
    ))!;
    const settlement = fixture.find(({ payload }) => payload.kind === "settlementRecorded")!;
    expect(revision).toBeDefined();

    expect(() => validateEvent(withText(expense, [
      { field: "title", value: "Groceries" },
      { field: "category", value: "groceries" },
      { field: "note", value: "Apples, bread and coffee" },
    ]), configuration)).not.toThrow();
    expect(() => validateEvent(withText(revision, [
      { field: "title", value: "Groceries" },
      { field: "note", value: "Apples" },
      { field: "reason", value: "Wrong amount" },
    ]), configuration)).not.toThrow();
    expect(() => validateEvent(withText(settlement, [
      { field: "title", value: "Repayment" },
      { field: "category", value: "bank" },
      { field: "note", value: "Half now, half on Friday" },
    ]), configuration)).not.toThrow();

    // Still required, still canonical, still nonblank.
    expect(() => validateEvent(withText(settlement, [
      { field: "note", value: "No title" },
    ]), configuration)).toThrow("TEXT_FIELD_REQUIRED_TITLE");
    expect(() => validateEvent(withText(settlement, [
      { field: "title", value: "Repayment" },
      { field: "reason", value: "Not a repayment field" },
    ]), configuration)).toThrow("TEXT_FIELD_NOT_ALLOWED_REASON");
    expect(() => validateEvent(withText(expense, [
      { field: "title", value: "Groceries" },
      { field: "note", value: "   " },
    ]), configuration)).toThrow();
    expect(() => validateEvent(withText(expense, [
      { field: "title", value: "Groceries" },
      { field: "reason", value: "Edits only" },
    ]), configuration)).toThrow("TEXT_FIELD_NOT_ALLOWED_REASON");
  });
});

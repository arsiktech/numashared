import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Doc } from "./_generated/dataModel";
import { sha256Hex } from "./lib/hash";
import { hashInviteCode } from "./lib/inviteCode";
import schema from "./schema";
import { modules } from "./test.setup";

const nowMillis = 1_750_000_000_000;
const inviteSecret = "web-test-token-hash-secret-at-least-32-bytes";
const setMinimumSupportedBuild = makeFunctionReference<"mutation">(
  "configuration:setMinimumSupportedBuild",
);

async function seedInvite(
  t: ReturnType<typeof convexTest>,
  args: {
    code: string;
    token?: string;
    status?: Doc<"invites">["status"];
    kind?: Doc<"invites">["kind"];
    expiresAt?: number;
    potName?: string;
    minimumReaderSchemaVersion?: bigint;
  },
): Promise<void> {
  await t.run(async (ctx) => {
    const codeDigest = await sha256Hex(args.code);
    const accountId = await ctx.db.insert("accounts", {
      publicAccountId: `account-${args.code}`,
      appleSubjectHash: `subject-${args.code}`,
      createdAt: nowMillis,
    });
    const potId = `01890f5e-7b00-7000-8000-${args.code.padStart(12, "0")}`;
    await ctx.db.insert("pots", {
      potId,
      currencyCode: "EUR",
      currencyExponent: 2n,
      orderedUnitIds: ["01890f5e-7b00-7000-8000-000000000001"],
      ownerAccountId: accountId,
      ...(args.potName === undefined ? {} : { name: args.potName }),
      minimumReaderSchemaVersion: args.minimumReaderSchemaVersion ?? 1n,
      nextSequence: 1n,
      nextTextRevision: 1n,
      positiveContributionBudget: 0n,
      negativeContributionBudget: 0n,
      createdAt: nowMillis,
    });
    await ctx.db.insert("invites", {
      potId,
      inviteId: `01890f5e-7b00-7000-9000-${codeDigest.slice(0, 12)}`,
      kind: args.kind ?? "perMember",
      tokenHash: await sha256Hex(
        args.token ?? `long-token-${args.code}`.padEnd(40, "x"),
      ),
      codeHash: await hashInviteCode(args.code, inviteSecret),
      ...(args.kind === "potLink"
        ? {}
        : { pendingMemberId: "01890f5e-7b00-7000-8000-000000000002" }),
      issuedByAccountId: accountId,
      status: args.status ?? "active",
      expiresAt: args.expiresAt ?? nowMillis + 86_400_000,
      createdAt: nowMillis,
    });
  });
}

async function preview(
  t: ReturnType<typeof convexTest>,
  code: string,
  source = `source-${code}`,
): Promise<Response> {
  return await t.fetch(`/join/${code}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "x-numa-shared-test-source": source,
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(nowMillis);
  vi.stubEnv("NUMA_SHARED_PRODUCT", "numa-shared");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_CLASS", "anonymous-local");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_NAME", "anonymous-agent");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
  vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
  vi.stubEnv(
    "NUMA_SHARED_TOKEN_HASH_SECRET",
    inviteSecret,
  );
  vi.stubEnv(
    "NUMA_SHARED_APP_IDENTIFIER",
    "794UJ787LZ.tech.arsik.numashared",
  );
  vi.stubEnv(
    "NUMA_SHARED_APP_STORE_URL",
    "https://apps.apple.com/app/id1234567890",
  );
  vi.stubEnv("NUMA_SHARED_CONTROLLER_NAME", "Arseny & Co");
  vi.stubEnv("NUMA_SHARED_CONTROLLER_ADDRESS", "Madrid, Spain");
  vi.stubEnv("NUMA_SHARED_PRIVACY_EMAIL", "privacy@example.com");
  vi.stubEnv("NUMA_SHARED_SUPPORT_EMAIL", "support@example.com");
  vi.stubEnv(
    "NUMA_SHARED_TRANSFER_MECHANISM",
    "the controller-approved Convex DPA transfer safeguard.",
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("free-host web entry", () => {
  test("serves the Numa Shared marketing root with the narrowest CSP it needs", async () => {
    const t = convexTest(schema, modules);
    const response = await t.fetch("/");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(body).toContain("Numa Shared");
    expect(body).toContain("Shared expenses,<br>made clear.");
    expect(body).toContain("Never moves money");
    expect(body).toContain('href="/privacy"');
    expect(body).toContain('href="/support"');
    expect(body).toContain('href="/terms"');
    expect(body).toContain("mailto:support@example.com?subject=Numa%20Shared%20TestFlight");
    expect(body).not.toContain("{{");
    expect(body).not.toContain("shared.numaworth.com");
    expect(body).not.toContain("\u2014");
    // Progressive enhancement: one same-origin script, no inline script, no
    // third-party hosts, and every claim stays inside the private-beta rules.
    expect(body.match(/<script\b/gi)).toHaveLength(1);
    expect(body).toMatch(/<script src="\/assets\/home\.js\?v=[0-9a-f]{10}"><\/script>/);
    expect(body).not.toMatch(/https?:\/\/(?!apps\.apple\.com)/i);
    expect(body).not.toMatch(/<link\b[^>]*rel=["']stylesheet["']/i);
    expect(body).not.toMatch(/free forever|no data collection|public beta|available on the App Store/i);
    for (const match of body.matchAll(/src="(\/assets\/[^"]+)"/g)) {
      expect(match[1]).toMatch(/^\/assets\/[a-z0-9.-]+\?v=[0-9a-f]{10}$/);
    }
  });

  test("serves the marketing route's static files and nothing else under /assets/", async () => {
    const t = convexTest(schema, modules);
    const script = await t.fetch("/assets/home.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(script.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await script.text()).toContain("the page is the shared table");

    const font = await t.fetch("/assets/bricolage-700.woff2");
    expect(font.headers.get("content-type")).toBe("font/woff2");
    const fontBytes = new Uint8Array(await font.arrayBuffer());
    expect(String.fromCharCode(...fontBytes.slice(0, 4))).toBe("wOF2");

    for (const name of ["app-home.webp", "app-expense.webp"]) {
      const image = await t.fetch(`/assets/${name}`);
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe("image/webp");
      const bytes = new Uint8Array(await image.arrayBuffer());
      expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    }

    for (const path of ["/assets/", "/assets/missing.js", "/assets/constructor", "/assets/__proto__", "/assets/..%2Fhttp.ts"]) {
      const response = await t.fetch(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    }
  });

  test("keeps every other HTML route on the strict no-script CSP", async () => {
    const t = convexTest(schema, modules);
    const strict = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
    for (const path of ["/privacy", "/support", "/terms", "/join/abc-123"]) {
      const response = await t.fetch(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toBe(strict);
      expect(await response.text()).not.toMatch(/<script\b/i);
    }
  });

  test("serves a direct modern AASA document for join links only", async () => {
    const t = convexTest(schema, modules);
    const response = await t.fetch("/.well-known/apple-app-site-association");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("location")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      applinks: {
        apps: [],
        details: [{
          appIDs: ["794UJ787LZ.tech.arsik.numashared"],
          components: [{
            "/": "/join/*",
            caseSensitive: false,
            comment: "Matches Numa Shared invite links only.",
          }],
        }],
      },
    });
  });

  test("the home page leads into the web app when there is one", async () => {
    vi.stubEnv("NUMA_SHARED_WEB_APP_URL", "https://shared.example.com/app");
    const t = convexTest(schema, modules);
    const body = await (await t.fetch("/")).text();
    expect(body).toContain('class="button" href="https://shared.example.com/app/">Open the web app');
    expect(body).toContain('class="orb orb--link" data-orb href="https://shared.example.com/app/"');
    expect(body).toContain("Free during the beta.");
    expect(body).toContain("Ask to test the iPhone app");
    expect(body).not.toContain("<!--web-->");
    expect(body).not.toContain("<!--noweb-->");
    expect(body).not.toContain("{{");
    expect(body).not.toMatch(/Come to the table|Press the orb|on this iPhone/);

    vi.stubEnv("NUMA_SHARED_WEB_APP_URL", "");
    const plain = await (await t.fetch("/")).text();
    expect(plain).not.toContain("Open the web app");
    expect(plain).toContain("Request TestFlight access");
    expect(plain).not.toContain("<!--");
  });

  test("offers invitation-only beta access without requiring an App Store listing", async () => {
    vi.stubEnv("NUMA_SHARED_APP_STORE_URL", "");
    const t = convexTest(schema, modules);
    const response = await t.fetch("/");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Private beta for iPhone");
    expect(body).toContain("Beta access is by invitation.");
    expect(body).toContain("mailto:support@example.com?subject=Numa%20Shared%20TestFlight");
    expect(body).not.toContain("apps.apple.com");

    const support = await t.fetch("/support");
    expect(support.status).toBe(200);
    const supportBody = await support.text();
    expect(supportBody).toContain('href="/">Numa Shared home');
    expect(supportBody).not.toContain("apps.apple.com");

    vi.stubEnv("NUMA_SHARED_SUPPORT_EMAIL", "");
    expect((await t.fetch("/")).status).toBe(503);
  });

  test("keeps crawler-visible invite HTML generic until a deliberate POST", async () => {
    const t = convexTest(schema, modules);
    await seedInvite(t, { code: "ABC123", potName: "Casa Mar" });

    const response = await t.fetch("/join/abc-123");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).not.toContain("script-src");
    expect(body).toContain("<meta property=\"og:title\" content=\"Numa Shared invite\">");
    expect(body).toContain("<form method=\"post\">");
    expect(body).toContain("https://apps.apple.com/app/id1234567890");
    expect(body).not.toContain("Casa Mar");
    expect(body).not.toContain("perMember");
    expect(body).not.toContain("claimTicket");
  });

  test("invites offer the web app and the TestFlight beta instead of a missing listing", async () => {
    vi.stubEnv("NUMA_SHARED_APP_STORE_URL", "");
    vi.stubEnv("NUMA_SHARED_TESTFLIGHT_URL", "https://testflight.apple.com/join/AbCd1234");
    vi.stubEnv("NUMA_SHARED_WEB_APP_URL", "https://shared.example.com/app/");
    const t = convexTest(schema, modules);
    await seedInvite(t, { code: "ABC123", potName: "Casa Mar" });

    const landing = await t.fetch("/join/abc-123?code=abc123");
    const body = await landing.text();
    expect(landing.status).toBe(200);
    expect(body).toContain('href="https://shared.example.com/app/join?code=ABC123">Open in your browser');
    expect(body).toContain('href="https://testflight.apple.com/join/AbCd1234">Get the iPhone app (TestFlight beta)');
    expect(body).not.toContain("apps.apple.com");
    expect(body).not.toContain("Casa Mar");

    // A code that isn't one is left out of the link rather than echoed.
    expect(await (await t.fetch("/join/abc-123?code=%3Cb%3E")).text()).toContain('href="https://shared.example.com/app/join">');

    vi.stubEnv("NUMA_SHARED_TESTFLIGHT_URL", "https://example.com/join/AbCd1234");
    expect((await t.fetch("/join/abc-123")).status).toBe(503);
  });

  test("the web app's origin, and only it, may call the endpoints it uses", async () => {
    vi.stubEnv("NUMA_SHARED_WEB_ORIGINS", "https://shared.example.com");
    const t = convexTest(schema, modules);
    const ok = await t.fetch("/auth/refresh", { method: "OPTIONS", headers: { Origin: "https://shared.example.com" } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://shared.example.com");
    expect((await t.fetch("/auth/refresh", { method: "OPTIONS", headers: { Origin: "https://evil.example" } })).status).toBe(403);

    const config = await t.fetch("/app-config", { headers: { Origin: "https://shared.example.com" } });
    expect(config.headers.get("access-control-allow-origin")).toBe("https://shared.example.com");
    const other = await t.fetch("/app-config", { headers: { Origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    // Pages people open directly never get CORS headers.
    expect((await t.fetch("/privacy", { headers: { Origin: "https://shared.example.com" } })).headers.get("access-control-allow-origin")).toBeNull();
  });

  test("resolves a long-token link and its separate typed-code fallback", async () => {
    const t = convexTest(schema, modules);
    const token = "link-token-0123456789abcdef0123456789abcdef";
    await seedInvite(t, { code: "LINK01", token, potName: "Casa Mar" });

    const linkResponse = await t.fetch(`/join/${token}?code=LINK01`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "x-numa-shared-test-source": "long-link",
      },
    });
    await expect(linkResponse.json()).resolves.toMatchObject({
      status: "active",
      potName: "Casa Mar",
    });

    const codeResponse = await preview(t, "link-01", "typed-fallback");
    await expect(codeResponse.json()).resolves.toMatchObject({
      status: "active",
      potName: "Casa Mar",
    });

    const mismatched = await t.fetch(`/join/${token}?code=WRONG1`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "x-numa-shared-test-source": "mismatched-code",
      },
    });
    await expect(mismatched.json()).resolves.toEqual({ status: "invalid" });
  });

  test("publishes the verified target schema as bounded JSON, not a bigint or another pot's schema", async () => {
    const t = convexTest(schema, modules);
    await seedInvite(t, { code: "GRP002", minimumReaderSchemaVersion: 2n });
    const response = await preview(t, "GRP002");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "active", minimumReaderSchemaVersion: 2 });
  });

  test("reveals only limited active-invite detail and a short-lived opaque ticket", async () => {
    const t = convexTest(schema, modules);
    await seedInvite(t, { code: "ABC123", potName: "Casa Mar" });

    const response = await preview(t, "abc-123");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const value = await response.json() as Record<string, unknown>;
    expect(value).toMatchObject({
      status: "active",
      kind: "perMember",
      potName: "Casa Mar",
      expiresAt: nowMillis + 86_400_000,
      minimumReaderSchemaVersion: 1,
    });
    expect(value.claimTicket).toEqual(expect.stringMatching(
      /^[A-Za-z0-9_-]+\.[0-9]+\.[A-Za-z0-9_-]{43}$/,
    ));
    expect(Object.keys(value).sort()).toEqual([
      "claimTicket",
      "expiresAt",
      "kind",
      "minimumReaderSchemaVersion",
      "potName",
      "status",
    ]);
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain("tokenHash");
    expect(serialized).not.toContain("pendingMemberId");
    expect(serialized).not.toContain("minorUnits");
  });

  test("returns calm non-active states without pot detail or a claim ticket", async () => {
    const t = convexTest(schema, modules);
    await seedInvite(t, {
      code: "EXP123",
      expiresAt: nowMillis - 1,
      potName: "Expired private name",
    });
    await seedInvite(t, {
      code: "REV123",
      status: "revoked",
      potName: "Revoked private name",
    });
    await seedInvite(t, {
      code: "USE123",
      status: "consumed",
      potName: "Used private name",
    });

    for (const [code, status] of [
      ["EXP123", "expired"],
      ["REV123", "revoked"],
      ["USE123", "used"],
      ["BAD123", "invalid"],
    ]) {
      const response = await preview(t, code);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status });
    }
  });

  test("rate-limits both one source and distributed guesses at one code", async () => {
    const sourceLimited = convexTest(schema, modules);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = `A${attempt.toString(36).toUpperCase().padStart(5, "0")}`;
      expect((await preview(sourceLimited, code, "one-source")).status).toBe(200);
    }
    const sourceBlocked = await preview(sourceLimited, "AZZZZZ", "one-source");
    expect(sourceBlocked.status).toBe(429);
    expect(sourceBlocked.headers.get("retry-after")).toBe("60");

    const codeLimited = convexTest(schema, modules);
    await seedInvite(codeLimited, { code: "HOT123", kind: "potLink" });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await preview(codeLimited, "HOT123", `distributed-${attempt}`)).status)
        .toBe(200);
    }
    expect((await preview(codeLimited, "HOT123", "distributed-blocked")).status)
      .toBe(429);
  });

  test("renders an active human preview without exposing the claim ticket", async () => {
    const t = convexTest(schema, modules);
    const token = "html-link-token-0123456789abcdef0123456789abcdef";
    await seedInvite(t, {
      code: "HTML12",
      token,
      kind: "potLink",
      potName: "Casa Mar",
    });

    const response = await t.fetch(`/join/${token}?code=HTML12`, {
      method: "POST",
      headers: { "x-numa-shared-test-source": "human-preview" },
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(body).toContain("Casa Mar");
    expect(body).toContain("This link needs the household owner’s approval");
    expect(body).toContain("Enter <strong>HTML12</strong> in Join after installing");
    expect(body).not.toContain("claimTicket");
    expect(body).not.toMatch(/[a-f0-9]{64}/);
  });

  test("serves configured privacy and support pages and fails closed without config", async () => {
    const t = convexTest(schema, modules);
    const privacy = await t.fetch("/privacy");
    const privacyBody = await privacy.text();
    expect(privacy.status).toBe(200);
    expect(privacyBody).toContain("Arseny &amp; Co");
    expect(privacyBody).toContain("Madrid, Spain");
    expect(privacyBody).toContain("privacy@example.com");
    expect(privacyBody).toContain("controller-approved Convex DPA transfer safeguard");
    expect(privacyBody).not.toContain("transfer safeguard..");
    expect(privacyBody).toContain("does not move money");
    expect(privacyBody).toContain("No advertising or cross-app tracking");

    const support = await t.fetch("/support");
    const supportBody = await support.text();
    expect(support.status).toBe(200);
    expect(supportBody).toContain("mailto:support@example.com");
    expect(supportBody).toContain("Numa Shared never moves money");
    expect(supportBody).toContain("Ask the household owner for a new invite");
    expect(supportBody).toContain("Editing corrects a record");
    expect(supportBody).toContain("Balances show who owes whom");
    expect(supportBody).toContain("transfer ownership before leaving");
    expect(supportBody).toContain("frozen, read-only local snapshot");
    expect(supportBody).toContain('href="/terms"');
    expect(privacyBody).toContain("United States (US East, Virginia)");
    expect(privacyBody).toContain('href="/terms"');

    const terms = await t.fetch("/terms");
    const termsBody = await terms.text();
    expect(terms.status).toBe(200);
    expect(termsBody).toContain("Terms of service");
    expect(termsBody).toContain("Arseny &amp; Co");
    expect(termsBody).toContain("never moves money");
    expect(termsBody).toContain("fifty euros (€50)");
    expect(termsBody).toContain("statutory rights as a consumer");
    expect(termsBody).toContain("law of Spain");
    expect(termsBody).toContain("mailto:support@example.com");

    vi.stubEnv("NUMA_SHARED_CONTROLLER_NAME", "");
    const unavailable = await t.fetch("/privacy");
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).toBe("Numa Shared web configuration unavailable.");
  });

  test("serves the deployment build floor from the configuration document", async () => {
    const t = convexTest(schema, modules);
    const initial = await t.fetch("/app-config");
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toEqual({ minimumSupportedBuild: null });

    await t.mutation(setMinimumSupportedBuild, {
      minimumSupportedBuild: 42,
      now: nowMillis,
    });
    const configured = await t.fetch("/app-config");
    expect(configured.status).toBe(200);
    expect(configured.headers.get("cache-control")).toBe("no-store");
    await expect(configured.json()).resolves.toEqual({ minimumSupportedBuild: 42 });
  });
});

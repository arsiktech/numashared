// Sign in with Google: the exchange endpoint accepts only Google-signed ID tokens for our own
// OAuth client IDs, and a Google account is separate from any Apple account.
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { encodeBase64Url } from "./lib/identity";
import schema from "./schema";
import { modules } from "./test.setup";

const iosClient = "123456789012-iosclientabc.apps.googleusercontent.com";
const webClient = "123456789012-webclientxyz.apps.googleusercontent.com";
const tokenHashSecret = "google-test-hmac-secret-with-at-least-thirty-two-bytes";

let googlePrivateKey: CryptoKey;
let googlePublicJwk: JsonWebKey & { kid: string };
let signingPrivatePem: string;

const segment = (value: Record<string, unknown>) => encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));

async function googleToken(overrides: Record<string, unknown> = {}, key = googlePrivateKey): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const header = segment({ alg: "RS256", kid: "google-test", typ: "JWT" });
  const payload = segment({
    iss: "https://accounts.google.com", aud: iosClient, sub: "109876543210987654321",
    email: "someone@example.com", email_verified: true, iat: now - 10, exp: now + 3_000, ...overrides,
  });
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function pem(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `-----BEGIN PRIVATE KEY-----\n${(btoa(binary).match(/.{1,64}/gu) ?? []).join("\n")}\n-----END PRIVATE KEY-----`;
}

beforeAll(async () => {
  const google = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  ) as CryptoKeyPair;
  googlePrivateKey = google.privateKey;
  googlePublicJwk = { ...await crypto.subtle.exportKey("jwk", google.publicKey), kid: "google-test", alg: "RS256", use: "sig" };
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  signingPrivatePem = pem(new Uint8Array(await crypto.subtle.exportKey("pkcs8", signing.privateKey)));
});

beforeEach(() => {
  vi.stubEnv("NUMA_SHARED_PRODUCT", "numa-shared");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_CLASS", "anonymous-local");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_NAME", "anonymous-agent");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
  vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
  vi.stubEnv("NUMA_SHARED_SESSION_ISSUER", "https://auth.numa.shared");
  vi.stubEnv("NUMA_SHARED_SESSION_AUDIENCE", "tech.arsik.numashared");
  vi.stubEnv("NUMA_SHARED_AUTH_KEY_ID", "numa-test");
  vi.stubEnv("NUMA_SHARED_AUTH_PRIVATE_KEY_PKCS8_PEM", signingPrivatePem);
  vi.stubEnv("NUMA_SHARED_TOKEN_HASH_SECRET", tokenHashSecret);
  vi.stubEnv("NUMA_SHARED_GOOGLE_CLIENT_IDS", `${iosClient},${webClient}`);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
    if (String(input) === "https://www.googleapis.com/oauth2/v3/certs") {
      return new Response(JSON.stringify({ keys: [googlePublicJwk] }), { status: 200 });
    }
    throw new Error(`unexpected URL ${String(input)}`);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const exchange = (t: ReturnType<typeof convexTest>, idToken: string) => t.fetch("/auth/google/exchange", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }),
});

describe("Sign in with Google", () => {
  test("a Google ID token for our client starts a session that works with Convex", async () => {
    const t = convexTest(schema, modules);
    const first = await exchange(t, await googleToken());
    expect(first.status).toBe(200);
    const body = await first.json() as Record<string, unknown>;
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
    expect(body.accessTokenExpiresInSeconds).toBe(300);

    // The same Google person signing in again (here from Android, web client audience) is the same account.
    const again = await exchange(t, await googleToken({ aud: webClient, iat: Math.floor(Date.now() / 1_000) - 5 }));
    expect(again.status).toBe(200);
    expect((await again.json() as Record<string, unknown>).accountId).toBe(body.accountId);

    // Sessions rotate like Apple ones.
    const refreshed = await t.fetch("/auth/refresh", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: body.refreshToken }),
    });
    expect(refreshed.status).toBe(200);

    const rows = await t.run(async (ctx) => ({
      accounts: (await ctx.db.query("accounts").collect()).length,
      apple: (await ctx.db.query("appleAuthorizations").collect()).length,
    }));
    expect(rows).toEqual({ accounts: 1, apple: 0 });

    const signedIn = t.withIdentity({
      issuer: "https://auth.numa.shared",
      subject: body.accountId as string,
      sid: (await t.run(async (ctx) => (await ctx.db.query("sessions").first())!.sessionId)),
      numa_session_audience: "tech.arsik.numashared",
      token_use: "access",
    });
    await expect(signedIn.query(makeFunctionReference<"query">("pots:listMyPots"), {})).resolves.toEqual([]);
  });

  test("refuses other audiences, other issuers, expired tokens and forged signatures", async () => {
    const t = convexTest(schema, modules);
    const cases: [string, Promise<string>, number, string][] = [
      ["other app", googleToken({ aud: "999999999999-someoneelse.apps.googleusercontent.com" }), 401, "GOOGLE_AUDIENCE_REJECTED"],
      ["other issuer", googleToken({ iss: "https://evil.example" }), 401, "GOOGLE_AUDIENCE_REJECTED"],
      ["expired", googleToken({ exp: Math.floor(Date.now() / 1_000) - 1 }), 401, "TOKEN_EXPIRED"],
    ];
    for (const [name, token, status, code] of cases) {
      const response = await exchange(t, await token);
      expect(response.status, name).toBe(status);
      expect(await response.json(), name).toEqual({ error: { code, retryable: false } });
    }
    const forger = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"],
    ) as CryptoKeyPair;
    const forged = await exchange(t, await googleToken({}, forger.privateKey));
    expect(forged.status).toBe(401);
    await expect(t.run(async (ctx) => (await ctx.db.query("accounts").collect()).length)).resolves.toBe(0);
  });

  test("is unavailable until the deployment lists its Google client IDs", async () => {
    vi.stubEnv("NUMA_SHARED_GOOGLE_CLIENT_IDS", "");
    const t = convexTest(schema, modules);
    const response = await exchange(t, await googleToken());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "GOOGLE_SIGN_IN_UNAVAILABLE", retryable: true } });
  });
});

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { authConfigFromEnvironment } from "./lib/authConfig";
import {
  createAppleClientSecret,
  decodeBase64Url,
  decryptAppleRefreshToken,
  encodeBase64Url,
  encryptAppleRefreshToken,
  exchangeAppleAuthorizationCode,
  fetchAppleJwks,
  generateOpaqueRefreshToken,
  hashAppleSubject,
  hashIdentityRateKey,
  hashRefreshToken,
  IdentityError,
  identityErrorResponse,
  issueNumaAccessToken,
  readIdentityEnvironment,
  revokeAppleRefreshToken,
  validateIdentitySigningKeys,
  verifyAppleIdentityToken,
  verifyAppleServerNotification,
  verifyNumaAccessTokenForTest,
} from "./lib/identity";
import schema from "./schema";
import { modules } from "./test.setup";

const establishSession = makeFunctionReference<"mutation">(
  "authSessions:establishSession",
);
const rotateSession = makeFunctionReference<"mutation">("authSessions:rotateSession");
const revokeSessionByRefresh = makeFunctionReference<"mutation">(
  "authSessions:revokeSessionByRefresh",
);
const revokeAccountSessions = makeFunctionReference<"mutation">(
  "authSessions:revokeAccountSessions",
);
const deleteExpiredRefreshHistory = makeFunctionReference<"mutation">(
  "authSessions:deleteExpiredRefreshHistory",
);
const consumeIdentityRateLimits = makeFunctionReference<"mutation">(
  "authSessions:consumeIdentityRateLimits",
);
const processAppleIdentityNotification = makeFunctionReference<"mutation">(
  "authSessions:processAppleIdentityNotification",
);
const listMyPots = makeFunctionReference<"query">("pots:listMyPots");

const nowSeconds = 1_900_000_000;
const nowMillis = nowSeconds * 1_000;
const rawNonce = "test-raw-nonce-with-enough-entropy";
const tokenHashSecret = "test-only-hmac-secret-with-at-least-thirty-two-bytes";

let applePrivateKey: CryptoKey;
let applePrivatePem: string;
let applePublicJwk: JsonWebKey & { kid: string };
let signingPrivatePem: string;
let signingPublicJwk: JsonWebKey & { kid: string };
let environment: ReturnType<typeof readIdentityEnvironment>;

function bytesToPem(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/gu) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

function jsonSegment(value: Record<string, unknown>): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  ));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function appleToken(
  overrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
): Promise<string> {
  const header = jsonSegment({ alg: "RS256", kid: "apple-test", ...headerOverrides });
  const payload = jsonSegment({
    iss: "https://appleid.apple.com",
    aud: "tech.arsik.numashared",
    sub: "apple-user-stable-subject",
    nonce: await sha256Hex(rawNonce),
    iat: nowSeconds - 10,
    exp: nowSeconds + 300,
    email: "relay@privaterelay.appleid.com",
    email_verified: "true",
    ...overrides,
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    applePrivateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function appleServerNotificationToken(
  overrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
): Promise<string> {
  const header = jsonSegment({
    alg: "RS256",
    kid: "apple-test",
    typ: "JWT",
    ...headerOverrides,
  });
  const payload = jsonSegment({
    iss: "https://appleid.apple.com",
    aud: "tech.arsik.numashared",
    iat: nowSeconds - 10,
    jti: "apple-notification-jti-0001",
    events: JSON.stringify({
      type: "consent-revoked",
      sub: "apple-user-stable-subject",
      event_time: nowSeconds - 5,
    }),
    ...overrides,
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    applePrivateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function parseJwt(token: string): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
} {
  const [header, claims] = token.split(".");
  return {
    header: JSON.parse(new TextDecoder().decode(decodeBase64Url(header))),
    claims: JSON.parse(new TextDecoder().decode(decodeBase64Url(claims))),
  };
}

function stubAppleExchangeFetch(
  exchangedIdentityToken: string,
  refreshToken: string | undefined,
  tokenStatus = 200,
): ReturnType<typeof vi.fn<typeof fetch>> {
  const fetchProvider = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === "https://appleid.apple.com/auth/keys") {
      return new Response(JSON.stringify({ keys: [applePublicJwk] }), { status: 200 });
    }
    if (url === "https://appleid.apple.com/auth/token") {
      if (tokenStatus !== 200) {
        return new Response(JSON.stringify({ error: "upstream" }), {
          status: tokenStatus,
        });
      }
      return new Response(JSON.stringify({
        id_token: exchangedIdentityToken,
        ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
      }), { status: 200 });
    }
    throw new Error(`unexpected Apple URL: ${url}`);
  });
  vi.stubGlobal("fetch", fetchProvider);
  return fetchProvider;
}

beforeAll(async () => {
  const appleKeys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  applePrivateKey = appleKeys.privateKey;
  applePublicJwk = {
    ...await crypto.subtle.exportKey("jwk", appleKeys.publicKey),
    kid: "apple-test",
    alg: "RS256",
    use: "sig",
  };

  const signingKeys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  signingPrivatePem = bytesToPem(new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", signingKeys.privateKey),
  ));
  signingPublicJwk = {
    ...await crypto.subtle.exportKey("jwk", signingKeys.publicKey),
    kid: "numa-test",
    alg: "ES256",
    use: "sig",
  };
  const appleClientKeys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  applePrivatePem = bytesToPem(new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", appleClientKeys.privateKey),
  ));
  const encryptionKey = new Uint8Array(32);
  encryptionKey.fill(17);
  environment = readIdentityEnvironment({
    SIWA_CLIENT_ID: "tech.arsik.numashared",
    APPLE_TEAM_ID: "TESTTEAM01",
    SIWA_KEY_ID: "SIWATEST01",
    SIWA_PRIVATE_KEY_PKCS8_PEM: applePrivatePem,
    NUMA_SHARED_SESSION_ISSUER: "https://auth.numa.shared",
    NUMA_SHARED_SESSION_AUDIENCE: "tech.arsik.numashared",
    NUMA_SHARED_AUTH_KEY_ID: "numa-test",
    NUMA_SHARED_AUTH_PRIVATE_KEY_PKCS8_PEM: signingPrivatePem,
    NUMA_SHARED_TOKEN_HASH_SECRET: tokenHashSecret,
    NUMA_SHARED_APPLE_REFRESH_ENCRYPTION_KEY: encodeBase64Url(encryptionKey),
    NUMA_SHARED_APPLE_REFRESH_ENCRYPTION_KEY_VERSION: "test-v1",
  });
});

beforeEach(() => {
  vi.stubEnv("NUMA_SHARED_PRODUCT", "numa-shared");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_CLASS", "anonymous-local");
  vi.stubEnv("NUMA_SHARED_DEPLOYMENT_NAME", "anonymous-agent");
  vi.stubEnv("NUMA_SHARED_SESSION_ISSUER", "https://auth.numa.shared");
  vi.stubEnv("NUMA_SHARED_SESSION_AUDIENCE", "tech.arsik.numashared");
  vi.stubEnv("NUMA_SHARED_AUTH_KEY_ID", "numa-test");
  vi.stubEnv("NUMA_SHARED_AUTH_PRIVATE_KEY_PKCS8_PEM", signingPrivatePem);
  vi.stubEnv("NUMA_SHARED_TOKEN_HASH_SECRET", tokenHashSecret);
  vi.stubEnv("SIWA_CLIENT_ID", environment.appleClientId);
  vi.stubEnv("APPLE_TEAM_ID", environment.appleTeamId);
  vi.stubEnv("SIWA_KEY_ID", environment.appleKeyId);
  vi.stubEnv("SIWA_PRIVATE_KEY_PKCS8_PEM", environment.applePrivateKeyPkcs8Pem);
  vi.stubEnv(
    "NUMA_SHARED_APPLE_REFRESH_ENCRYPTION_KEY",
    environment.appleRefreshEncryptionKey,
  );
  vi.stubEnv(
    "NUMA_SHARED_APPLE_REFRESH_ENCRYPTION_KEY_VERSION",
    environment.appleRefreshEncryptionKeyVersion,
  );
  vi.stubEnv("NUMA_SHARED_E2E_AUTH_ENABLED", "1");
  vi.stubEnv("NUMA_SHARED_E2E_BOOTSTRAP_SECRET", "local-bootstrap-secret-with-thirty-two-bytes");
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
  vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Sign in with Apple verification and token boundaries", () => {
  test("rejects reuse of Apple credentials for Numa session signing", () => {
    expect(() => readIdentityEnvironment({
      SIWA_CLIENT_ID: "tech.arsik.numashared",
      APPLE_TEAM_ID: "TESTTEAM01",
      SIWA_KEY_ID: "shared-key",
      SIWA_PRIVATE_KEY_PKCS8_PEM: applePrivatePem.replaceAll("\n", "\r\n"),
      NUMA_SHARED_SESSION_ISSUER: "https://auth.numa.shared",
      NUMA_SHARED_SESSION_AUDIENCE: "tech.arsik.numashared",
      NUMA_SHARED_AUTH_KEY_ID: "different-label-same-key",
      NUMA_SHARED_AUTH_PRIVATE_KEY_PKCS8_PEM: applePrivatePem,
      NUMA_SHARED_TOKEN_HASH_SECRET: tokenHashSecret,
      NUMA_SHARED_APPLE_REFRESH_ENCRYPTION_KEY:
        environment.appleRefreshEncryptionKey,
      NUMA_SHARED_APPLE_REFRESH_ENCRYPTION_KEY_VERSION: "test-v1",
    })).toThrowError(expect.objectContaining({ code: "IDENTITY_CONFIGURATION_INVALID" }));
  });
  test("rejects equal Apple and session public-key fingerprints", async () => {
    await expect(validateIdentitySigningKeys({
      ...environment,
      appleKeyId: "different-label-same-public-key",
      applePrivateKeyPkcs8Pem: signingPrivatePem,
    })).rejects.toMatchObject({ code: "IDENTITY_CONFIGURATION_INVALID" });
  });
  test("accepts Apple's RS256 token only with exact issuer, audience, nonce, and time", async () => {
    const verified = await verifyAppleIdentityToken(
      await appleToken(),
      rawNonce,
      "tech.arsik.numashared",
      [applePublicJwk],
      nowSeconds,
    );
    expect(verified).toEqual({
      subject: "apple-user-stable-subject",
      relayEmail: "relay@privaterelay.appleid.com",
    });

    for (const token of [
      await appleToken({ aud: "other.bundle" }),
      await appleToken({ iss: "https://attacker.example" }),
      await appleToken({ exp: nowSeconds }),
      await appleToken({ iat: nowSeconds + 61 }),
    ]) {
      await expect(verifyAppleIdentityToken(
        token,
        rawNonce,
        "tech.arsik.numashared",
        [applePublicJwk],
        nowSeconds,
      )).rejects.toBeInstanceOf(IdentityError);
    }
    await expect(verifyAppleIdentityToken(
      await appleToken(),
      "wrong-raw-nonce-with-enough-entropy",
      "tech.arsik.numashared",
      [applePublicJwk],
      nowSeconds,
    )).rejects.toMatchObject({ code: "APPLE_NONCE_REJECTED" });
  });

  test("verifies and classifies signed Apple server-to-server events", async () => {
    await expect(verifyAppleServerNotification(
      await appleServerNotificationToken(),
      "tech.arsik.numashared",
      [applePublicJwk],
      nowSeconds,
    )).resolves.toEqual({
      jwtId: "apple-notification-jti-0001",
      events: [{
        eventId: "apple-notification-jti-0001:0",
        eventType: "consent-revoked",
        subject: "apple-user-stable-subject",
        eventTime: nowSeconds - 5,
        supported: true,
        revokesAuthorization: true,
      }],
    });

    const unknown = await verifyAppleServerNotification(
      await appleServerNotificationToken({
        events: [{
          type: "new-apple-event",
          sub: "apple-user-stable-subject",
          event_time: nowSeconds,
        }],
      }),
      "tech.arsik.numashared",
      [applePublicJwk],
      nowSeconds,
    );
    expect(unknown.events[0]).toMatchObject({
      eventType: "new-apple-event",
      supported: false,
      revokesAuthorization: false,
    });
    for (const [eventType, revokesAuthorization] of [
      ["email-enabled", false],
      ["email-disabled", false],
      ["account-delete", true],
    ] as const) {
      const classified = await verifyAppleServerNotification(
        await appleServerNotificationToken({
          events: {
            type: eventType,
            sub: "apple-user-stable-subject",
            event_time: nowSeconds,
          },
        }),
        "tech.arsik.numashared",
        [applePublicJwk],
        nowSeconds,
      );
      expect(classified.events[0]).toMatchObject({
        eventType,
        supported: true,
        revokesAuthorization,
      });
    }

    await expect(verifyAppleServerNotification(
      await appleServerNotificationToken({ aud: "wrong.bundle" }),
      "tech.arsik.numashared",
      [applePublicJwk],
      nowSeconds,
    )).rejects.toMatchObject({ code: "APPLE_AUDIENCE_REJECTED" });
    await expect(verifyAppleServerNotification(
      await appleServerNotificationToken({ iat: nowSeconds + 61 }),
      "tech.arsik.numashared",
      [applePublicJwk],
      nowSeconds,
    )).rejects.toMatchObject({ code: "TOKEN_CLAIMS_REJECTED" });
    await expect(verifyAppleServerNotification(
      await appleServerNotificationToken({
        iat: nowSeconds - 7 * 24 * 60 * 60 - 1,
      }),
      "tech.arsik.numashared",
      [applePublicJwk],
      nowSeconds,
    )).rejects.toMatchObject({ code: "TOKEN_CLAIMS_REJECTED" });
    await expect(verifyAppleServerNotification(
      await appleServerNotificationToken({ exp: nowSeconds }),
      "tech.arsik.numashared",
      [applePublicJwk],
      nowSeconds,
    )).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
    await expect(verifyAppleServerNotification(
      await appleServerNotificationToken({
        events: Array.from({ length: 9 }, (_value, index) => ({
          type: "email-disabled",
          sub: `apple-user-${index}`,
          event_time: nowSeconds,
        })),
      }),
      "tech.arsik.numashared",
      [applePublicJwk],
      nowSeconds,
    )).rejects.toMatchObject({ code: "TOKEN_CLAIMS_REJECTED" });
  });

  test("redacts unexpected server errors from identity responses", async () => {
    const response = identityErrorResponse(new Error("secret provider detail"));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toBe(JSON.stringify({
      error: { code: "IDENTITY_REQUEST_FAILED", retryable: true },
    }));
    expect(text).not.toContain("secret provider detail");
  });

  test("rejects ES256/malformed Apple headers and non-RSA verification keys", async () => {
    await expect(verifyAppleIdentityToken(
      await appleToken({}, { alg: "ES256" }),
      rawNonce,
      "tech.arsik.numashared",
      [applePublicJwk],
      nowSeconds,
    )).rejects.toMatchObject({ code: "TOKEN_HEADER_REJECTED" });
    await expect(verifyAppleIdentityToken(
      await appleToken(),
      rawNonce,
      "tech.arsik.numashared",
      [{ ...signingPublicJwk, kid: "apple-test" }],
      nowSeconds,
    )).rejects.toMatchObject({ code: "TOKEN_KEY_REJECTED" });
    const valid = await appleToken();
    const malformed = `${valid.slice(0, valid.lastIndexOf(".") + 1)}AA`;
    await expect(verifyAppleIdentityToken(
      malformed,
      rawNonce,
      "tech.arsik.numashared",
      [applePublicJwk],
      nowSeconds,
    )).rejects.toMatchObject({ code: "TOKEN_KEY_REJECTED" });
  });

  test("creates ES256 Apple client secrets and exact Convex custom access tokens", async () => {
    const clientSecret = await createAppleClientSecret(environment, nowSeconds);
    const parsedClientSecret = parseJwt(clientSecret);
    expect(parsedClientSecret.header).toMatchObject({ alg: "ES256", kid: "SIWATEST01" });
    expect(parsedClientSecret.claims).toEqual({
      iss: "TESTTEAM01",
      iat: nowSeconds,
      exp: nowSeconds + 300,
      aud: "https://appleid.apple.com",
      sub: "tech.arsik.numashared",
    });

    const access = await issueNumaAccessToken(
      {
        publicAccountId: "account-public-00000001",
        sessionId: "session-public-00000001",
      },
      environment,
      nowSeconds,
      "token-identifier-0000001",
      nowMillis + 86_400_000,
    );
    const claims = await verifyNumaAccessTokenForTest(
      access.token,
      signingPublicJwk,
      environment,
      nowSeconds,
    );
    expect(claims).toMatchObject({
      iss: "https://auth.numa.shared",
      aud: "tech.arsik.numashared",
      numa_session_audience: "tech.arsik.numashared",
      sub: "account-public-00000001",
      sid: "session-public-00000001",
      token_use: "access",
    });
    expect(access.expiresInSeconds).toBe(300);

    const nearExpiryAccess = await issueNumaAccessToken(
      {
        publicAccountId: "account-public-00000001",
        sessionId: "session-public-00000001",
      },
      environment,
      nowSeconds,
      "token-identifier-0000002",
      nowMillis + 45_000,
    );
    expect(parseJwt(nearExpiryAccess.token).claims.exp).toBe(nowSeconds + 45);
    expect(nearExpiryAccess.expiresInSeconds).toBe(45);
    await expect(issueNumaAccessToken(
      {
        publicAccountId: "account-public-00000001",
        sessionId: "session-public-00000001",
      },
      environment,
      nowSeconds,
      "token-identifier-0000003",
      nowMillis,
    )).rejects.toMatchObject({ code: "REFRESH_TOKEN_EXPIRED" });
  });

  test("posts code exchange and revocation only to Apple's exact endpoints", async () => {
    const exchangedToken = await appleToken();
    const fetchProvider = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://appleid.apple.com/auth/token");
      expect(init?.method).toBe("POST");
      const form = init?.body as URLSearchParams;
      expect(form.get("client_id")).toBe("tech.arsik.numashared");
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code")).toBe("one-time-code");
      return new Response(JSON.stringify({
        id_token: exchangedToken,
        refresh_token: "apple-refresh-secret",
      }), { status: 200 });
    });
    await expect(exchangeAppleAuthorizationCode(
      "one-time-code",
      "signed-client-secret",
      "tech.arsik.numashared",
      fetchProvider,
    )).resolves.toEqual({
      idToken: exchangedToken,
      refreshToken: "apple-refresh-secret",
    });

    const revokeFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://appleid.apple.com/auth/revoke");
      const form = init?.body as URLSearchParams;
      expect(form.get("token")).toBe("apple-refresh-secret");
      expect(form.get("token_type_hint")).toBe("refresh_token");
      return new Response(null, { status: 200 });
    });
    await expect(revokeAppleRefreshToken(
      "apple-refresh-secret",
      "signed-client-secret",
      "tech.arsik.numashared",
      revokeFetch,
    )).resolves.toBeUndefined();
  });

  test("bounds every Apple HTTP request with an abort timeout", async () => {
    const neverResponds = vi.fn<typeof fetch>(async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })
    );

    await expect(fetchAppleJwks(neverResponds, 5)).rejects.toMatchObject({
      code: "APPLE_KEYS_UNAVAILABLE",
    });
    await expect(exchangeAppleAuthorizationCode(
      "one-time-code",
      "signed-client-secret",
      "tech.arsik.numashared",
      neverResponds,
      5,
    )).rejects.toMatchObject({ code: "APPLE_CODE_EXCHANGE_UNAVAILABLE" });
    await expect(revokeAppleRefreshToken(
      "apple-refresh-secret",
      "signed-client-secret",
      "tech.arsik.numashared",
      neverResponds,
      5,
    )).rejects.toMatchObject({ code: "APPLE_REVOCATION_UNAVAILABLE" });

    const bodyNeverFinishes = vi.fn<typeof fetch>(async (_input, init) =>
      new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () =>
            controller.error(new Error("aborted"))
          );
        },
      }))
    );
    await expect(fetchAppleJwks(bodyNeverFinishes, 5)).rejects.toMatchObject({
      code: "APPLE_KEYS_UNAVAILABLE",
    });
  });

  test("hashes opaque refresh tokens and encrypts reversible Apple authorization only", async () => {
    const refreshToken = generateOpaqueRefreshToken();
    expect(refreshToken).toHaveLength(43);
    const refreshHash = await hashRefreshToken(refreshToken, tokenHashSecret);
    const subjectHash = await hashAppleSubject(refreshToken, tokenHashSecret);
    expect(refreshHash).not.toBe(refreshToken);
    expect(subjectHash).not.toBe(refreshHash);

    const encrypted = await encryptAppleRefreshToken(
      "apple-refresh-secret",
      subjectHash,
      environment,
    );
    expect(JSON.stringify(encrypted)).not.toContain("apple-refresh-secret");
    await expect(decryptAppleRefreshToken(
      encrypted,
      subjectHash,
      environment,
    )).resolves.toBe("apple-refresh-secret");
    await expect(decryptAppleRefreshToken(
      encrypted,
      `${subjectHash}-wrong`,
      environment,
    )).rejects.toMatchObject({ code: "APPLE_AUTHORIZATION_UNREADABLE" });
  });

  test("auth config fails closed and pins exact issuer, audience, JWKS, and ES256", () => {
    const jwks = `data:application/json,${encodeURIComponent(JSON.stringify({
      keys: [{
        kty: "EC",
        crv: "P-256",
        x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        kid: "numa-test",
        alg: "ES256",
        use: "sig",
      }],
    }))}`;
    expect(authConfigFromEnvironment({
      NUMA_SHARED_SESSION_ISSUER: "https://auth.numa.shared",
      NUMA_SHARED_SESSION_AUDIENCE: "tech.arsik.numashared",
      NUMA_SHARED_AUTH_JWKS_URI: jwks,
    })).toEqual({
      providers: [{
        type: "customJwt",
        issuer: "https://auth.numa.shared",
        applicationID: "tech.arsik.numashared",
        jwks,
        algorithm: "ES256",
      }],
    });
    expect(() => authConfigFromEnvironment({})).toThrow(/Missing required/u);
    expect(() => authConfigFromEnvironment({
      NUMA_SHARED_SESSION_ISSUER: "https://auth.numa.shared",
      NUMA_SHARED_SESSION_AUDIENCE: "wrong.bundle",
      NUMA_SHARED_AUTH_JWKS_URI: "https://auth.numa.shared/jwks.json",
    })).toThrow(/bundle identifier/u);
    const privateJwks = `data:application/json,${encodeURIComponent(JSON.stringify({
      keys: [{
        kty: "EC", crv: "P-256", x: "x", y: "y", kid: "leak",
        alg: "ES256", use: "sig", d: "secret",
      }],
    }))}`;
    expect(() => authConfigFromEnvironment({
      NUMA_SHARED_SESSION_ISSUER: "https://auth.numa.shared",
      NUMA_SHARED_SESSION_AUDIENCE: "tech.arsik.numashared",
      NUMA_SHARED_AUTH_JWKS_URI: privateJwks,
    })).toThrow(/public ES256/u);
  });
});

describe("rotating server sessions", () => {
  test("rejects ordinary identity mutations on a cloud URL despite local markers", async () => {
    const t = convexTest(schema, modules);
    vi.stubEnv("CONVEX_CLOUD_URL", "https://example.convex.cloud");
    await expect(t.mutation(establishSession, {
      appleSubjectHash: await hashAppleSubject("cloud-rejected-user", tokenHashSecret),
      encryptedAppleRefresh: {
        encryptedRefreshToken: "encrypted-refresh-value",
        encryptionNonce: "encrypted-nonce-value",
        encryptionKeyVersion: "test-v1",
      },
      sessionId: "cloud-rejected-session-001",
      publicAccountIdCandidate: "cloud-rejected-account-001",
      refreshTokenHash: await hashRefreshToken(
        generateOpaqueRefreshToken(),
        tokenHashSecret,
      ),
      now: nowMillis,
      expiresAt: nowMillis + 86_400_000,
    })).rejects.toThrow();
    await expect(t.run(async (ctx) => ({
      accounts: await ctx.db.query("accounts").collect(),
      sessions: await ctx.db.query("sessions").collect(),
      authorizations: await ctx.db.query("appleAuthorizations").collect(),
    }))).resolves.toEqual({ accounts: [], sessions: [], authorizations: [] });
  });

  test("bootstraps deterministic local E2E accounts only on a proven loopback target", async () => {
    const t = convexTest(schema, modules);
    const request = () => t.fetch("/auth/e2e/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bootstrapSecret: "local-bootstrap-secret-with-thirty-two-bytes",
        accountKey: "household-owner",
      }),
    });
    const firstResponse = await request();
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as Record<string, unknown>;
    expect(first.e2e).toBe(true);
    expect(typeof first.refreshToken).toBe("string");
    await expect(verifyNumaAccessTokenForTest(
      first.accessToken as string,
      signingPublicJwk,
      environment,
      Math.floor(Date.now() / 1_000),
    )).resolves.toMatchObject({ sub: first.accountId, token_use: "access" });
    const refreshResponse = await t.fetch("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: first.refreshToken }),
    });
    expect(refreshResponse.status).toBe(200);
    const refreshed = await refreshResponse.json() as Record<string, unknown>;
    expect(refreshed.refreshToken).not.toBe(first.refreshToken);
    expect(refreshed.accountId).toBe(first.accountId);
    const logoutResponse = await t.fetch("/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: refreshed.refreshToken }),
    });
    expect(logoutResponse.status).toBe(200);

    const secondResponse = await request();
    const second = await secondResponse.json() as Record<string, unknown>;
    expect(second.accountId).toBe(first.accountId);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expect(t.run(async (ctx) => ({
      accounts: (await ctx.db.query("accounts").collect()).length,
      sessions: (await ctx.db.query("sessions").collect()).length,
      appleAuthorizations: (await ctx.db.query("appleAuthorizations").collect()).length,
    }))).resolves.toEqual({ accounts: 1, sessions: 2, appleAuthorizations: 0 });

    vi.stubEnv("CONVEX_CLOUD_URL", "https://example.convex.cloud");
    const cloudResponse = await request();
    expect(cloudResponse.status).toBe(500);
    await expect(cloudResponse.json()).resolves.toEqual({
      error: { code: "IDENTITY_REQUEST_FAILED", retryable: true },
    });
    await expect(t.run(async (ctx) =>
      (await ctx.db.query("sessions").collect()).length
    )).resolves.toBe(2);
  });

  test("rejects a wrong local E2E bootstrap secret without creating identity rows", async () => {
    const t = convexTest(schema, modules);
    const response = await t.fetch("/auth/e2e/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bootstrapSecret: "wrong", accountKey: "owner" }),
    });
    expect(response.status).toBe(401);
    await expect(t.run(async (ctx) => ({
      accounts: await ctx.db.query("accounts").collect(),
      sessions: await ctx.db.query("sessions").collect(),
    }))).resolves.toEqual({ accounts: [], sessions: [] });
  });

  test("requires the exact Numa access-token audience and token use", async () => {
    const t = convexTest(schema, modules);
    const refreshTokenHash = await hashRefreshToken(
      generateOpaqueRefreshToken(),
      tokenHashSecret,
    );
    await t.mutation(establishSession, {
      appleSubjectHash: await hashAppleSubject("claims-user", tokenHashSecret),
      encryptedAppleRefresh: {
        encryptedRefreshToken: "encrypted-refresh-value",
        encryptionNonce: "encrypted-nonce-value",
        encryptionKeyVersion: "test-v1",
      },
      sessionId: "session-claims-0000001",
      publicAccountIdCandidate: "account-claims-000001",
      refreshTokenHash,
      now: nowMillis,
      expiresAt: nowMillis + 86_400_000,
    });
    const claims = {
      issuer: "https://auth.numa.shared",
      subject: "account-claims-000001",
      sid: "session-claims-0000001",
    };
    await expect(t.withIdentity({
      ...claims,
      numa_session_audience: "wrong.bundle",
      token_use: "access",
    }).query(listMyPots, {})).rejects.toMatchObject({
      data: { code: "AUTH_AUDIENCE_REJECTED", retryable: false },
    });
    await expect(t.withIdentity({
      ...claims,
      numa_session_audience: "tech.arsik.numashared",
      token_use: "refresh",
    }).query(listMyPots, {})).rejects.toMatchObject({
      data: { code: "AUTH_TOKEN_USE_REJECTED", retryable: false },
    });
    await expect(t.withIdentity({
      ...claims,
      numa_session_audience: "tech.arsik.numashared",
      token_use: "access",
    }).query(listMyPots, {})).resolves.toEqual([]);
  });

  test("stores only refresh hashes, rotates once, and revokes the family on replay", async () => {
    const t = convexTest(schema, modules);
    const firstToken = generateOpaqueRefreshToken();
    const secondToken = generateOpaqueRefreshToken();
    const firstHash = await hashRefreshToken(firstToken, tokenHashSecret);
    const secondHash = await hashRefreshToken(secondToken, tokenHashSecret);
    const established = await t.mutation(establishSession, {
      appleSubjectHash: await hashAppleSubject("apple-user", tokenHashSecret),
      relayEmail: "relay@privaterelay.appleid.com",
      encryptedAppleRefresh: {
        encryptedRefreshToken: "encrypted-refresh-value",
        encryptionNonce: "encrypted-nonce-value",
        encryptionKeyVersion: "test-v1",
      },
      sessionId: "session-owner-00000001",
      publicAccountIdCandidate: "account-owner-000001",
      refreshTokenHash: firstHash,
      now: nowMillis,
      expiresAt: nowMillis + 86_400_000,
    });
    expect(established).toMatchObject({
      publicAccountId: "account-owner-000001",
      sessionId: "session-owner-00000001",
    });

    await expect(t.mutation(rotateSession, {
      refreshTokenHash: firstHash,
      replacementRefreshTokenHash: secondHash,
      now: nowMillis + 1,
    })).resolves.toMatchObject({ status: "rotated" });
    await expect(t.mutation(rotateSession, {
      refreshTokenHash: firstHash,
      replacementRefreshTokenHash: await hashRefreshToken(
        generateOpaqueRefreshToken(),
        tokenHashSecret,
      ),
      now: nowMillis + 2,
    })).resolves.toEqual({ status: "reused" });

    const stored = await t.run(async (ctx) => ({
      sessions: await ctx.db.query("sessions").collect(),
      history: await ctx.db.query("refreshTokenHistory").collect(),
    }));
    expect(JSON.stringify(stored)).not.toContain(firstToken);
    expect(JSON.stringify(stored)).not.toContain(secondToken);
    expect(stored.sessions[0].revokedAt).toBe(nowMillis + 2);
    expect(stored.history[0].tokenHash).toBe(firstHash);

    const identity = t.withIdentity({
      issuer: "https://auth.numa.shared",
      subject: "account-owner-000001",
      sid: "session-owner-00000001",
      numa_session_audience: "tech.arsik.numashared",
      token_use: "access",
    });
    await expect(identity.query(listMyPots, {})).rejects.toMatchObject({
      data: { code: "AUTH_SESSION_REVOKED", retryable: false },
    });
  });

  test("requires an Apple refresh token for a new authorization and rolls back", async () => {
    const t = convexTest(schema, modules);
    const refreshTokenHash = await hashRefreshToken(
      generateOpaqueRefreshToken(),
      tokenHashSecret,
    );
    try {
      await t.mutation(establishSession, {
        appleSubjectHash: await hashAppleSubject("new-user", tokenHashSecret),
        sessionId: "session-new-user-00001",
        publicAccountIdCandidate: "account-new-user-00001",
        refreshTokenHash,
        now: nowMillis,
        expiresAt: nowMillis + 86_400_000,
      });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ConvexError);
      expect((error as ConvexError<{ code: string }>).data.code).toBe(
        "APPLE_REFRESH_TOKEN_REQUIRED",
      );
    }
    await expect(t.run(async (ctx) => ({
      accounts: await ctx.db.query("accounts").collect(),
      sessions: await ctx.db.query("sessions").collect(),
    }))).resolves.toEqual({ accounts: [], sessions: [] });
  });

  test("logout by current or historical refresh token is idempotent", async () => {
    const t = convexTest(schema, modules);
    const raw = generateOpaqueRefreshToken();
    const hash = await hashRefreshToken(raw, tokenHashSecret);
    await t.mutation(establishSession, {
      appleSubjectHash: await hashAppleSubject("logout-user", tokenHashSecret),
      encryptedAppleRefresh: {
        encryptedRefreshToken: "encrypted-refresh-value",
        encryptionNonce: "encrypted-nonce-value",
        encryptionKeyVersion: "test-v1",
      },
      sessionId: "session-logout-0000001",
      publicAccountIdCandidate: "account-logout-000001",
      refreshTokenHash: hash,
      now: nowMillis,
      expiresAt: nowMillis + 86_400_000,
    });
    await expect(t.mutation(revokeSessionByRefresh, {
      refreshTokenHash: hash,
      now: nowMillis + 1,
    })).resolves.toEqual({ revoked: true });
    await expect(t.mutation(revokeSessionByRefresh, {
      refreshTokenHash: hash,
      now: nowMillis + 2,
    })).resolves.toEqual({ revoked: true });
  });

  test("caps a refreshed access token at the absolute session expiry and prunes history", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const t = convexTest(schema, modules);
    const refreshToken = generateOpaqueRefreshToken();
    const refreshTokenHash = await hashRefreshToken(refreshToken, tokenHashSecret);
    const account = await t.mutation(establishSession, {
      appleSubjectHash: await hashAppleSubject("near-expiry-user", tokenHashSecret),
      encryptedAppleRefresh: {
        encryptedRefreshToken: "encrypted-refresh-value",
        encryptionNonce: "encrypted-nonce-value",
        encryptionKeyVersion: "test-v1",
      },
      sessionId: "near-expiry-session-001",
      publicAccountIdCandidate: "near-expiry-account-001",
      refreshTokenHash,
      now: nowMillis,
      expiresAt: nowMillis + 45_000,
    });
    await t.run(async (ctx) => {
      const accountRow = await ctx.db
        .query("accounts")
        .withIndex("by_public_account_id", (index) =>
          index.eq("publicAccountId", account.publicAccountId),
        )
        .unique();
      if (!accountRow) throw new Error("missing account");
      await ctx.db.insert("refreshTokenHistory", {
        tokenHash: "expired-route-history-token-hash-0000001",
        sessionId: "expired-route-history-session-001",
        accountId: accountRow._id,
        rotatedAt: nowMillis - 2,
        expiresAt: nowMillis - 1,
      });
    });

    const response = await t.fetch("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.accessTokenExpiresInSeconds).toBe(45);
    expect(parseJwt(body.accessToken as string).claims.exp).toBe(nowSeconds + 45);
    await expect(t.run(async (ctx) =>
      (await ctx.db.query("refreshTokenHistory").collect())
        .some((row) => row.tokenHash === "expired-route-history-token-hash-0000001")
    )).resolves.toBe(false);
  });

  test("permits immediate cached restore and revokes the family if the old token replays", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const t = convexTest(schema, modules);
    const refreshToken = generateOpaqueRefreshToken();
    await t.mutation(establishSession, {
      appleSubjectHash: await hashAppleSubject("rapid-refresh-user", tokenHashSecret),
      encryptedAppleRefresh: {
        encryptedRefreshToken: "encrypted-refresh-value",
        encryptionNonce: "encrypted-nonce-value",
        encryptionKeyVersion: "test-v1",
      },
      sessionId: "rapid-refresh-session-001",
      publicAccountIdCandidate: "rapid-refresh-account-001",
      refreshTokenHash: await hashRefreshToken(refreshToken, tokenHashSecret),
      now: nowMillis,
      expiresAt: nowMillis + 86_400_000,
    });
    const response = await t.fetch("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    expect(response.status).toBe(200);
    const restored = await response.json() as Record<string, unknown>;
    expect(restored.refreshToken).not.toBe(refreshToken);

    const replay = await t.fetch("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toEqual({
      error: { code: "REFRESH_TOKEN_REUSED", retryable: false },
    });
    await expect(t.run(async (ctx) =>
      (await ctx.db.query("sessions").collect())[0].revokedAt
    )).resolves.toBe(nowMillis);
  });

  test("rate-bounds repeated refresh failures with privacy-safe bucket keys", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const t = convexTest(schema, modules);
    const unknownRefreshToken = generateOpaqueRefreshToken();
    const request = () => t.fetch("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: unknownRefreshToken }),
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await request()).status).toBe(401);
    }
    const limited = await request();
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({
      error: { code: "REFRESH_RATE_LIMITED", retryable: true },
    });
    const stored = await t.run(async (ctx) =>
      await ctx.db.query("identityRateLimits").collect()
    );
    expect(stored).toHaveLength(2);
    expect(JSON.stringify(
      stored,
      (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value,
    )).not.toContain(unknownRefreshToken);
  });

  test("rate-bounds malformed refresh bodies before token hashing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const t = convexTest(schema, modules);
    const request = (source: string) => t.fetch("/auth/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-numa-shared-test-source": source,
      },
      body: "{",
    });
    for (let attempt = 0; attempt < 120; attempt += 1) {
      expect((await request("malformed-refresh-a")).status).toBe(400);
    }
    expect((await request("malformed-refresh-a")).status).toBe(429);
    expect((await request("malformed-refresh-b")).status).toBe(400);
    const stored = await t.run(async (ctx) =>
      await ctx.db.query("identityRateLimits").collect()
    );
    expect(stored).toHaveLength(2);
  });

  test("rate-bounds malformed logout bodies before token hashing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const t = convexTest(schema, modules);
    const request = () => t.fetch("/auth/logout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-numa-shared-test-source": "malformed-logout-a",
      },
      body: "{",
    });
    for (let attempt = 0; attempt < 120; attempt += 1) {
      expect((await request()).status).toBe(400);
    }
    expect((await request()).status).toBe(429);
  });

  test("a retryable 429 preserves the current refresh token for a later restore", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const t = convexTest(schema, modules);
    const refreshToken = generateOpaqueRefreshToken();
    const refreshTokenHash = await hashRefreshToken(refreshToken, tokenHashSecret);
    await t.mutation(establishSession, {
      appleSubjectHash: await hashAppleSubject("rate-preserved-user", tokenHashSecret),
      encryptedAppleRefresh: {
        encryptedRefreshToken: "encrypted-refresh-value",
        encryptionNonce: "encrypted-nonce-value",
        encryptionKeyVersion: "test-v1",
      },
      sessionId: "rate-preserved-session-001",
      publicAccountIdCandidate: "rate-preserved-account-001",
      refreshTokenHash,
      now: nowMillis,
      expiresAt: nowMillis + 86_400_000,
    });
    const [globalRateKey, tokenRateKey] = await Promise.all([
      hashIdentityRateKey("refresh-global", "numa-shared", tokenHashSecret),
      hashIdentityRateKey("refresh-token", refreshToken, tokenHashSecret),
    ]);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await t.mutation(consumeIdentityRateLimits, {
        buckets: [
          { bucketKey: globalRateKey, limit: 600n, windowMillis: 60_000 },
          { bucketKey: tokenRateKey, limit: 10n, windowMillis: 60_000 },
        ],
        now: nowMillis,
      });
    }
    const request = () => t.fetch("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    const limited = await request();
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({
      error: { code: "REFRESH_RATE_LIMITED", retryable: true },
    });
    await expect(t.run(async (ctx) =>
      (await ctx.db.query("sessions").collect())[0].refreshTokenHash
    )).resolves.toBe(refreshTokenHash);

    vi.setSystemTime(nowMillis + 60_001);
    expect((await request()).status).toBe(200);
  });

  test("caps active sessions per account", async () => {
    const t = convexTest(schema, modules);
    const appleSubjectHash = await hashAppleSubject("session-cap-user", tokenHashSecret);
    for (let index = 0; index < 20; index += 1) {
      await t.mutation(establishSession, {
        appleSubjectHash,
        encryptedAppleRefresh: index === 0 ? {
          encryptedRefreshToken: "encrypted-refresh-value",
          encryptionNonce: "encrypted-nonce-value",
          encryptionKeyVersion: "test-v1",
        } : undefined,
        sessionId: `session-cap-${index.toString().padStart(8, "0")}`,
        publicAccountIdCandidate: `account-cap-${index.toString().padStart(8, "0")}`,
        refreshTokenHash: await hashRefreshToken(
          generateOpaqueRefreshToken(),
          tokenHashSecret,
        ),
        now: nowMillis,
        expiresAt: nowMillis + 86_400_000,
      });
    }
    await expect(t.mutation(establishSession, {
      appleSubjectHash,
      sessionId: "session-cap-over-limit",
      publicAccountIdCandidate: "account-cap-over-limit",
      refreshTokenHash: await hashRefreshToken(
        generateOpaqueRefreshToken(),
        tokenHashSecret,
      ),
      now: nowMillis,
      expiresAt: nowMillis + 86_400_000,
    })).rejects.toMatchObject({
      data: { code: "SESSION_LIMIT_REACHED", retryable: false },
    });
    await expect(t.run(async (ctx) =>
      (await ctx.db.query("sessions").collect()).length
    )).resolves.toBe(20);
  });

  test("garbage-collects expired refresh history in bounded batches", async () => {
    const t = convexTest(schema, modules);
    const accountId = await t.run(async (ctx) => await ctx.db.insert("accounts", {
      publicAccountId: "history-account-0001",
      appleSubjectHash: "history-subject-hash-00000000000000000001",
      createdAt: nowMillis,
    }));
    await t.run(async (ctx) => {
      await ctx.db.insert("refreshTokenHistory", {
        tokenHash: "expired-history-token-hash-000000000001",
        sessionId: "expired-history-session-0001",
        accountId,
        rotatedAt: nowMillis - 2,
        expiresAt: nowMillis - 1,
      });
      await ctx.db.insert("refreshTokenHistory", {
        tokenHash: "live-history-token-hash-000000000000001",
        sessionId: "live-history-session-00000001",
        accountId,
        rotatedAt: nowMillis,
        expiresAt: nowMillis + 1,
      });
    });
    await expect(t.mutation(deleteExpiredRefreshHistory, {
      now: nowMillis,
    })).resolves.toEqual({ deletedCount: 1, hasMore: false });
    await expect(t.run(async (ctx) =>
      (await ctx.db.query("refreshTokenHistory").collect()).map((row) => row.tokenHash)
    )).resolves.toEqual(["live-history-token-hash-000000000000001"]);
  });

  test("applies atomic fixed-window identity rate limits", async () => {
    const t = convexTest(schema, modules);
    const args = {
      buckets: [{
        bucketKey: "privacy-safe-rate-key-0000000000000001",
        limit: 2n,
        windowMillis: 60_000,
      }],
      now: nowMillis,
    };
    await expect(t.mutation(consumeIdentityRateLimits, args)).resolves.toEqual({
      allowed: true,
      retryAfterMillis: 0,
    });
    await expect(t.mutation(consumeIdentityRateLimits, args)).resolves.toEqual({
      allowed: true,
      retryAfterMillis: 0,
    });
    await expect(t.mutation(consumeIdentityRateLimits, args)).resolves.toEqual({
      allowed: false,
      retryAfterMillis: 60_000,
    });
  });

  test("keeps identity rate limits isolated between trusted request sources", async () => {
    const t = convexTest(schema, modules);
    const sourceA = {
      buckets: [{
        bucketKey: "source-a-rate-key-000000000000000000001",
        limit: 1n,
        windowMillis: 60_000,
      }],
      now: nowMillis,
    };
    const sourceB = {
      buckets: [{
        bucketKey: "source-b-rate-key-000000000000000000001",
        limit: 1n,
        windowMillis: 60_000,
      }],
      now: nowMillis,
    };
    await expect(t.mutation(consumeIdentityRateLimits, sourceA)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(t.mutation(consumeIdentityRateLimits, sourceA)).resolves.toMatchObject({
      allowed: false,
    });
    await expect(t.mutation(consumeIdentityRateLimits, sourceB)).resolves.toEqual({
      allowed: true,
      retryAfterMillis: 0,
    });
  });

  test("revokes account sessions in finite deletion batches", async () => {
    const t = convexTest(schema, modules);
    const accountId = await t.run(async (ctx) => await ctx.db.insert("accounts", {
      publicAccountId: "account-deletion-0001",
      appleSubjectHash: "account-deletion-subject-hash",
      createdAt: nowMillis,
    }));
    await t.run(async (ctx) => {
      for (let index = 0; index < 101; index += 1) {
        await ctx.db.insert("sessions", {
          sessionId: `deletion-session-${index.toString().padStart(4, "0")}`,
          accountId,
          refreshTokenHash: `deletion-refresh-hash-${index.toString().padStart(4, "0")}`,
          expiresAt: nowMillis + 86_400_000,
          createdAt: nowMillis,
          rotatedAt: nowMillis,
        });
      }
    });
    await expect(t.mutation(revokeAccountSessions, {
      accountId,
      now: nowMillis + 1,
    })).resolves.toEqual({ revokedCount: 100, hasMore: true });
    await expect(t.mutation(revokeAccountSessions, {
      accountId,
      now: nowMillis + 2,
    })).resolves.toEqual({ revokedCount: 1, hasMore: false });
    await expect(t.run(async (ctx) =>
      (await ctx.db.query("sessions").collect())
        .filter((session) => session.revokedAt === undefined).length
    )).resolves.toBe(0);
  });

  test("account deletion revokes Apple, hard-deletes identity, and retries by receipt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const t = convexTest(schema, modules);
    const refreshToken = generateOpaqueRefreshToken();
    const refreshTokenHash = await hashRefreshToken(refreshToken, tokenHashSecret);
    const appleSubjectHash = await hashAppleSubject(
      "account-deletion-apple-subject",
      tokenHashSecret,
    );
    const encryptedAppleRefresh = await encryptAppleRefreshToken(
      "apple-refresh-to-revoke",
      appleSubjectHash,
      environment,
    );
    await t.mutation(establishSession, {
      appleSubjectHash,
      encryptedAppleRefresh,
      sessionId: "account-deletion-session-0001",
      publicAccountIdCandidate: "account-deletion-public-0001",
      refreshTokenHash,
      now: nowMillis,
      expiresAt: nowMillis + 86_400_000,
    });
    const fetchProvider = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://appleid.apple.com/auth/revoke");
      expect(String(init?.body)).toContain("token=apple-refresh-to-revoke");
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchProvider);
    const requestId = "01890f5e-7b00-7000-8000-000000000777";
    const request = () => t.fetch("/auth/account/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-numa-shared-test-source": "account-deletion-source",
      },
      body: JSON.stringify({
        refreshToken,
        requestId,
        originatingTimeZone: "Europe/Madrid",
      }),
    });

    const first = await request();
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ deleted: true });
    const stored = await t.run(async (ctx) => ({
      accounts: await ctx.db.query("accounts").collect(),
      sessions: await ctx.db.query("sessions").collect(),
      authorizations: await ctx.db.query("appleAuthorizations").collect(),
      receipts: await ctx.db.query("accountDeletionReceipts").collect(),
    }));
    expect(stored.accounts).toEqual([]);
    expect(stored.sessions).toEqual([]);
    expect(stored.authorizations).toEqual([]);
    expect(stored.receipts).toHaveLength(1);
    expect(stored.receipts[0].requestId).toBe(requestId);

    const retry = await request();
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toEqual({ deleted: true });
    expect(fetchProvider).toHaveBeenCalledTimes(1);
  });
});

describe("Apple exchange HTTP boundary", () => {
  test("rate-bounds malformed requests before signing-key validation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const t = convexTest(schema, modules);
    const fetchProvider = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchProvider);
    const request = () => t.fetch("/auth/apple/exchange", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-numa-shared-test-source": "malformed-exchange-source",
      },
      body: JSON.stringify({}),
    });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect((await request()).status).toBe(400);
    }
    const limited = await request();
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({
      error: { code: "APPLE_EXCHANGE_RATE_LIMITED", retryable: true },
    });
    expect(fetchProvider).not.toHaveBeenCalled();
  });

  test("maps Apple token 429 and 5xx responses to retryable upstream errors", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    for (const expected of [
      {
        upstreamStatus: 429,
        responseStatus: 429,
        code: "APPLE_CODE_EXCHANGE_RATE_LIMITED",
      },
      {
        upstreamStatus: 503,
        responseStatus: 503,
        code: "APPLE_CODE_EXCHANGE_UNAVAILABLE",
      },
    ]) {
      const t = convexTest(schema, modules);
      const identityToken = await appleToken();
      stubAppleExchangeFetch(identityToken, undefined, expected.upstreamStatus);
      const response = await t.fetch("/auth/apple/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identityToken,
          authorizationCode: `upstream-${expected.upstreamStatus}-code`,
          nonce: rawNonce,
        }),
      });
      expect(response.status).toBe(expected.responseStatus);
      await expect(response.json()).resolves.toEqual({
        error: { code: expected.code, retryable: true },
      });
      await expect(t.run(async (ctx) =>
        await ctx.db.query("accounts").collect()
      )).resolves.toEqual([]);
      vi.unstubAllGlobals();
    }
  });

  test("rejects an exchanged subject mismatch without identity rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const t = convexTest(schema, modules);
    const presented = await appleToken();
    stubAppleExchangeFetch(
      await appleToken({ sub: "different-apple-subject" }),
      "apple-refresh-secret",
    );
    const response = await t.fetch("/auth/apple/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identityToken: presented,
        authorizationCode: "one-time-authorization-code",
        nonce: rawNonce,
      }),
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "APPLE_SUBJECT_MISMATCH", retryable: false },
    });
    await expect(t.run(async (ctx) => ({
      accounts: await ctx.db.query("accounts").collect(),
      sessions: await ctx.db.query("sessions").collect(),
      authorizations: await ctx.db.query("appleAuthorizations").collect(),
    }))).resolves.toEqual({ accounts: [], sessions: [], authorizations: [] });
  });

  test("rolls back a first exchange when Apple omits its refresh token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const t = convexTest(schema, modules);
    const identityToken = await appleToken();
    stubAppleExchangeFetch(identityToken, undefined);
    const response = await t.fetch("/auth/apple/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identityToken,
        authorizationCode: "missing-refresh-authorization-code",
        nonce: rawNonce,
      }),
    });
    expect(response.status).toBe(500);
    await expect(t.run(async (ctx) => ({
      accounts: await ctx.db.query("accounts").collect(),
      sessions: await ctx.db.query("sessions").collect(),
      authorizations: await ctx.db.query("appleAuthorizations").collect(),
    }))).resolves.toEqual({ accounts: [], sessions: [], authorizations: [] });
  });

  test("stores Apple refresh material only as bound ciphertext", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const t = convexTest(schema, modules);
    const identityToken = await appleToken();
    const authorizationCode = "ciphertext-only-authorization-code";
    const appleRefreshToken = "apple-refresh-secret-that-must-not-be-stored";
    stubAppleExchangeFetch(identityToken, appleRefreshToken);
    const response = await t.fetch("/auth/apple/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identityToken, authorizationCode, nonce: rawNonce }),
    });
    expect(response.status).toBe(200);
    const stored = await t.run(async (ctx) => ({
      accounts: await ctx.db.query("accounts").collect(),
      sessions: await ctx.db.query("sessions").collect(),
      authorizations: await ctx.db.query("appleAuthorizations").collect(),
      rateLimits: await ctx.db.query("identityRateLimits").collect(),
    }));
    expect(stored.accounts).toHaveLength(1);
    expect(stored.sessions).toHaveLength(1);
    expect(stored.authorizations).toHaveLength(1);
    const serialized = JSON.stringify(
      stored,
      (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value,
    );
    expect(serialized).not.toContain(appleRefreshToken);
    expect(serialized).not.toContain(authorizationCode);
    expect(serialized).not.toContain(identityToken);
    await expect(decryptAppleRefreshToken(
      stored.authorizations[0],
      stored.accounts[0].appleSubjectHash,
      environment,
    )).resolves.toBe(appleRefreshToken);
  });

  test("rate-bounds a repeated exchange before another Apple request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const t = convexTest(schema, modules);
    const presented = await appleToken();
    const fetchProvider = stubAppleExchangeFetch(
      await appleToken({ sub: "different-apple-subject" }),
      "apple-refresh-secret",
    );
    const request = () => t.fetch("/auth/apple/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identityToken: presented,
        authorizationCode: "rate-limited-authorization-code",
        nonce: rawNonce,
      }),
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await request()).status).toBe(401);
    }
    const limited = await request();
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({
      error: { code: "APPLE_EXCHANGE_RATE_LIMITED", retryable: true },
    });
    expect(fetchProvider).toHaveBeenCalledTimes(10);
  });
});

describe("Apple server-to-server notifications", () => {
  test("rate-bounds malformed requests before signing-key validation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const t = convexTest(schema, modules);
    const fetchProvider = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchProvider);
    const request = () => t.fetch("/auth/apple/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-numa-shared-test-source": "malformed-notification-source",
      },
      body: JSON.stringify({}),
    });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect((await request()).status).toBe(400);
    }
    const limited = await request();
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({
      error: { code: "APPLE_NOTIFICATION_RATE_LIMITED", retryable: true },
    });
    expect(fetchProvider).not.toHaveBeenCalled();
  });

  test("forged source traffic cannot consume the verified global quota", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const t = convexTest(schema, modules);
    const fetchProvider = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ keys: [applePublicJwk] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchProvider);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const forged = await appleServerNotificationToken({
        aud: "wrong.bundle",
        jti: `forged-source-a-${attempt}`,
      });
      const response = await t.fetch("/auth/apple/notifications", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-numa-shared-test-source": "source-a",
        },
        body: JSON.stringify({ payload: forged }),
      });
      expect(response.status).toBe(401);
    }
    const blockedSourceA = await t.fetch("/auth/apple/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-numa-shared-test-source": "source-a",
      },
      body: JSON.stringify({
        payload: await appleServerNotificationToken({ jti: "source-a-over-limit" }),
      }),
    });
    expect(blockedSourceA.status).toBe(429);

    const verifiedGlobalKey = await hashIdentityRateKey(
      "apple-notification-global-verified",
      "numa-shared",
      tokenHashSecret,
    );
    const globalBucket = await t.run(async (ctx) =>
      await ctx.db
        .query("identityRateLimits")
        .withIndex("by_bucket_key", (index) => index.eq("bucketKey", verifiedGlobalKey))
        .unique()
    );
    expect(globalBucket).toBeNull();

    const validSourceB = await t.fetch("/auth/apple/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-numa-shared-test-source": "source-b",
      },
      body: JSON.stringify({ payload: await appleServerNotificationToken() }),
    });
    expect(validSourceB.status).toBe(200);
    await expect(validSourceB.json()).resolves.toEqual({
      processed: 1,
      duplicates: 0,
      ignored: 0,
      revokedSessions: 0,
    });
  });

  test("rejects malformed shape and missing kid before any Apple JWKS fetch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const t = convexTest(schema, modules);
    const fetchProvider = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ keys: [applePublicJwk] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchProvider);
    for (const payload of [
      "not-a-jwt",
      await appleServerNotificationToken({}, { kid: undefined }),
    ]) {
      const response = await t.fetch("/auth/apple/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload }),
      });
      expect(response.status).toBe(401);
    }
    expect(fetchProvider).not.toHaveBeenCalled();
  });

  test("rate-bounds a repeated unauthenticated payload before another JWKS fetch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const t = convexTest(schema, modules);
    const fetchProvider = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ keys: [applePublicJwk] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchProvider);
    const payload = await appleServerNotificationToken({ aud: "wrong.bundle" });
    const request = () => t.fetch("/auth/apple/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload }),
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await request()).status).toBe(401);
    }
    const limited = await request();
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({
      error: { code: "APPLE_NOTIFICATION_RATE_LIMITED", retryable: true },
    });
    expect(fetchProvider).toHaveBeenCalledTimes(5);
  });

  test("revokes matched Apple authorization and every active session idempotently", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const t = convexTest(schema, modules);
    const refreshTokenHash = await hashRefreshToken(
      generateOpaqueRefreshToken(),
      tokenHashSecret,
    );
    await t.mutation(establishSession, {
      appleSubjectHash: await hashAppleSubject(
        "apple-user-stable-subject",
        tokenHashSecret,
      ),
      encryptedAppleRefresh: {
        encryptedRefreshToken: "encrypted-refresh-value",
        encryptionNonce: "encrypted-nonce-value",
        encryptionKeyVersion: "test-v1",
      },
      sessionId: "notification-session-0001",
      publicAccountIdCandidate: "notification-account-001",
      refreshTokenHash,
      now: nowMillis - 10_000,
      expiresAt: nowMillis + 86_400_000,
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe("https://appleid.apple.com/auth/keys");
      return new Response(JSON.stringify({ keys: [applePublicJwk] }), {
        status: 200,
      });
    }));
    const payload = await appleServerNotificationToken();
    const send = () => t.fetch("/auth/apple/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload }),
    });

    const first = await send();
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      processed: 1,
      duplicates: 0,
      revokedSessions: 1,
    });
    const duplicate = await send();
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({
      processed: 0,
      duplicates: 1,
      revokedSessions: 0,
    });

    const stored = await t.run(async (ctx) => ({
      authorizations: await ctx.db.query("appleAuthorizations").collect(),
      sessions: await ctx.db.query("sessions").collect(),
      notifications: await ctx.db.query("appleIdentityNotifications").collect(),
    }));
    expect(stored.authorizations[0].revokedAt).toBe(nowMillis);
    expect(stored.sessions[0].revokedAt).toBe(nowMillis);
    expect(stored.notifications).toHaveLength(1);
    expect(stored.notifications[0]).toMatchObject({
      eventType: "consent-revoked",
      notificationEventId: "apple-notification-jti-0001:0",
    });
  });

  test("records delayed Apple revocation without revoking a newer authorization", async () => {
    const t = convexTest(schema, modules);
    const subjectHash = await hashAppleSubject(
      "apple-user-reauthorized-subject",
      tokenHashSecret,
    );
    await t.mutation(establishSession, {
      appleSubjectHash: subjectHash,
      encryptedAppleRefresh: {
        encryptedRefreshToken: "encrypted-refresh-before-reauthorization",
        encryptionNonce: "encrypted-nonce-before-reauthorization",
        encryptionKeyVersion: "test-v1",
      },
      sessionId: "reauthorization-session-old-001",
      publicAccountIdCandidate: "reauthorization-account-001",
      refreshTokenHash: "reauthorization-refresh-hash-old-000001",
      now: nowMillis,
      expiresAt: nowMillis + 86_400_000,
    });
    const reauthorizedAt = nowMillis + 20_000;
    await t.mutation(establishSession, {
      appleSubjectHash: subjectHash,
      encryptedAppleRefresh: {
        encryptedRefreshToken: "encrypted-refresh-after-reauthorization",
        encryptionNonce: "encrypted-nonce-after-reauthorization",
        encryptionKeyVersion: "test-v2",
      },
      sessionId: "reauthorization-session-new-001",
      publicAccountIdCandidate: "unused-account-candidate-001",
      refreshTokenHash: "reauthorization-refresh-hash-new-000001",
      now: reauthorizedAt,
      expiresAt: reauthorizedAt + 86_400_000,
    });

    await expect(t.mutation(processAppleIdentityNotification, {
      notificationEventId: "delayed-revocation-notification:0",
      jwtId: "delayed-revocation-notification",
      eventType: "consent-revoked",
      appleSubjectHash: subjectHash,
      eventTime: nowSeconds + 10,
      now: reauthorizedAt + 1_000,
    })).resolves.toMatchObject({
      duplicate: false,
      revokedSessionCount: 0,
    });
    await expect(t.run(async (ctx) => ({
      authorizationRevoked:
        (await ctx.db.query("appleAuthorizations").unique())?.revokedAt !== undefined,
      sessionRevocations: (await ctx.db.query("sessions").collect())
        .map((session) => session.revokedAt !== undefined),
      receipts: (await ctx.db.query("appleIdentityNotifications").collect()).length,
    }))).resolves.toEqual({
      authorizationRevoked: false,
      sessionRevocations: [false, false],
      receipts: 1,
    });

    await expect(t.mutation(processAppleIdentityNotification, {
      notificationEventId: "current-revocation-notification:0",
      jwtId: "current-revocation-notification",
      eventType: "consent-revoked",
      appleSubjectHash: subjectHash,
      eventTime: nowSeconds + 21,
      now: reauthorizedAt + 2_000,
    })).resolves.toMatchObject({
      duplicate: false,
      revokedSessionCount: 2,
    });
  });

  test("persists a verified unknown event as one idempotent no-op receipt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const t = convexTest(schema, modules);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ keys: [applePublicJwk] }), { status: 200 })
    ));
    const payload = await appleServerNotificationToken({
      events: {
        type: "future-apple-event",
        sub: "unknown-event-subject",
        event_time: nowSeconds,
      },
    });
    const send = () => t.fetch("/auth/apple/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload }),
    });
    const first = await send();
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      processed: 0,
      duplicates: 0,
      ignored: 1,
      revokedSessions: 0,
    });
    const duplicate = await send();
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual({
      processed: 0,
      duplicates: 1,
      ignored: 1,
      revokedSessions: 0,
    });
    await expect(t.run(async (ctx) =>
      (await ctx.db.query("appleIdentityNotifications").collect()).map((row) => ({
        notificationEventId: row.notificationEventId,
        eventType: row.eventType,
        accountId: row.accountId,
      }))
    )).resolves.toEqual([{
      notificationEventId: "apple-notification-jti-0001:0",
      eventType: "future-apple-event",
      accountId: undefined,
    }]);
  });

  test("rejects an invalid notification audience without identity writes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMillis);
    const t = convexTest(schema, modules);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ keys: [applePublicJwk] }), { status: 200 })
    ));
    const response = await t.fetch("/auth/apple/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: await appleServerNotificationToken({ aud: "wrong.bundle" }),
      }),
    });
    expect(response.status).toBe(401);
    await expect(t.run(async (ctx) =>
      await ctx.db.query("appleIdentityNotifications").collect()
    )).resolves.toEqual([]);
  });
});

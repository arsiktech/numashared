// @vitest-environment node

import { generateKeyPairSync, verify } from "node:crypto";
import type { ClientHttp2Session, OutgoingHttpHeaders } from "node:http2";
import { describe, expect, test } from "vitest";

import {
  buildApnsRequest,
  classifyApnsResponse,
  createProviderTokenSource,
  readApnsConfiguration,
  sendApnsBatch,
  type ApnsConfiguration,
} from "./lib/apnsTransport";

function generateP256KeyPair() {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

function configuration(): ApnsConfiguration & {
  publicKey: ReturnType<typeof generateP256KeyPair>["publicKey"];
} {
  const { privateKey, publicKey } = generateP256KeyPair();
  return {
    keyId: "A1B2C3D4E5",
    teamId: "794UJ787LZ",
    topic: "tech.arsik.numashared",
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey,
  };
}

describe("APNs provider-token and HTTP/2 request contract", () => {
  test("signs ES256 provider JWTs, reuses them for 50 minutes, then rotates", () => {
    const config = configuration();
    const source = createProviderTokenSource();
    const issuedAt = 1_700_000_000_000;
    const token = source(config, issuedAt);
    const [encodedHeader, encodedClaims, encodedSignature] = token.split(".");

    expect(JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"))).toEqual({
      alg: "ES256",
      kid: config.keyId,
    });
    expect(JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8"))).toEqual({
      iss: config.teamId,
      iat: Math.floor(issuedAt / 1_000),
    });
    expect(Buffer.from(encodedSignature, "base64url")).toHaveLength(64);
    expect(verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      { key: config.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(encodedSignature, "base64url"),
    )).toBe(true);

    expect(source(config, issuedAt + 49 * 60_000)).toBe(token);
    expect(source(config, issuedAt + 50 * 60_000)).not.toBe(token);
  });

  test("builds amount-free alert requests for the correct sandbox and production hosts", () => {
    const config = configuration();
    const common = {
      configuration: config,
      providerToken: "signed-provider-token",
      deviceToken: "a".repeat(64),
      body: "New expense in Casa Mar affects your balance",
      potId: "01890f5e-7b00-7000-8000-000000000001",
    };
    const sandbox = buildApnsRequest({ ...common, environment: "sandbox" });
    const production = buildApnsRequest({ ...common, environment: "production" });

    expect(sandbox.origin).toBe("https://api.development.push.apple.com");
    expect(production.origin).toBe("https://api.push.apple.com");
    expect(sandbox.headers).toMatchObject({
      ":method": "POST",
      ":path": `/3/device/${common.deviceToken}`,
      authorization: "bearer signed-provider-token",
      "apns-topic": "tech.arsik.numashared",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": "0",
    });
    expect(JSON.parse(sandbox.body)).toEqual({
      aps: {
        alert: { title: "Numa Shared", body: common.body },
        sound: "default",
      },
      route: "pot",
      potId: common.potId,
    });
    expect(Buffer.byteLength(sandbox.body)).toBeLessThanOrEqual(4_096);
  });

  test("accepts only explicit APNs credentials and never reports their values", () => {
    const config = configuration();
    expect(readApnsConfiguration({
      APNS_KEY_ID: config.keyId,
      APPLE_TEAM_ID: config.teamId,
      APNS_PRIVATE_KEY_PKCS8_PEM: config.privateKey,
    })).toMatchObject({
      keyId: config.keyId,
      teamId: config.teamId,
      topic: "tech.arsik.numashared",
    });
    expect(() => readApnsConfiguration({})).toThrow("APNS_CONFIGURATION_INVALID");
    expect(() => buildApnsRequest({
      configuration: config,
      providerToken: "token",
      deviceToken: "not-a-device-token",
      environment: "sandbox",
      body: "Safe body",
      potId: "pot",
    })).toThrow("APNS_REQUEST_INVALID");
  });

  test("classifies only timestamped 410 responses as safe token invalidations", () => {
    expect(classifyApnsResponse(200, "")).toEqual({ kind: "success" });
    expect(classifyApnsResponse(410, JSON.stringify({
      reason: "Unregistered",
      timestamp: 1_700_000_000_123,
    }))).toEqual({ kind: "unregistered", invalidatedAtMillis: 1_700_000_000_123 });
    expect(classifyApnsResponse(410, JSON.stringify({
      reason: "Unregistered",
      timestamp: 1_700_000_000,
    }))).toEqual({ kind: "unregistered", invalidatedAtMillis: 1_700_000_000_000 });
    expect(classifyApnsResponse(410, "not-json")).toEqual({ kind: "rejected" });
    expect(classifyApnsResponse(400, JSON.stringify({ timestamp: 1_700_000_000_123 })))
      .toEqual({ kind: "rejected" });
  });

  test("sends each environment over one reusable HTTP/2 session", async () => {
    const config = configuration();
    const sandbox = buildApnsRequest({
      configuration: config,
      providerToken: "provider-token",
      deviceToken: "a".repeat(64),
      environment: "sandbox",
      body: "Sandbox body",
      potId: "pot-sandbox",
    });
    const production = buildApnsRequest({
      configuration: config,
      providerToken: "provider-token",
      deviceToken: "b".repeat(64),
      environment: "production",
      body: "Production body",
      potId: "pot-production",
    });
    const secondSandbox = buildApnsRequest({
      configuration: config,
      providerToken: "provider-token",
      deviceToken: "c".repeat(64),
      environment: "sandbox",
      body: "Second sandbox body",
      potId: "pot-sandbox-two",
    });
    const opened: string[] = [];
    const closed: string[] = [];
    const sent: Array<{ origin: string; headers: OutgoingHttpHeaders; body: string }> = [];
    const connector = (origin: string): ClientHttp2Session => {
      opened.push(origin);
      return {
        request(headers: OutgoingHttpHeaders) {
          const listeners: {
            response?: (headers: Record<string, string | number>) => void;
            data?: (chunk: string) => void;
            end?: () => void;
            error?: (error: Error) => void;
          } = {};
          const stream = {
            setEncoding() {
              return stream;
            },
            on(event: string, listener: unknown) {
              if (event === "response") {
                listeners.response = listener as typeof listeners.response;
              } else if (event === "data") {
                listeners.data = listener as typeof listeners.data;
              } else if (event === "end") {
                listeners.end = listener as typeof listeners.end;
              } else if (event === "error") {
                listeners.error = listener as typeof listeners.error;
              }
              return stream;
            },
            close() {},
            end(body: string) {
              sent.push({ origin, headers, body });
              queueMicrotask(() => {
                const isSandbox = origin.includes("development");
                listeners.response?.({ ":status": isSandbox ? 200 : 410 });
                if (!isSandbox) {
                  listeners.data?.(JSON.stringify({
                    reason: "Unregistered",
                    timestamp: 1_700_000_000_123,
                  }));
                }
                listeners.end?.();
              });
            },
          };
          return stream;
        },
        once() {
          return this;
        },
        off() {
          return this;
        },
        close() {
          closed.push(origin);
        },
      } as ClientHttp2Session;
    };

    await expect(sendApnsBatch([sandbox, secondSandbox, production], connector))
      .resolves.toEqual([
      { deviceToken: sandbox.deviceToken, status: 200, body: "" },
      { deviceToken: secondSandbox.deviceToken, status: 200, body: "" },
      {
        deviceToken: production.deviceToken,
        status: 410,
        body: JSON.stringify({ reason: "Unregistered", timestamp: 1_700_000_000_123 }),
      },
    ]);
    expect(opened).toEqual([sandbox.origin, production.origin]);
    expect(closed).toEqual(opened);
    expect(sent).toHaveLength(3);
    expect(sent.map((request) => JSON.parse(request.body).potId))
      .toEqual(["pot-sandbox", "pot-sandbox-two", "pot-production"]);
  });
});

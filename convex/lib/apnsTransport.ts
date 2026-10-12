"use node";

import { createHash, sign } from "node:crypto";
import {
  connect,
  type ClientHttp2Session,
  type OutgoingHttpHeaders,
} from "node:http2";

export type ApnsEnvironment = "sandbox" | "production";

export type ApnsConfiguration = {
  keyId: string;
  teamId: string;
  topic: "tech.arsik.numashared";
  privateKey: string;
};

export type ApnsRequest = {
  origin: string;
  headers: Record<string, string>;
  body: string;
  deviceToken: string;
};

export type ApnsResponse = {
  deviceToken: string;
  status: number;
  body: string;
};

export type ApnsResponseClassification =
  | { kind: "success" }
  | { kind: "unregistered"; invalidatedAtMillis: number }
  | { kind: "rejected" };

const topic = "tech.arsik.numashared" as const;
const providerTokenLifetimeMillis = 50 * 60_000;
const deviceTokenPattern = /^[0-9a-f]{64,200}$/;
const identifierPattern = /^[A-Z0-9]{10}$/;

export function readApnsConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ApnsConfiguration {
  const keyId = environment.APNS_KEY_ID;
  const teamId = environment.APPLE_TEAM_ID;
  const privateKey = environment.APNS_PRIVATE_KEY_PKCS8_PEM;
  if (
    !keyId
    || !teamId
    || !privateKey
    || !identifierPattern.test(keyId)
    || !identifierPattern.test(teamId)
    || !privateKey.startsWith("-----BEGIN PRIVATE KEY-----")
    || !privateKey.trimEnd().endsWith("-----END PRIVATE KEY-----")
  ) {
    throw new Error("APNS_CONFIGURATION_INVALID");
  }
  return { keyId, teamId, topic, privateKey };
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createProviderTokenSource() {
  let cached: {
    configurationKey: string;
    issuedAtMillis: number;
    token: string;
  } | undefined;

  return (configuration: ApnsConfiguration, nowMillis = Date.now()): string => {
    const configurationKey = [
      configuration.teamId,
      configuration.keyId,
      createHash("sha256").update(configuration.privateKey).digest("hex"),
    ].join(":");
    const age = cached ? nowMillis - cached.issuedAtMillis : -1;
    if (
      cached
      && cached.configurationKey === configurationKey
      && age >= 0
      && age < providerTokenLifetimeMillis
    ) {
      return cached.token;
    }

    const header = encodeJson({ alg: "ES256", kid: configuration.keyId });
    const claims = encodeJson({
      iss: configuration.teamId,
      iat: Math.floor(nowMillis / 1_000),
    });
    const signingInput = `${header}.${claims}`;
    let signature: Buffer;
    try {
      signature = sign("sha256", Buffer.from(signingInput), {
        key: configuration.privateKey,
        dsaEncoding: "ieee-p1363",
      });
    } catch {
      throw new Error("APNS_CONFIGURATION_INVALID");
    }
    const token = `${signingInput}.${signature.toString("base64url")}`;
    cached = { configurationKey, issuedAtMillis: nowMillis, token };
    return token;
  };
}

export function buildApnsRequest(args: {
  configuration: ApnsConfiguration;
  providerToken: string;
  deviceToken: string;
  environment: ApnsEnvironment;
  body: string;
  potId: string;
}): ApnsRequest {
  if (
    !deviceTokenPattern.test(args.deviceToken)
    || args.providerToken.length === 0
    || args.body.length === 0
    || args.potId.length === 0
  ) {
    throw new Error("APNS_REQUEST_INVALID");
  }
  const body = JSON.stringify({
    aps: {
      alert: { title: "Numa Shared", body: args.body },
      sound: "default",
    },
    route: "pot",
    potId: args.potId,
  });
  if (Buffer.byteLength(body) > 4_096) throw new Error("APNS_REQUEST_INVALID");
  return {
    origin: args.environment === "sandbox"
      ? "https://api.development.push.apple.com"
      : "https://api.push.apple.com",
    headers: {
      ":method": "POST",
      ":path": `/3/device/${args.deviceToken}`,
      authorization: `bearer ${args.providerToken}`,
      "apns-topic": args.configuration.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": "0",
    },
    body,
    deviceToken: args.deviceToken,
  };
}

export function classifyApnsResponse(
  status: number,
  body: string,
): ApnsResponseClassification {
  if (status === 200) return { kind: "success" };
  if (status !== 410) return { kind: "rejected" };
  try {
    const parsed = JSON.parse(body) as { timestamp?: unknown };
    if (
      typeof parsed.timestamp !== "number"
      || !Number.isFinite(parsed.timestamp)
      || parsed.timestamp <= 0
    ) {
      return { kind: "rejected" };
    }
    const invalidatedAtMillis = parsed.timestamp < 10_000_000_000
      ? parsed.timestamp * 1_000
      : parsed.timestamp;
    return { kind: "unregistered", invalidatedAtMillis };
  } catch {
    return { kind: "rejected" };
  }
}

function sendOnSession(
  session: ClientHttp2Session,
  request: ApnsRequest,
): Promise<ApnsResponse> {
  return new Promise((resolve, reject) => {
    const stream = session.request(request.headers as OutgoingHttpHeaders);
    let status = 0;
    let body = "";
    stream.setEncoding("utf8");
    stream.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    stream.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body) > 4_096) {
        stream.close();
        reject(new Error("APNS_TRANSPORT_FAILED"));
      }
    });
    stream.on("end", () => {
      if (!Number.isInteger(status) || status <= 0) {
        reject(new Error("APNS_TRANSPORT_FAILED"));
        return;
      }
      resolve({ deviceToken: request.deviceToken, status, body });
    });
    stream.on("error", () => reject(new Error("APNS_TRANSPORT_FAILED")));
    stream.end(request.body);
  });
}

export async function sendApnsBatch(
  requests: readonly ApnsRequest[],
  connector: (origin: string) => ClientHttp2Session = connect,
): Promise<ApnsResponse[]> {
  const byOrigin = new Map<string, ApnsRequest[]>();
  for (const request of requests) {
    const group = byOrigin.get(request.origin) ?? [];
    group.push(request);
    byOrigin.set(request.origin, group);
  }

  const responses: ApnsResponse[] = [];
  for (const [origin, group] of byOrigin) {
    const session = connector(origin);
    let sessionFailure: ((error: Error) => void) | undefined;
    const failed = new Promise<never>((_, reject) => {
      sessionFailure = () => reject(new Error("APNS_TRANSPORT_FAILED"));
      session.once("error", sessionFailure);
    });
    try {
      const delivered = await Promise.race([
        Promise.all(group.map((request) => sendOnSession(session, request))),
        failed,
      ]);
      responses.push(...delivered);
    } catch {
      throw new Error("APNS_TRANSPORT_FAILED");
    } finally {
      if (sessionFailure) session.off("error", sessionFailure);
      session.close();
    }
  }
  return responses;
}

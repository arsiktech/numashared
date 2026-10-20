/** Apple Sign-In token verification, JWKS fetching, code exchange/revocation and
 * client-secret minting against the Apple ID endpoints. */
const appleIdentityAlgorithm = "RS256";
import {
  fetchWithTimeout,
  IdentityError,
  isObject,
  numericDate,
  parseJwt,
  sha256Hex,
  signJwt,
  constantTimeEqual,
  verifyAppleRs256Jwt,
  signingAlgorithm,
  type AppleJwk,
  type JsonObject,
} from "./jwt";
import type { IdentityEnvironment } from "./environment";
export const appleIssuer = "https://appleid.apple.com";
export const accessTokenLifetimeSeconds = 5 * 60;
const appleKeysURL = "https://appleid.apple.com/auth/keys";
const appleTokenURL = "https://appleid.apple.com/auth/token";
const appleRevokeURL = "https://appleid.apple.com/auth/revoke";
const appleHttpTimeoutMillis = 5_000;

export interface AppleIdentity {
  subject: string;
  relayEmail?: string;
}

export interface AppleServerEvent {
  eventId: string;
  eventType: string;
  subject: string;
  eventTime: number;
  supported: boolean;
  revokesAuthorization: boolean;
}

export interface AppleServerNotification {
  jwtId: string;
  events: AppleServerEvent[];
}
export async function fetchAppleJwks(
  fetchProvider: typeof fetch,
  timeoutMillis = appleHttpTimeoutMillis,
): Promise<AppleJwk[]> {
  let response: Response;
  let text: string;
  try {
    ({ response, text } = await fetchWithTimeout(fetchProvider, appleKeysURL, {
      method: "GET",
      headers: { Accept: "application/json" },
    }, timeoutMillis, async (receivedResponse) => ({
      response: receivedResponse,
      text: await receivedResponse.text(),
    })));
  } catch {
    throw new IdentityError("APPLE_KEYS_UNAVAILABLE", 503);
  }
  if (!response.ok) throw new IdentityError("APPLE_KEYS_UNAVAILABLE", 503);
  if (text.length > 65_536) throw new IdentityError("APPLE_KEYS_UNAVAILABLE", 503);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new IdentityError("APPLE_KEYS_UNAVAILABLE", 503);
  }
  if (!isObject(body) || !Array.isArray(body.keys)) {
    throw new IdentityError("APPLE_KEYS_UNAVAILABLE", 503);
  }
  return body.keys.filter((key): key is AppleJwk =>
    isObject(key) && typeof key.kid === "string"
  );
}

export async function verifyAppleIdentityToken(
  token: string,
  rawNonce: string,
  expectedClientId: string,
  keys: AppleJwk[],
  nowSeconds: number,
  cryptoProvider: Crypto = crypto,
): Promise<AppleIdentity> {
  if (rawNonce.length < 16 || rawNonce.length > 256) {
    throw new IdentityError("APPLE_NONCE_REJECTED", 401);
  }
  const parsed = parseJwt(token);
  const keyId = parsed.header.kid;
  if (typeof keyId !== "string") {
    throw new IdentityError("TOKEN_HEADER_REJECTED", 401);
  }
  const key = keys.find((candidate) => candidate.kid === keyId);
  if (!key) throw new IdentityError("TOKEN_KEY_REJECTED", 401);
  const claims = await verifyAppleRs256Jwt(token, key, cryptoProvider);
  if (claims.iss !== appleIssuer || claims.aud !== expectedClientId) {
    throw new IdentityError("APPLE_AUDIENCE_REJECTED", 401);
  }
  if (numericDate(claims, "exp") <= nowSeconds) {
    throw new IdentityError("TOKEN_EXPIRED", 401);
  }
  if (numericDate(claims, "iat") > nowSeconds + 60) {
    throw new IdentityError("TOKEN_CLAIMS_REJECTED", 401);
  }
  const expectedNonce = await sha256Hex(rawNonce, cryptoProvider);
  if (
    typeof claims.nonce !== "string"
    || !constantTimeEqual(claims.nonce, expectedNonce)
  ) {
    throw new IdentityError("APPLE_NONCE_REJECTED", 401);
  }
  if (typeof claims.sub !== "string" || claims.sub.length < 1 || claims.sub.length > 255) {
    throw new IdentityError("TOKEN_CLAIMS_REJECTED", 401);
  }
  const emailVerified = claims.email_verified === true || claims.email_verified === "true";
  const relayEmail = emailVerified
    && typeof claims.email === "string"
    && claims.email.length <= 254
    && claims.email.includes("@")
    ? claims.email
    : undefined;
  return { subject: claims.sub, relayEmail };
}

function parseAppleServerEvents(value: unknown): JsonObject[] {
  let parsed = value;
  if (typeof parsed === "string") {
    if (parsed.length < 2 || parsed.length > 16_384) {
      throw new IdentityError("TOKEN_CLAIMS_REJECTED", 401);
    }
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw new IdentityError("TOKEN_CLAIMS_REJECTED", 401);
    }
  }
  const events = Array.isArray(parsed) ? parsed : [parsed];
  if (events.length < 1 || events.length > 8 || events.some((event) => !isObject(event))) {
    throw new IdentityError("TOKEN_CLAIMS_REJECTED", 401);
  }
  return events as JsonObject[];
}

export function preflightAppleServerNotification(token: string): string {
  const parsed = parseJwt(token);
  if (
    parsed.header.alg !== appleIdentityAlgorithm
    || (parsed.header.typ !== undefined && parsed.header.typ !== "JWT")
    || typeof parsed.header.kid !== "string"
    || parsed.header.kid.length < 1
    || parsed.header.kid.length > 128
    || parsed.signature.byteLength < 128
    || parsed.signature.byteLength > 512
  ) {
    throw new IdentityError("TOKEN_HEADER_REJECTED", 401);
  }
  if (
    typeof parsed.claims.iss !== "string"
    || parsed.claims.iss.length < 1
    || parsed.claims.iss.length > 255
    || typeof parsed.claims.aud !== "string"
    || parsed.claims.aud.length < 1
    || parsed.claims.aud.length > 255
    || !Number.isSafeInteger(parsed.claims.iat)
    || typeof parsed.claims.jti !== "string"
    || parsed.claims.jti.length < 1
    || parsed.claims.jti.length > 255
  ) {
    throw new IdentityError("TOKEN_CLAIMS_REJECTED", 401);
  }
  parseAppleServerEvents(parsed.claims.events);
  return parsed.header.kid;
}

export async function verifyAppleServerNotification(
  token: string,
  expectedClientId: string,
  keys: AppleJwk[],
  nowSeconds: number,
  cryptoProvider: Crypto = crypto,
): Promise<AppleServerNotification> {
  const keyId = preflightAppleServerNotification(token);
  const key = keys.find((candidate) => candidate.kid === keyId);
  if (!key) throw new IdentityError("TOKEN_KEY_REJECTED", 401);
  const claims = await verifyAppleRs256Jwt(token, key, cryptoProvider);
  if (claims.iss !== appleIssuer || claims.aud !== expectedClientId) {
    throw new IdentityError("APPLE_AUDIENCE_REJECTED", 401);
  }
  const issuedAt = numericDate(claims, "iat");
  if (issuedAt > nowSeconds + 60 || issuedAt < nowSeconds - 7 * 24 * 60 * 60) {
    throw new IdentityError("TOKEN_CLAIMS_REJECTED", 401);
  }
  if (claims.exp !== undefined && numericDate(claims, "exp") <= nowSeconds) {
    throw new IdentityError("TOKEN_EXPIRED", 401);
  }
  if (
    typeof claims.jti !== "string"
    || claims.jti.length < 1
    || claims.jti.length > 255
  ) {
    throw new IdentityError("TOKEN_CLAIMS_REJECTED", 401);
  }

  const events = parseAppleServerEvents(claims.events).map((event, index) => {
    if (
      typeof event.type !== "string"
      || event.type.length < 1
      || event.type.length > 64
      || typeof event.sub !== "string"
      || event.sub.length < 1
      || event.sub.length > 255
      || !Number.isSafeInteger(event.event_time)
      || (event.event_time as number) < 0
    ) {
      throw new IdentityError("TOKEN_CLAIMS_REJECTED", 401);
    }
    const supported = [
      "email-enabled",
      "email-disabled",
      "consent-revoked",
      "account-delete",
    ].includes(event.type);
    return {
      eventId: `${claims.jti}:${index}`,
      eventType: event.type,
      subject: event.sub,
      eventTime: event.event_time as number,
      supported,
      revokesAuthorization:
        event.type === "consent-revoked" || event.type === "account-delete",
    };
  });
  return { jwtId: claims.jti, events };
}

export async function createAppleClientSecret(
  environment: IdentityEnvironment,
  nowSeconds: number,
  cryptoProvider: Crypto = crypto,
  clientId: string = environment.appleClientId,
): Promise<string> {
  return await signJwt(
    { alg: signingAlgorithm, kid: environment.appleKeyId, typ: "JWT" },
    {
      iss: environment.appleTeamId,
      iat: nowSeconds,
      exp: nowSeconds + accessTokenLifetimeSeconds,
      aud: appleIssuer,
      sub: clientId,
    },
    environment.applePrivateKeyPkcs8Pem,
    cryptoProvider,
  );
}

export async function exchangeAppleAuthorizationCode(
  authorizationCode: string,
  clientSecret: string,
  clientId: string,
  fetchProvider: typeof fetch,
  timeoutMillis = appleHttpTimeoutMillis,
  redirectURI?: string,
): Promise<{ idToken: string; refreshToken?: string }> {
  if (authorizationCode.length < 1 || authorizationCode.length > 4_096) {
    throw new IdentityError("APPLE_CODE_REJECTED", 400);
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: authorizationCode,
    grant_type: "authorization_code",
  });
  // A web authorization code is bound to the redirect URI it was issued for.
  if (redirectURI !== undefined) body.set("redirect_uri", redirectURI);
  let response: Response;
  let text: string;
  try {
    ({ response, text } = await fetchWithTimeout(fetchProvider, appleTokenURL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }, timeoutMillis, async (receivedResponse) => ({
      response: receivedResponse,
      text: await receivedResponse.text(),
    })));
  } catch {
    throw new IdentityError("APPLE_CODE_EXCHANGE_UNAVAILABLE", 503);
  }
  if (response.status === 429) {
    throw new IdentityError("APPLE_CODE_EXCHANGE_RATE_LIMITED", 429);
  }
  if (response.status >= 500) {
    throw new IdentityError("APPLE_CODE_EXCHANGE_UNAVAILABLE", 503);
  }
  if (text.length > 65_536) throw new IdentityError("APPLE_CODE_EXCHANGE_FAILED", 401);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new IdentityError("APPLE_CODE_EXCHANGE_FAILED", 401);
  }
  if (!response.ok || !isObject(payload) || typeof payload.id_token !== "string") {
    throw new IdentityError("APPLE_CODE_EXCHANGE_FAILED", 401);
  }
  if (
    payload.refresh_token !== undefined
    && (typeof payload.refresh_token !== "string" || payload.refresh_token.length < 1)
  ) {
    throw new IdentityError("APPLE_CODE_EXCHANGE_FAILED", 401);
  }
  return {
    idToken: payload.id_token,
    refreshToken: payload.refresh_token as string | undefined,
  };
}

export async function revokeAppleRefreshToken(
  refreshToken: string,
  clientSecret: string,
  clientId: string,
  fetchProvider: typeof fetch,
  timeoutMillis = appleHttpTimeoutMillis,
): Promise<void> {
  if (refreshToken.length < 1 || refreshToken.length > 8_192) {
    throw new IdentityError("APPLE_AUTHORIZATION_UNREADABLE", 503);
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    token: refreshToken,
    token_type_hint: "refresh_token",
  });
  let response: Response;
  try {
    response = await fetchWithTimeout(fetchProvider, appleRevokeURL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }, timeoutMillis, async (receivedResponse) => receivedResponse);
  } catch {
    throw new IdentityError("APPLE_REVOCATION_UNAVAILABLE", 503);
  }
  if (!response.ok) throw new IdentityError("APPLE_REVOCATION_FAILED", 503);
}

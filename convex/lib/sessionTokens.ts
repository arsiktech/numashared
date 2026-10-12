/** Session token lifecycle: opaque refresh tokens, Apple refresh-token encryption
 * at rest, NUMA access-token issuance, and the shared identity HTTP error response. */
import {
  type AppleJwk,
  type JsonObject,
  decodeBase64Url,
  encodeBase64Url,
  IdentityError,
  ownedBuffer,
  sha256Hex,
  signJwt,
  verifyEs256Jwt,
} from "./jwt";
import { numericDate } from "./jwt";
import { accessTokenLifetimeSeconds, appleIssuer } from "./appleIdentity";
import type { IdentityEnvironment, SessionSigningEnvironment } from "./environment";

export const refreshSessionLifetimeMillis = 30 * 24 * 60 * 60 * 1_000;

export interface SessionTokenClaims {
  publicAccountId: string;
  sessionId: string;
}

const signingAlgorithm = "ES256";

export async function importHmacKey(secret: string, cryptoProvider: Crypto): Promise<CryptoKey> {
  if (secret.length < 32) throw new IdentityError("IDENTITY_CONFIGURATION_INVALID", 503);
  return await cryptoProvider.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function hmac(
  value: string,
  secret: string,
  cryptoProvider: Crypto,
): Promise<string> {
  const key = await importHmacKey(secret, cryptoProvider);
  const signature = await cryptoProvider.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

export async function hashIdentityRateKey(
  scope: string,
  value: string,
  secret: string,
  cryptoProvider: Crypto = crypto,
): Promise<string> {
  if (
    !/^[a-z0-9-]{3,64}$/u.test(scope)
    || value.length < 1
    || value.length > 16_384
  ) {
    throw new IdentityError("IDENTITY_INPUT_INVALID", 400);
  }
  return await hmac(`identity-rate\u0000${scope}\u0000${value}`, secret, cryptoProvider);
}

export async function hashRefreshToken(
  token: string,
  secret: string,
  cryptoProvider: Crypto = crypto,
): Promise<string> {
  if (token.length < 32 || token.length > 512) {
    throw new IdentityError("REFRESH_TOKEN_INVALID", 401);
  }
  return await hmac(`refresh\u0000${token}`, secret, cryptoProvider);
}

export async function hashAppleSubject(
  subject: string,
  secret: string,
  cryptoProvider: Crypto = crypto,
): Promise<string> {
  return await hmac(`${appleIssuer}\u0000${subject}`, secret, cryptoProvider);
}

export async function hashLocalE2ESubject(
  subject: string,
  secret: string,
  cryptoProvider: Crypto = crypto,
): Promise<string> {
  if (subject.length < 1 || subject.length > 128) {
    throw new IdentityError("IDENTITY_INPUT_INVALID", 400);
  }
  return await hmac(`local-e2e\u0000${subject}`, secret, cryptoProvider);
}

export function generateOpaqueRefreshToken(cryptoProvider: Crypto = crypto): string {
  const bytes = new Uint8Array(32);
  cryptoProvider.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

export function decodeEncryptionKey(value: string): Uint8Array {
  const key = decodeBase64Url(value);
  if (key.byteLength !== 32) {
    throw new IdentityError("IDENTITY_CONFIGURATION_INVALID", 503);
  }
  return key;
}

export interface EncryptedAppleRefreshToken {
  encryptedRefreshToken: string;
  encryptionNonce: string;
  encryptionKeyVersion: string;
}

export async function encryptAppleRefreshToken(
  refreshToken: string,
  appleSubjectHash: string,
  environment: IdentityEnvironment,
  cryptoProvider: Crypto = crypto,
): Promise<EncryptedAppleRefreshToken> {
  const key = await cryptoProvider.subtle.importKey(
    "raw",
    ownedBuffer(decodeEncryptionKey(environment.appleRefreshEncryptionKey)),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const nonce = new Uint8Array(12);
  cryptoProvider.getRandomValues(nonce);
  const additionalData = new TextEncoder().encode(
    `numa-shared/apple-refresh/v1\u0000${appleSubjectHash}`,
  );
  const encrypted = await cryptoProvider.subtle.encrypt(
    { name: "AES-GCM", iv: ownedBuffer(nonce), additionalData },
    key,
    new TextEncoder().encode(refreshToken),
  );
  return {
    encryptedRefreshToken: encodeBase64Url(new Uint8Array(encrypted)),
    encryptionNonce: encodeBase64Url(nonce),
    encryptionKeyVersion: environment.appleRefreshEncryptionKeyVersion,
  };
}

export async function decryptAppleRefreshToken(
  encrypted: EncryptedAppleRefreshToken,
  appleSubjectHash: string,
  environment: IdentityEnvironment,
  cryptoProvider: Crypto = crypto,
): Promise<string> {
  if (encrypted.encryptionKeyVersion !== environment.appleRefreshEncryptionKeyVersion) {
    throw new IdentityError("IDENTITY_CONFIGURATION_INVALID", 503);
  }
  const key = await cryptoProvider.subtle.importKey(
    "raw",
    ownedBuffer(decodeEncryptionKey(environment.appleRefreshEncryptionKey)),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  try {
    const decrypted = await cryptoProvider.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(decodeBase64Url(encrypted.encryptionNonce)),
        additionalData: new TextEncoder().encode(
          `numa-shared/apple-refresh/v1\u0000${appleSubjectHash}`,
        ),
      },
      key,
      ownedBuffer(decodeBase64Url(encrypted.encryptedRefreshToken)),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(decrypted);
  } catch {
    throw new IdentityError("APPLE_AUTHORIZATION_UNREADABLE", 503);
  }
}

export async function issueNumaAccessToken(
  claims: SessionTokenClaims,
  environment: SessionSigningEnvironment,
  nowSeconds: number,
  tokenId: string,
  absoluteSessionExpiresAtMillis: number,
  cryptoProvider: Crypto = crypto,
): Promise<{ token: string; expiresInSeconds: number }> {
  if (
    claims.publicAccountId.length < 16
    || claims.sessionId.length < 16
    || tokenId.length < 16
    || !Number.isSafeInteger(nowSeconds)
    || !Number.isSafeInteger(absoluteSessionExpiresAtMillis)
  ) {
    throw new IdentityError("IDENTITY_CONFIGURATION_INVALID", 503);
  }
  const absoluteExpirySeconds = Math.floor(absoluteSessionExpiresAtMillis / 1_000);
  const expiresAtSeconds = Math.min(
    nowSeconds + accessTokenLifetimeSeconds,
    absoluteExpirySeconds,
  );
  const expiresInSeconds = expiresAtSeconds - nowSeconds;
  if (expiresInSeconds <= 0) {
    throw new IdentityError("REFRESH_TOKEN_EXPIRED", 401);
  }
  const token = await signJwt(
    { alg: signingAlgorithm, kid: environment.sessionKeyId, typ: "JWT" },
    {
      iss: environment.sessionIssuer,
      aud: environment.sessionAudience,
      numa_session_audience: environment.sessionAudience,
      sub: claims.publicAccountId,
      sid: claims.sessionId,
      token_use: "access",
      jti: tokenId,
      iat: nowSeconds,
      nbf: nowSeconds - 5,
      exp: expiresAtSeconds,
    },
    environment.sessionPrivateKeyPkcs8Pem,
    cryptoProvider,
  );
  return { token, expiresInSeconds };
}

export async function verifyNumaAccessTokenForTest(
  token: string,
  publicJwk: AppleJwk,
  environment: IdentityEnvironment,
  nowSeconds: number,
  cryptoProvider: Crypto = crypto,
): Promise<JsonObject> {
  const claims = await verifyEs256Jwt(token, publicJwk, cryptoProvider);
  if (
    claims.iss !== environment.sessionIssuer
    || claims.aud !== environment.sessionAudience
    || claims.numa_session_audience !== environment.sessionAudience
    || claims.token_use !== "access"
    || typeof claims.sub !== "string"
    || typeof claims.sid !== "string"
    || numericDate(claims, "exp") <= nowSeconds
  ) {
    throw new IdentityError("TOKEN_CLAIMS_REJECTED", 401);
  }
  return claims;
}

export function identityErrorResponse(error: unknown): Response {
  const identityError = error instanceof IdentityError
    ? error
    : new IdentityError("IDENTITY_REQUEST_FAILED", 500);
  return new Response(JSON.stringify({
    error: {
      code: identityError.code,
      retryable: identityError.status === 429 || identityError.status >= 500,
    },
  }), {
    status: identityError.status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

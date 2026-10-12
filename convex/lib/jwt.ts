/** JWT + crypto primitives shared by the identity modules: the identity-wide error
 * type, base64url codec, ES256 signing and ES256/RS256 verification, key
 * validation, and the timeout-bounded fetch wrapper. */
export const signingAlgorithm = "ES256";
export const appleIdentityAlgorithm = "RS256";

export class IdentityError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "IdentityError";
  }
}
export interface SessionTokenClaims {
  publicAccountId: string;
  sessionId: string;
}

export type JsonObject = Record<string, unknown>;

export interface AppleJwk extends JsonWebKey {
  kid: string;
  alg?: string;
  use?: string;
}

export interface ParsedJwt {
  encodedHeader: string;
  encodedPayload: string;
  header: JsonObject;
  claims: JsonObject;
  signature: Uint8Array;
}
export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new IdentityError("TOKEN_MALFORMED", 401);
  }
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch {
    throw new IdentityError("TOKEN_MALFORMED", 401);
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function parseJsonSegment(value: string): JsonObject {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      decodeBase64Url(value),
    );
    const parsed: unknown = JSON.parse(decoded);
    if (!isObject(parsed)) throw new Error("not an object");
    return parsed;
  } catch (error) {
    if (error instanceof IdentityError) throw error;
    throw new IdentityError("TOKEN_MALFORMED", 401);
  }
}

export function parseJwt(token: string): ParsedJwt {
  if (token.length > 16_384) throw new IdentityError("TOKEN_MALFORMED", 401);
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw new IdentityError("TOKEN_MALFORMED", 401);
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const signature = decodeBase64Url(encodedSignature);
  return {
    encodedHeader,
    encodedPayload,
    header: parseJsonSegment(encodedHeader),
    claims: parseJsonSegment(encodedPayload),
    signature,
  };
}

export function jsonBase64Url(value: JsonObject): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export function pemToPkcs8(pem: string): Uint8Array {
  const match = pem.trim().match(
    /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PRIVATE KEY-----$/u,
  );
  if (!match) throw new IdentityError("IDENTITY_CONFIGURATION_INVALID", 503);
  const base64 = match[1].replaceAll(/\s/gu, "");
  try {
    const decoded = atob(base64);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    throw new IdentityError("IDENTITY_CONFIGURATION_INVALID", 503);
  }
}

export async function importPrivateSigningKey(
  pem: string,
  cryptoProvider: Crypto,
): Promise<CryptoKey> {
  try {
    return await cryptoProvider.subtle.importKey(
      "pkcs8",
      ownedBuffer(pemToPkcs8(pem)),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch (error) {
    if (error instanceof IdentityError) throw error;
    throw new IdentityError("IDENTITY_CONFIGURATION_INVALID", 503);
  }
}

export async function publicCoordinatesForPrivateSigningKey(
  pem: string,
  cryptoProvider: Crypto,
): Promise<{ x: string; y: string }> {
  try {
    const key = await cryptoProvider.subtle.importKey(
      "pkcs8",
      ownedBuffer(pemToPkcs8(pem)),
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    );
    const jwk = await cryptoProvider.subtle.exportKey("jwk", key);
    if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
      throw new IdentityError("IDENTITY_CONFIGURATION_INVALID", 503);
    }
    return { x: jwk.x, y: jwk.y };
  } catch (error) {
    if (error instanceof IdentityError) throw error;
    throw new IdentityError("IDENTITY_CONFIGURATION_INVALID", 503);
  }
}

export async function signJwt(
  header: JsonObject,
  claims: JsonObject,
  pem: string,
  cryptoProvider: Crypto,
): Promise<string> {
  const encodedHeader = jsonBase64Url(header);
  const encodedClaims = jsonBase64Url(claims);
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const privateKey = await importPrivateSigningKey(pem, cryptoProvider);
  const signature = await cryptoProvider.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  const signatureBytes = new Uint8Array(signature);
  if (signatureBytes.byteLength !== 64) {
    throw new IdentityError("IDENTITY_CONFIGURATION_INVALID", 503);
  }
  return `${signingInput}.${encodeBase64Url(signatureBytes)}`;
}

export async function verifyEs256Jwt(
  token: string,
  jwk: AppleJwk,
  cryptoProvider: Crypto,
): Promise<JsonObject> {
  const parsed = parseJwt(token);
  if (
    parsed.header.alg !== signingAlgorithm
    || parsed.header.typ !== "JWT"
    || parsed.header.kid !== jwk.kid
  ) {
    throw new IdentityError("TOKEN_HEADER_REJECTED", 401);
  }
  if (
    jwk.kty !== "EC"
    || jwk.crv !== "P-256"
    || (jwk.alg !== undefined && jwk.alg !== signingAlgorithm)
    || (jwk.use !== undefined && jwk.use !== "sig")
    || typeof jwk.d === "string"
  ) {
    throw new IdentityError("TOKEN_KEY_REJECTED", 401);
  }
  if (parsed.signature.byteLength !== 64) {
    throw new IdentityError("TOKEN_MALFORMED", 401);
  }
  let key: CryptoKey;
  try {
    key = await cryptoProvider.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new IdentityError("TOKEN_KEY_REJECTED", 401);
  }
  const verified = await cryptoProvider.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    ownedBuffer(parsed.signature),
    new TextEncoder().encode(`${parsed.encodedHeader}.${parsed.encodedPayload}`),
  );
  if (!verified) throw new IdentityError("TOKEN_SIGNATURE_REJECTED", 401);
  return parsed.claims;
}

export async function verifyAppleRs256Jwt(
  token: string,
  jwk: AppleJwk,
  cryptoProvider: Crypto,
): Promise<JsonObject> {
  const parsed = parseJwt(token);
  if (
    parsed.header.alg !== appleIdentityAlgorithm
    || (parsed.header.typ !== undefined && parsed.header.typ !== "JWT")
    || parsed.header.kid !== jwk.kid
  ) {
    throw new IdentityError("TOKEN_HEADER_REJECTED", 401);
  }
  if (
    jwk.kty !== "RSA"
    || (jwk.alg !== undefined && jwk.alg !== appleIdentityAlgorithm)
    || (jwk.use !== undefined && jwk.use !== "sig")
    || typeof jwk.n !== "string"
    || typeof jwk.e !== "string"
    || typeof jwk.d === "string"
  ) {
    throw new IdentityError("TOKEN_KEY_REJECTED", 401);
  }
  let modulusBytes: number;
  try {
    modulusBytes = decodeBase64Url(jwk.n).byteLength;
  } catch {
    throw new IdentityError("TOKEN_KEY_REJECTED", 401);
  }
  if (modulusBytes < 256 || parsed.signature.byteLength !== modulusBytes) {
    throw new IdentityError("TOKEN_KEY_REJECTED", 401);
  }
  let key: CryptoKey;
  try {
    key = await cryptoProvider.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new IdentityError("TOKEN_KEY_REJECTED", 401);
  }
  const verified = await cryptoProvider.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    ownedBuffer(parsed.signature),
    new TextEncoder().encode(`${parsed.encodedHeader}.${parsed.encodedPayload}`),
  );
  if (!verified) throw new IdentityError("TOKEN_SIGNATURE_REJECTED", 401);
  return parsed.claims;
}

export function numericDate(claims: JsonObject, name: string): number {
  const value = claims[name];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new IdentityError("TOKEN_CLAIMS_REJECTED", 401);
  }
  return value as number;
}

export async function sha256Hex(value: string, cryptoProvider: Crypto): Promise<string> {
  const digest = new Uint8Array(await cryptoProvider.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  ));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export function secureStringEqual(left: string, right: string): boolean {
  return constantTimeEqual(left, right);
}

export async function fetchWithTimeout<Result>(
  fetchProvider: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMillis: number,
  consume: (response: Response) => Promise<Result>,
): Promise<Result> {
  if (
    !Number.isSafeInteger(timeoutMillis)
    || timeoutMillis < 1
    || timeoutMillis > 30_000
  ) {
    throw new IdentityError("IDENTITY_CONFIGURATION_INVALID", 503);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMillis);
  try {
    const response = await fetchProvider(input, { ...init, signal: controller.signal });
    return await consume(response);
  } finally {
    clearTimeout(timeout);
  }
}

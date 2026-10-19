/** Sign in with Google: ID-token verification against Google's published keys.
 * The app gets the ID token from Google's native SDK; the server checks Google's RS256
 * signature, issuer, audience (one of our OAuth client IDs), expiry and issue time. */
import {
  fetchWithTimeout,
  IdentityError,
  isObject,
  numericDate,
  parseJwt,
  verifyAppleRs256Jwt,
  type AppleJwk,
} from "./jwt";

const googleIssuers = new Set(["https://accounts.google.com", "accounts.google.com"]);
export const googleSubjectNamespace = "https://accounts.google.com";
const googleKeysURL = "https://www.googleapis.com/oauth2/v3/certs";
const googleHttpTimeoutMillis = 5_000;

/**
 * The OAuth client IDs whose ID tokens we accept: the iOS client and the web client
 * (Android tokens carry the web client ID). Comma-separated in NUMA_SHARED_GOOGLE_CLIENT_IDS.
 * Sign in with Google is off when the variable is unset.
 */
export function readGoogleClientIds(env: Record<string, string | undefined>): string[] {
  const ids = (env.NUMA_SHARED_GOOGLE_CLIENT_IDS ?? "")
    .split(",").map((id) => id.trim()).filter((id) => id.length > 0);
  if (ids.length === 0) throw new IdentityError("GOOGLE_SIGN_IN_UNAVAILABLE", 503);
  for (const id of ids) {
    if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id)) {
      throw new IdentityError("IDENTITY_CONFIGURATION_INVALID", 503);
    }
  }
  return ids;
}

export async function fetchGoogleJwks(
  fetchProvider: typeof fetch,
  timeoutMillis = googleHttpTimeoutMillis,
): Promise<AppleJwk[]> {
  let response: Response;
  let text: string;
  try {
    ({ response, text } = await fetchWithTimeout(fetchProvider, googleKeysURL, {
      method: "GET",
      headers: { Accept: "application/json" },
    }, timeoutMillis, async (received) => ({ response: received, text: await received.text() })));
  } catch {
    throw new IdentityError("GOOGLE_KEYS_UNAVAILABLE", 503);
  }
  if (!response.ok || text.length > 65_536) throw new IdentityError("GOOGLE_KEYS_UNAVAILABLE", 503);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new IdentityError("GOOGLE_KEYS_UNAVAILABLE", 503);
  }
  if (!isObject(body) || !Array.isArray(body.keys)) throw new IdentityError("GOOGLE_KEYS_UNAVAILABLE", 503);
  return body.keys.filter((key): key is AppleJwk => isObject(key) && typeof key.kid === "string");
}

export async function verifyGoogleIdentityToken(
  token: string,
  allowedClientIds: readonly string[],
  keys: AppleJwk[],
  nowSeconds: number,
  cryptoProvider: Crypto = crypto,
): Promise<{ subject: string }> {
  const parsed = parseJwt(token);
  const keyId = parsed.header.kid;
  if (typeof keyId !== "string") throw new IdentityError("TOKEN_HEADER_REJECTED", 401);
  const key = keys.find((candidate) => candidate.kid === keyId);
  if (!key) throw new IdentityError("TOKEN_KEY_REJECTED", 401);
  const claims = await verifyAppleRs256Jwt(token, key, cryptoProvider);
  if (typeof claims.iss !== "string" || !googleIssuers.has(claims.iss)
    || typeof claims.aud !== "string" || !allowedClientIds.includes(claims.aud)) {
    throw new IdentityError("GOOGLE_AUDIENCE_REJECTED", 401);
  }
  if (numericDate(claims, "exp") <= nowSeconds) throw new IdentityError("TOKEN_EXPIRED", 401);
  if (numericDate(claims, "iat") > nowSeconds + 60) throw new IdentityError("TOKEN_CLAIMS_REJECTED", 401);
  if (typeof claims.sub !== "string" || claims.sub.length < 1 || claims.sub.length > 255) {
    throw new IdentityError("TOKEN_CLAIMS_REJECTED", 401);
  }
  return { subject: claims.sub };
}

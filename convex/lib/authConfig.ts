import type { AuthConfig } from "convex/server";

function configured(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required Numa Shared auth configuration: ${name}`);
  }
  return value;
}

function validateDataJwks(uri: string): void {
  const separator = uri.indexOf(",");
  if (separator < 0 || uri.length > 65_536) {
    throw new Error("NUMA_SHARED_AUTH_JWKS_URI contains an invalid data URI");
  }
  const metadata = uri.slice(0, separator);
  const encoded = uri.slice(separator + 1);
  let text: string;
  try {
    text = metadata.endsWith(";base64") ? atob(encoded) : decodeURIComponent(encoded);
  } catch {
    throw new Error("NUMA_SHARED_AUTH_JWKS_URI contains an invalid data URI");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("NUMA_SHARED_AUTH_JWKS_URI contains invalid JSON");
  }
  if (
    typeof value !== "object"
    || value === null
    || !Array.isArray((value as { keys?: unknown }).keys)
    || (value as { keys: unknown[] }).keys.length < 1
  ) {
    throw new Error("NUMA_SHARED_AUTH_JWKS_URI must contain at least one public key");
  }
  for (const candidate of (value as { keys: unknown[] }).keys) {
    const key = candidate as JsonWebKey & { kid?: unknown };
    if (
      typeof candidate !== "object"
      || candidate === null
      || key.kty !== "EC"
      || key.crv !== "P-256"
      || typeof key.x !== "string"
      || typeof key.y !== "string"
      || typeof key.d === "string"
      || key.alg !== "ES256"
      || key.use !== "sig"
      || typeof key.kid !== "string"
    ) {
      throw new Error("NUMA_SHARED_AUTH_JWKS_URI must contain public ES256 keys only");
    }
  }
}

export function authConfigFromEnvironment(
  env: Record<string, string | undefined>,
): AuthConfig {
  const issuer = configured(env, "NUMA_SHARED_SESSION_ISSUER");
  const applicationID = configured(env, "NUMA_SHARED_SESSION_AUDIENCE");
  const jwks = configured(env, "NUMA_SHARED_AUTH_JWKS_URI");
  if (!issuer.startsWith("https://") || issuer.includes("?") || issuer.includes("#")) {
    throw new Error("NUMA_SHARED_SESSION_ISSUER must be an exact HTTPS issuer URL");
  }
  if (applicationID !== "tech.arsik.numashared") {
    throw new Error("NUMA_SHARED_SESSION_AUDIENCE must match the app bundle identifier");
  }
  if (!jwks.startsWith("https://") && !jwks.startsWith("data:application/json")) {
    throw new Error("NUMA_SHARED_AUTH_JWKS_URI must be HTTPS or an application/json data URI");
  }
  if (jwks.startsWith("data:application/json")) validateDataJwks(jwks);
  return {
    providers: [{
      type: "customJwt",
      issuer,
      applicationID,
      jwks,
      algorithm: "ES256",
    }],
  };
}

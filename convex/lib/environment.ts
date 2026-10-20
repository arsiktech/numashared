/** Reads and validates the identity/signing environment out of process.env. */
import {
  importPrivateSigningKey,
  IdentityError,
  publicCoordinatesForPrivateSigningKey,
} from "./jwt";


export interface SessionSigningEnvironment {
  sessionIssuer: string;
  sessionAudience: string;
  sessionKeyId: string;
  sessionPrivateKeyPkcs8Pem: string;
  tokenHashSecret: string;
}

export interface IdentityEnvironment extends SessionSigningEnvironment {
  appleClientId: string;
  appleWebClientId?: string;
  appleWebRedirectURI?: string;
  appleTeamId: string;
  appleKeyId: string;
  applePrivateKeyPkcs8Pem: string;
  appleRefreshEncryptionKey: string;
  appleRefreshEncryptionKeyVersion: string;
}
function required(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name];
  if (!value || value.trim().length === 0) {
    throw new IdentityError("IDENTITY_CONFIGURATION_INVALID", 503);
  }
  return value;
}

function canonicalPrivateKeyMaterial(value: string): string {
  return value
    .replace(/-----BEGIN PRIVATE KEY-----/gu, "")
    .replace(/-----END PRIVATE KEY-----/gu, "")
    .replace(/\s/gu, "");
}
export function readSessionSigningEnvironment(
  env: Record<string, string | undefined>,
): SessionSigningEnvironment {
  const sessionIssuer = required(env, "NUMA_SHARED_SESSION_ISSUER");
  const sessionAudience = required(env, "NUMA_SHARED_SESSION_AUDIENCE");
  if (
    !sessionIssuer.startsWith("https://")
    || sessionIssuer.includes("?")
    || sessionIssuer.includes("#")
  ) {
    throw new IdentityError("IDENTITY_CONFIGURATION_INVALID", 503);
  }
  if (sessionAudience !== "tech.arsik.numashared") {
    throw new IdentityError("IDENTITY_CONFIGURATION_INVALID", 503);
  }
  return {
    sessionIssuer,
    sessionAudience,
    sessionKeyId: required(env, "NUMA_SHARED_AUTH_KEY_ID"),
    sessionPrivateKeyPkcs8Pem: required(
      env,
      "NUMA_SHARED_AUTH_PRIVATE_KEY_PKCS8_PEM",
    ),
    tokenHashSecret: required(env, "NUMA_SHARED_TOKEN_HASH_SECRET"),
  };
}

export function readIdentityEnvironment(
  env: Record<string, string | undefined>,
): IdentityEnvironment {
  const session = readSessionSigningEnvironment(env);
  const appleClientId = required(env, "SIWA_CLIENT_ID");
  const appleKeyId = required(env, "SIWA_KEY_ID");
  const applePrivateKeyPkcs8Pem = required(env, "SIWA_PRIVATE_KEY_PKCS8_PEM");
  if (appleClientId !== session.sessionAudience) {
    throw new IdentityError("IDENTITY_CONFIGURATION_INVALID", 503);
  }
  if (
    appleKeyId === session.sessionKeyId
    || canonicalPrivateKeyMaterial(applePrivateKeyPkcs8Pem)
      === canonicalPrivateKeyMaterial(session.sessionPrivateKeyPkcs8Pem)
  ) {
    throw new IdentityError("IDENTITY_CONFIGURATION_INVALID", 503);
  }
  // Sign in with Apple on the web uses a Services ID grouped with the app's App ID, so the same
  // person gets the same Apple subject in both. Optional: the web shows Apple only when it is set.
  const appleWebClientId = env.SIWA_WEB_CLIENT_ID?.trim() || undefined;
  const appleWebRedirectURI = env.SIWA_WEB_REDIRECT_URI?.trim() || undefined;
  return {
    ...session,
    appleClientId,
    appleWebClientId,
    appleWebRedirectURI,
    appleTeamId: required(env, "APPLE_TEAM_ID"),
    appleKeyId,
    applePrivateKeyPkcs8Pem,
    appleRefreshEncryptionKey: required(
      env,
      "NUMA_SHARED_APPLE_REFRESH_ENCRYPTION_KEY",
    ),
    appleRefreshEncryptionKeyVersion: required(
      env,
      "NUMA_SHARED_APPLE_REFRESH_ENCRYPTION_KEY_VERSION",
    ),
  };
}

export async function validateSessionSigningKey(
  environment: SessionSigningEnvironment,
  cryptoProvider: Crypto = crypto,
): Promise<void> {
  await importPrivateSigningKey(environment.sessionPrivateKeyPkcs8Pem, cryptoProvider);
}

export async function validateIdentitySigningKeys(
  environment: IdentityEnvironment,
  cryptoProvider: Crypto = crypto,
): Promise<void> {
  const [sessionPublicKey, applePublicKey] = await Promise.all([
    publicCoordinatesForPrivateSigningKey(
      environment.sessionPrivateKeyPkcs8Pem,
      cryptoProvider,
    ),
    publicCoordinatesForPrivateSigningKey(
      environment.applePrivateKeyPkcs8Pem,
      cryptoProvider,
    ),
  ]);
  if (
    sessionPublicKey.x === applePublicKey.x
    && sessionPublicKey.y === applePublicKey.y
  ) {
    throw new IdentityError("IDENTITY_CONFIGURATION_INVALID", 503);
  }
}


export interface SessionSigningEnvironment {
  sessionIssuer: string;
  sessionAudience: string;
  sessionKeyId: string;
  sessionPrivateKeyPkcs8Pem: string;
  tokenHashSecret: string;
}

export interface IdentityEnvironment extends SessionSigningEnvironment {
  appleClientId: string;
  appleWebClientId?: string;
  appleWebRedirectURI?: string;
  appleTeamId: string;
  appleKeyId: string;
  applePrivateKeyPkcs8Pem: string;
  appleRefreshEncryptionKey: string;
  appleRefreshEncryptionKeyVersion: string;
}

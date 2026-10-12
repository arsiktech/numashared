import { anyApi } from "convex/server";

import type { ActionCtx } from "./_generated/server";
import { httpAction } from "./_generated/server";
import {
  requireApprovedWriteTarget,
  requireLocalE2EAuthTarget,
} from "./lib/deployment";
import {
  createAppleClientSecret,
  decryptAppleRefreshToken,
  encryptAppleRefreshToken,
  exchangeAppleAuthorizationCode,
  fetchAppleJwks,
  generateOpaqueRefreshToken,
  hashAppleSubject,
  hashIdentityRateKey,
  hashLocalE2ESubject,
  hashRefreshToken,
  IdentityError,
  identityErrorResponse,
  issueNumaAccessToken,
  preflightAppleServerNotification,
  readIdentityEnvironment,
  readSessionSigningEnvironment,
  revokeAppleRefreshToken,
  refreshSessionLifetimeMillis,
  secureStringEqual,
  validateIdentitySigningKeys,
  validateSessionSigningKey,
  verifyAppleIdentityToken,
  verifyAppleServerNotification,
  type IdentityEnvironment,
  type SessionSigningEnvironment,
} from "./lib/identity";
import { ios18TimeZoneIdentifiers } from "./lib/ios18TimeZoneIdentifiers";
import { generateUUIDv7 } from "./lib/uuidV7";
import {
  consumeTrustedSourceRateLimit,
  trustedRequestSource,
  type RateLimitResult,
} from "./lib/httpRateLimit";

declare const process: { env: Record<string, string | undefined> };

interface EstablishResult {
  publicAccountId: string;
  sessionId: string;
  refreshExpiresAt: number;
}

interface RotateResult {
  status: "rotated" | "reused" | "invalid" | "revoked" | "expired";
  publicAccountId?: string;
  sessionId?: string;
  refreshExpiresAt?: number;
}

interface AppleNotificationMutationResult {
  duplicate: boolean;
  accountId?: string;
  revokedSessionCount: number;
}

interface AccountDeletionPreviewResult {
  authorized: boolean;
  pots: Array<{
    potId: string;
    name: string | null;
    outcome: "deleted" | "anonymized";
    successorName: string | null;
  }>;
}

interface AccountDeletionBeginResult {
  authorized: boolean;
  accountId?: string;
  appleSubjectHash?: string;
  authorization?: {
    encryptedRefreshToken: string;
    encryptionNonce: string;
    encryptionKeyVersion: string;
  } | null;
}

interface DeletionBatchResult {
  complete: boolean;
}

/**
 * Consume one or more identity rate-limit buckets and reject with the
 * endpoint's own error code when the caller exceeds the limit.
 */
async function consumeRateBuckets(
  ctx: ActionCtx,
  nowMillis: number,
  errorCode: string,
  buckets: Array<{ bucketKey: string; limit: bigint; windowMillis: number }>,
): Promise<void> {
  if (buckets.length >= 2) {
    await ctx.runMutation(anyApi.authSessions.deleteExpiredIdentityRateLimits, {
      now: nowMillis,
    });
  }
  const rateLimit = await ctx.runMutation(
    anyApi.authSessions.consumeIdentityRateLimits,
    { buckets, now: nowMillis },
  ) as RateLimitResult;
  if (!rateLimit.allowed) throw new IdentityError(errorCode, 429);
}

/**
 * Loop a batched mutation until it reports completion, bounded by the hard
 * step cap so a wedged backend fails loudly instead of spinning forever.
 */
async function runBatchUntilComplete(
  step: () => Promise<boolean>,
): Promise<void> {
  for (let stepIndex = 0; stepIndex < maximumDeletionSteps; stepIndex += 1) {
    if (await step()) return;
  }
  throw new IdentityError("ACCOUNT_DELETION_PENDING", 503);
}

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maximumDeletionSteps = 10_000;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new IdentityError("CONTENT_TYPE_REQUIRED", 415);
  }
  const text = await request.text();
  if (text.length < 2 || text.length > 24_576) {
    throw new IdentityError("IDENTITY_INPUT_INVALID", 400);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new IdentityError("IDENTITY_INPUT_INVALID", 400);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IdentityError("IDENTITY_INPUT_INVALID", 400);
  }
  return value as Record<string, unknown>;
}

function stringField(
  object: Record<string, unknown>,
  name: string,
  maximum: number,
): string {
  const value = object[name];
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new IdentityError("IDENTITY_INPUT_INVALID", 400);
  }
  return value;
}

/**
 * Shared endpoint preamble: deployment gate + identity environment + the
 * bounded string field each operation reads first.
 */
function readIdentityBody(
  environmentKind: "identity",
  body: Record<string, unknown>,
  field: string,
  maximum: number,
): { environment: IdentityEnvironment; value: string; nowMillis: number };
function readIdentityBody(
  environmentKind: "session",
  body: Record<string, unknown>,
  field: string,
  maximum: number,
): { environment: SessionSigningEnvironment; value: string; nowMillis: number };
function readIdentityBody(
  environmentKind: "identity" | "session",
  body: Record<string, unknown>,
  field: string,
  maximum: number,
): { environment: SessionSigningEnvironment | IdentityEnvironment; value: string; nowMillis: number } {
  requireApprovedWriteTarget();
  const environment = environmentKind === "identity"
    ? readIdentityEnvironment(process.env)
    : readSessionSigningEnvironment(process.env);
  return { environment, value: stringField(body, field, maximum), nowMillis: Date.now() };
}

async function exchangeApple(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const head = readIdentityBody("identity", body, "identityToken", 16_384);
  const { environment, nowMillis } = head;
  const identityToken = head.value;
  const authorizationCode = stringField(body, "authorizationCode", 4_096);
  const rawNonce = stringField(body, "nonce", 256);
  await validateIdentitySigningKeys(environment);
  const nowSeconds = Math.floor(nowMillis / 1_000);
  const [codeRateKey, tokenRateKey] = await Promise.all([
    hashIdentityRateKey(
      "apple-exchange-code",
      authorizationCode,
      environment.tokenHashSecret,
    ),
    hashIdentityRateKey(
      "apple-exchange-token",
      identityToken,
      environment.tokenHashSecret,
    ),
  ]);
  await consumeRateBuckets(ctx, nowMillis, "APPLE_EXCHANGE_RATE_LIMITED", [
    { bucketKey: codeRateKey, limit: 5n, windowMillis: 600_000 },
    { bucketKey: tokenRateKey, limit: 5n, windowMillis: 600_000 },
  ]);
  const appleKeys = await fetchAppleJwks(fetch);
  const presentedIdentity = await verifyAppleIdentityToken(
    identityToken,
    rawNonce,
    environment.appleClientId,
    appleKeys,
    nowSeconds,
  );
  const clientSecret = await createAppleClientSecret(environment, nowSeconds);
  const exchange = await exchangeAppleAuthorizationCode(
    authorizationCode,
    clientSecret,
    environment.appleClientId,
    fetch,
  );
  const exchangedIdentity = await verifyAppleIdentityToken(
    exchange.idToken,
    rawNonce,
    environment.appleClientId,
    appleKeys,
    nowSeconds,
  );
  if (exchangedIdentity.subject !== presentedIdentity.subject) {
    throw new IdentityError("APPLE_SUBJECT_MISMATCH", 401);
  }

  const appleSubjectHash = await hashAppleSubject(
    presentedIdentity.subject,
    environment.tokenHashSecret,
  );
  const encryptedAppleRefresh = exchange.refreshToken === undefined
    ? undefined
    : await encryptAppleRefreshToken(
      exchange.refreshToken,
      appleSubjectHash,
      environment,
    );
  const refreshToken = generateOpaqueRefreshToken();
  const refreshTokenHash = await hashRefreshToken(
    refreshToken,
    environment.tokenHashSecret,
  );
  const sessionId = crypto.randomUUID();
  const established = await ctx.runMutation(
    anyApi.authSessions.establishSession,
    {
      appleSubjectHash,
      relayEmail: presentedIdentity.relayEmail ?? exchangedIdentity.relayEmail,
      encryptedAppleRefresh,
      sessionId,
      publicAccountIdCandidate: crypto.randomUUID(),
      refreshTokenHash,
      now: nowMillis,
      expiresAt: nowMillis + refreshSessionLifetimeMillis,
    },
  ) as EstablishResult;
  const access = await issueNumaAccessToken(
    {
      publicAccountId: established.publicAccountId,
      sessionId: established.sessionId,
    },
    environment,
    nowSeconds,
    crypto.randomUUID(),
    established.refreshExpiresAt,
  );
  return jsonResponse({
    accessToken: access.token,
    accessTokenExpiresInSeconds: access.expiresInSeconds,
    refreshToken,
    refreshExpiresAt: established.refreshExpiresAt,
    accountId: established.publicAccountId,
  });
}

async function processAppleNotification(
  ctx: ActionCtx,
  body: Record<string, unknown>,
  sourceIP: string,
): Promise<Response> {
  const { environment, value: payload, nowMillis } = readIdentityBody(
    "identity", body, "payload", 16_384,
  );
  await validateIdentitySigningKeys(environment);
  preflightAppleServerNotification(payload);
  const payloadRateKey = await hashIdentityRateKey(
      "apple-notification-payload",
      `${sourceIP}\u0000${payload}`,
      environment.tokenHashSecret,
    );
  await consumeRateBuckets(ctx, nowMillis, "APPLE_NOTIFICATION_RATE_LIMITED", [
    { bucketKey: payloadRateKey, limit: 5n, windowMillis: 600_000 },
  ]);
  const appleKeys = await fetchAppleJwks(fetch);
  const notification = await verifyAppleServerNotification(
    payload,
    environment.appleClientId,
    appleKeys,
    Math.floor(nowMillis / 1_000),
  );
  const globalRateKey = await hashIdentityRateKey(
    "apple-notification-global-verified",
    "numa-shared",
    environment.tokenHashSecret,
  );
  await consumeRateBuckets(ctx, nowMillis, "APPLE_NOTIFICATION_RATE_LIMITED", [
    { bucketKey: globalRateKey, limit: 120n, windowMillis: 60_000 },
  ]);
  let processed = 0;
  let duplicates = 0;
  let ignored = 0;
  let revokedSessions = 0;
  for (const event of notification.events) {
    const result = await ctx.runMutation(
      anyApi.authSessions.processAppleIdentityNotification,
      {
        notificationEventId: event.eventId,
        jwtId: notification.jwtId,
        eventType: event.eventType,
        appleSubjectHash: await hashAppleSubject(
          event.subject,
          environment.tokenHashSecret,
        ),
        eventTime: event.eventTime,
        now: nowMillis,
      },
    ) as AppleNotificationMutationResult;
    if (!event.supported) ignored += 1;
    if (result.duplicate) duplicates += 1;
    else if (event.supported) processed += 1;
    revokedSessions += result.revokedSessionCount;
  }
  return jsonResponse({ processed, duplicates, ignored, revokedSessions });
}

async function refreshSession(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const { environment, value: currentRefreshToken, nowMillis } = readIdentityBody(
    "session", body, "refreshToken", 512,
  );
  const [refreshTokenHash, tokenRateKey] = await Promise.all([
    hashRefreshToken(currentRefreshToken, environment.tokenHashSecret),
    hashIdentityRateKey(
      "refresh-token",
      currentRefreshToken,
      environment.tokenHashSecret,
    ),
  ]);
  await consumeRateBuckets(ctx, nowMillis, "REFRESH_RATE_LIMITED", [
    { bucketKey: tokenRateKey, limit: 10n, windowMillis: 60_000 },
  ]);
  await validateSessionSigningKey(environment);
  const replacementRefreshToken = generateOpaqueRefreshToken();
  const replacementRefreshTokenHash = await hashRefreshToken(
    replacementRefreshToken,
    environment.tokenHashSecret,
  );
  await ctx.runMutation(anyApi.authSessions.deleteExpiredRefreshHistory, {
    now: nowMillis,
  });
  const result = await ctx.runMutation(anyApi.authSessions.rotateSession, {
    refreshTokenHash,
    replacementRefreshTokenHash,
    now: nowMillis,
  }) as RotateResult;
  if (result.status !== "rotated") {
    const code = result.status === "reused"
      ? "REFRESH_TOKEN_REUSED"
      : result.status === "expired"
        ? "REFRESH_TOKEN_EXPIRED"
        : "REFRESH_TOKEN_INVALID";
    throw new IdentityError(code, 401);
  }
  if (!result.publicAccountId || !result.sessionId || !result.refreshExpiresAt) {
    throw new IdentityError("IDENTITY_REQUEST_FAILED", 500);
  }
  const access = await issueNumaAccessToken(
    { publicAccountId: result.publicAccountId, sessionId: result.sessionId },
    environment,
    Math.floor(nowMillis / 1_000),
    crypto.randomUUID(),
    result.refreshExpiresAt,
  );
  return jsonResponse({
    accessToken: access.token,
    accessTokenExpiresInSeconds: access.expiresInSeconds,
    refreshToken: replacementRefreshToken,
    refreshExpiresAt: result.refreshExpiresAt,
    accountId: result.publicAccountId,
  });
}

async function logoutSession(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const { environment, value: refreshToken, nowMillis } = readIdentityBody(
    "session", body, "refreshToken", 512,
  );
  const [refreshTokenHash, tokenRateKey] = await Promise.all([
    hashRefreshToken(refreshToken, environment.tokenHashSecret),
    hashIdentityRateKey("logout-token", refreshToken, environment.tokenHashSecret),
  ]);
  await consumeRateBuckets(ctx, nowMillis, "LOGOUT_RATE_LIMITED", [
    { bucketKey: tokenRateKey, limit: 10n, windowMillis: 60_000 },
  ]);
  await ctx.runMutation(anyApi.authSessions.revokeSessionByRefresh, {
    refreshTokenHash,
    now: nowMillis,
  });
  return jsonResponse({ revoked: true });
}

async function previewAccountDeletion(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const { environment, value: refreshToken } = readIdentityBody(
    "session", body, "refreshToken", 512,
  );
  const refreshTokenHash = await hashRefreshToken(
    refreshToken,
    environment.tokenHashSecret,
  );
  const result = await ctx.runQuery(anyApi.accountDeletion.preview, {
    refreshTokenHash,
    now: Date.now(),
  }) as AccountDeletionPreviewResult;
  if (!result.authorized) throw new IdentityError("REFRESH_TOKEN_INVALID", 401);
  return jsonResponse({ pots: result.pots });
}

async function deleteAccountNow(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const { environment: sessionEnvironment, value: refreshToken } = readIdentityBody(
    "session", body, "refreshToken", 512,
  );
  const requestId = stringField(body, "requestId", 64).toLowerCase();
  const originatingTimeZone = stringField(body, "originatingTimeZone", 128);
  if (!uuidV7Pattern.test(requestId) || !ios18TimeZoneIdentifiers.has(originatingTimeZone)) {
    throw new IdentityError("IDENTITY_INPUT_INVALID", 400);
  }
  const now = Date.now();
  const refreshTokenHash = await hashRefreshToken(
    refreshToken,
    sessionEnvironment.tokenHashSecret,
  );
  await ctx.runMutation(anyApi.accountDeletion.deleteExpiredReceipts, { now });
  const prior = await ctx.runQuery(anyApi.accountDeletion.receipt, {
    requestId,
    now,
  }) as DeletionBatchResult;
  if (prior.complete) return jsonResponse({ deleted: true });

  const started = await ctx.runMutation(anyApi.accountDeletion.begin, {
    refreshTokenHash,
    requestId,
    now,
  }) as AccountDeletionBeginResult;
  if (!started.authorized || !started.accountId || !started.appleSubjectHash) {
    throw new IdentityError("REFRESH_TOKEN_INVALID", 401);
  }
  if (started.authorization) {
    const identityEnvironment = readIdentityEnvironment(process.env);
    const appleRefreshToken = await decryptAppleRefreshToken(
      started.authorization,
      started.appleSubjectHash,
      identityEnvironment,
    );
    const clientSecret = await createAppleClientSecret(
      identityEnvironment,
      Math.floor(now / 1_000),
    );
    await revokeAppleRefreshToken(
      appleRefreshToken,
      clientSecret,
      identityEnvironment.appleClientId,
      fetch,
    );
    await ctx.runMutation(
      anyApi.accountDeletion.markAppleAuthorizationRevoked,
      { accountId: started.accountId, now },
    );
  }

  await runBatchUntilComplete(async () => {
    const redaction = await ctx.runMutation(
      anyApi.redaction.eraseAuthoredTextForAccount,
      { accountId: started.accountId },
    ) as { hasMore: boolean };
    return !redaction.hasMore;
  });

  await runBatchUntilComplete(async () => {
    const result = await ctx.runMutation(anyApi.accountDeletion.processNextPot, {
      accountId: started.accountId,
      transferEventId: generateUUIDv7(now),
      archiveEventId: generateUUIDv7(now),
      originatingTimeZone,
      now,
    }) as DeletionBatchResult;
    return result.complete;
  });

  let identityComplete = false;
  await runBatchUntilComplete(async () => {
    const result = await ctx.runMutation(anyApi.accountDeletion.eraseIdentityBatch, {
      accountId: started.accountId,
      requestId,
      now,
    }) as DeletionBatchResult;
    identityComplete = identityComplete || result.complete;
    return result.complete;
  });
  return jsonResponse({ deleted: identityComplete });
}

async function localE2EBootstrap(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  requireLocalE2EAuthTarget();
  const configuredSecret = process.env.NUMA_SHARED_E2E_BOOTSTRAP_SECRET;
  const presentedSecret = stringField(body, "bootstrapSecret", 512);
  if (
    !configuredSecret
    || configuredSecret.length < 32
    || !secureStringEqual(configuredSecret, presentedSecret)
  ) {
    throw new IdentityError("E2E_AUTH_REJECTED", 401);
  }
  const accountKey = stringField(body, "accountKey", 128);
  const environment = readSessionSigningEnvironment(process.env);
  await validateSessionSigningKey(environment);
  const refreshToken = generateOpaqueRefreshToken();
  const [refreshTokenHash, localSubjectHash] = await Promise.all([
    hashRefreshToken(refreshToken, environment.tokenHashSecret),
    hashLocalE2ESubject(accountKey, environment.tokenHashSecret),
  ]);
  const nowMillis = Date.now();
  const established = await ctx.runMutation(
    anyApi.authSessions.establishLocalE2ESession,
    {
      localSubjectHash,
      sessionId: crypto.randomUUID(),
      publicAccountIdCandidate: crypto.randomUUID(),
      refreshTokenHash,
      now: nowMillis,
      expiresAt: nowMillis + refreshSessionLifetimeMillis,
    },
  ) as EstablishResult;
  const access = await issueNumaAccessToken(
    {
      publicAccountId: established.publicAccountId,
      sessionId: established.sessionId,
    },
    environment,
    Math.floor(nowMillis / 1_000),
    crypto.randomUUID(),
    established.refreshExpiresAt,
  );
  return jsonResponse({
    accessToken: access.token,
    accessTokenExpiresInSeconds: access.expiresInSeconds,
    refreshToken,
    refreshExpiresAt: established.refreshExpiresAt,
    accountId: established.publicAccountId,
    e2e: true,
  });
}

async function safely(
  request: Request,
  operation: (body: Record<string, unknown>) => Promise<Response>,
): Promise<Response> {
  try {
    return await operation(await readJsonObject(request));
  } catch (error) {
    return identityErrorResponse(error);
  }
}

/**
 * Shared HTTP wrapper: resolve + apply the endpoint's trusted-source rate
 * policy and decode the JSON body once, per the options table above.
 */

type SourceRatePolicy = {
  environment: "identity" | "session";
  namespace: string;
  limit: bigint;
  errorCode: string;
};

async function guardedEndpoint(
  ctx: ActionCtx,
  request: Request,
  policy: SourceRatePolicy,
  operation: (ctx: ActionCtx, body: Record<string, unknown>, sourceIP: string) => Promise<Response>,
): Promise<Response> {
  try {
    requireApprovedWriteTarget();
    const environment = policy.environment === "identity"
      ? readIdentityEnvironment(process.env)
      : readSessionSigningEnvironment(process.env);
    const sourceIP = await trustedRequestSource(ctx, request);
    await consumeTrustedSourceRateLimit(
      ctx,
      sourceIP,
      environment.tokenHashSecret,
      policy.namespace,
      policy.limit,
      policy.errorCode,
      Date.now(),
    );
    return await operation(ctx, await readJsonObject(request), sourceIP);
  } catch (error) {
    return identityErrorResponse(error);
  }
}

// Per-endpoint HTTP surface as an options table: one shared wrapper wires up
// the trusted-source rate limit + JSON body parsing + error mapping.
// Per-endpoint trusted-source rate policies (one row per HTTP surface).
const endpointPolicies = {
  appleExchange: {
    environment: "identity",
    namespace: "apple-exchange-source",
    limit: 30n,
    errorCode: "APPLE_EXCHANGE_RATE_LIMITED",
  },
  appleNotification: {
    environment: "identity",
    namespace: "apple-notification-source",
    limit: 30n,
    errorCode: "APPLE_NOTIFICATION_RATE_LIMITED",
  },
  refresh: {
    environment: "session",
    namespace: "refresh-source",
    limit: 120n,
    errorCode: "REFRESH_RATE_LIMITED",
  },
  logout: {
    environment: "session",
    namespace: "logout-source",
    limit: 120n,
    errorCode: "LOGOUT_RATE_LIMITED",
  },
  accountDeletionPreview: {
    environment: "session",
    namespace: "account-deletion-preview-source",
    limit: 60n,
    errorCode: "ACCOUNT_DELETION_RATE_LIMITED",
  },
  deleteAccount: {
    environment: "session",
    namespace: "account-deletion-source",
    limit: 20n,
    errorCode: "ACCOUNT_DELETION_RATE_LIMITED",
  },
} satisfies Record<string, SourceRatePolicy>;

export const appleExchange = httpAction(async (ctx, request) =>
  await guardedEndpoint(ctx, request, endpointPolicies.appleExchange, exchangeApple));

export const appleNotification = httpAction(async (ctx, request) =>
  await guardedEndpoint(ctx, request, endpointPolicies.appleNotification, processAppleNotification));

export const refresh = httpAction(async (ctx, request) =>
  await guardedEndpoint(ctx, request, endpointPolicies.refresh, refreshSession));

export const logout = httpAction(async (ctx, request) =>
  await guardedEndpoint(ctx, request, endpointPolicies.logout, logoutSession));

export const accountDeletionPreview = httpAction(async (ctx, request) =>
  await guardedEndpoint(ctx, request, endpointPolicies.accountDeletionPreview, previewAccountDeletion));

export const deleteAccount = httpAction(async (ctx, request) =>
  await guardedEndpoint(ctx, request, endpointPolicies.deleteAccount, deleteAccountNow));

export const e2eBootstrap = httpAction(async (ctx, request) =>
  await safely(request, async (body) => await localE2EBootstrap(ctx, body)));

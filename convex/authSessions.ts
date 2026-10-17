import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  internalMutation,
} from "./_generated/server";
import { fail } from "./lib/access";
import {
  requireApprovedWriteTarget,
  requireLocalE2EAuthTarget,
} from "./lib/deployment";

const encryptedAppleRefreshValidator = v.object({
  encryptedRefreshToken: v.string(),
  encryptionNonce: v.string(),
  encryptionKeyVersion: v.string(),
});

const maximumActiveSessionsPerAccount = 20;

function requireBoundedString(value: string, minimum: number, maximum: number): void {
  if (value.length < minimum || value.length > maximum) fail("IDENTITY_INPUT_INVALID");
}

async function requireSessionCapacity(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  now: number,
): Promise<void> {
  const activeSessions = await ctx.db
    .query("sessions")
    .withIndex("by_account", (index) => index.eq("accountId", accountId))
    .filter((query) => query.and(
      query.eq(query.field("revokedAt"), undefined),
      query.gt(query.field("expiresAt"), now),
    ))
    .take(maximumActiveSessionsPerAccount);
  if (activeSessions.length >= maximumActiveSessionsPerAccount) {
    fail("SESSION_LIMIT_REACHED");
  }
}

type EstablishAccountInput = {
  account: Doc<"accounts"> | null;
  publicAccountIdCandidate: string;
  subjectHash: string;
  relayEmail?: string;
  now: number;
  sessionId: string;
  refreshTokenHash: string;
  expiresAt: number;
};

/** Resolves (or creates) the account, then enforces capacity and inserts the session. */
async function establishAccountWithSession(
  ctx: MutationCtx,
  input: EstablishAccountInput,
): Promise<Doc<"accounts">> {
  let account = input.account;
  if (!account) {
    const duplicatePublicId = await ctx.db
      .query("accounts")
      .withIndex("by_public_account_id", (index) =>
        index.eq("publicAccountId", input.publicAccountIdCandidate),
      )
      .unique();
    if (duplicatePublicId) fail("SESSION_IDENTIFIER_CONFLICT");
    const accountId = await ctx.db.insert("accounts", {
      publicAccountId: input.publicAccountIdCandidate,
      appleSubjectHash: input.subjectHash,
      ...(input.relayEmail !== undefined ? { relayEmail: input.relayEmail } : {}),
      createdAt: input.now,
    });
    account = await ctx.db.get(accountId);
    if (!account) fail("ACCOUNT_CREATE_FAILED");
  } else if (input.relayEmail !== undefined && account.relayEmail !== input.relayEmail) {
    await ctx.db.patch(account._id, { relayEmail: input.relayEmail });
  }

  await requireSessionCapacity(ctx, account._id, input.now);

  await ctx.db.insert("sessions", {
    sessionId: input.sessionId,
    accountId: account._id,
    refreshTokenHash: input.refreshTokenHash,
    expiresAt: input.expiresAt,
    createdAt: input.now,
    rotatedAt: input.now,
  });
  return account;
}

async function requireSessionIdentifiersUnique(
  ctx: MutationCtx,
  identifiers: { sessionId: string; refreshTokenHash: string },
): Promise<void> {
  const duplicateSession = await ctx.db
    .query("sessions")
    .withIndex("by_session_id", (index) => index.eq("sessionId", identifiers.sessionId))
    .unique();
  const duplicateRefresh = await ctx.db
    .query("sessions")
    .withIndex("by_refresh_token_hash", (index) =>
      index.eq("refreshTokenHash", identifiers.refreshTokenHash),
    )
    .unique();
  const duplicateHistoricalRefresh = await ctx.db
    .query("refreshTokenHistory")
    .withIndex("by_token_hash", (index) =>
      index.eq("tokenHash", identifiers.refreshTokenHash),
    )
    .unique();
  if (duplicateSession || duplicateRefresh || duplicateHistoricalRefresh) {
    fail("SESSION_IDENTIFIER_CONFLICT");
  }
}

type EstablishInput = {
  subjectHash: string;
  relayEmail?: string;
  encryptedAppleRefresh?: {
    encryptedRefreshToken: string;
    encryptionNonce: string;
    encryptionKeyVersion: string;
  };
  sessionId: string;
  publicAccountIdCandidate: string;
  refreshTokenHash: string;
  now: number;
  expiresAt: number;
  requireAppleAuthorization: boolean;
};

/**
 * Shared session establishment. requireAppleAuthorization gates the Apple account
 * path; the local E2E bootstrap passes false because no Apple authorization exists.
 */
async function establish(ctx: MutationCtx, args: EstablishInput): Promise<{
  publicAccountId: string;
  sessionId: string;
  refreshExpiresAt: number;
}> {
    requireApprovedWriteTarget();
    requireBoundedString(args.subjectHash, 32, 128);
    requireBoundedString(args.sessionId, 16, 128);
    requireBoundedString(args.publicAccountIdCandidate, 16, 128);
    requireBoundedString(args.refreshTokenHash, 32, 128);
    if (
      !Number.isSafeInteger(args.now)
      || !Number.isSafeInteger(args.expiresAt)
      || args.expiresAt <= args.now
    ) {
      fail("IDENTITY_INPUT_INVALID");
    }
    if (args.relayEmail !== undefined) {
      requireBoundedString(args.relayEmail, 3, 254);
      if (!args.relayEmail.includes("@")) fail("IDENTITY_INPUT_INVALID");
    }
    if (args.encryptedAppleRefresh !== undefined) {
      requireBoundedString(args.encryptedAppleRefresh.encryptedRefreshToken, 16, 8_192);
      requireBoundedString(args.encryptedAppleRefresh.encryptionNonce, 16, 128);
      requireBoundedString(args.encryptedAppleRefresh.encryptionKeyVersion, 1, 64);
    }

    await requireSessionIdentifiersUnique(ctx, {
      sessionId: args.sessionId,
      refreshTokenHash: args.refreshTokenHash,
    });

    let account = await ctx.db
      .query("accounts")
      .withIndex("by_apple_subject_hash", (index) =>
        index.eq("appleSubjectHash", args.subjectHash),
      )
      .unique();
    let authorization = account
      ? await ctx.db
        .query("appleAuthorizations")
        .withIndex("by_account", (index) => index.eq("accountId", account!._id))
        .unique()
      : null;
    if (account?.deletionStartedAt !== undefined) {
      fail("ACCOUNT_DELETION_IN_PROGRESS");
    }
    if (args.requireAppleAuthorization === true
      && (!account || !authorization || authorization.revokedAt !== undefined)
      && args.encryptedAppleRefresh === undefined) {
      fail("APPLE_REFRESH_TOKEN_REQUIRED");
    }

    account = await establishAccountWithSession(ctx, {
      account,
      publicAccountIdCandidate: args.publicAccountIdCandidate,
      subjectHash: args.subjectHash,
      relayEmail: args.relayEmail,
      now: args.now,
      sessionId: args.sessionId,
      refreshTokenHash: args.refreshTokenHash,
      expiresAt: args.expiresAt,
    });

    if (args.encryptedAppleRefresh !== undefined) {
      if (authorization) {
        await ctx.db.patch(authorization._id, {
          ...args.encryptedAppleRefresh,
          updatedAt: args.now,
          authorizedAt: args.now,
          revokedAt: undefined,
        });
      } else {
        await ctx.db.insert("appleAuthorizations", {
          accountId: account._id,
          ...args.encryptedAppleRefresh,
          createdAt: args.now,
          updatedAt: args.now,
          authorizedAt: args.now,
        });
      }
    }
    return {
      publicAccountId: account.publicAccountId,
      sessionId: args.sessionId,
      refreshExpiresAt: args.expiresAt,
    };
}

export const establishSession = internalMutation({
  args: {
    appleSubjectHash: v.string(),
    relayEmail: v.optional(v.string()),
    encryptedAppleRefresh: v.optional(encryptedAppleRefreshValidator),
    sessionId: v.string(),
    publicAccountIdCandidate: v.string(),
    refreshTokenHash: v.string(),
    now: v.number(),
    expiresAt: v.number(),
  },
  handler: (ctx: MutationCtx, args): Promise<{
    publicAccountId: string;
    sessionId: string;
    refreshExpiresAt: number;
  }> => establish(ctx, {
    subjectHash: args.appleSubjectHash,
    relayEmail: args.relayEmail,
    encryptedAppleRefresh: args.encryptedAppleRefresh,
    sessionId: args.sessionId,
    publicAccountIdCandidate: args.publicAccountIdCandidate,
    refreshTokenHash: args.refreshTokenHash,
    now: args.now,
    expiresAt: args.expiresAt,
    requireAppleAuthorization: true,
  }),
});

/** A Google account: no Apple authorization to keep, so nothing to revoke at deletion. */
export const establishGoogleSession = internalMutation({
  args: {
    googleSubjectHash: v.string(),
    sessionId: v.string(),
    publicAccountIdCandidate: v.string(),
    refreshTokenHash: v.string(),
    now: v.number(),
    expiresAt: v.number(),
  },
  handler: (ctx: MutationCtx, args): Promise<{
    publicAccountId: string;
    sessionId: string;
    refreshExpiresAt: number;
  }> => establish(ctx, {
    subjectHash: args.googleSubjectHash,
    relayEmail: undefined,
    encryptedAppleRefresh: undefined,
    sessionId: args.sessionId,
    publicAccountIdCandidate: args.publicAccountIdCandidate,
    refreshTokenHash: args.refreshTokenHash,
    now: args.now,
    expiresAt: args.expiresAt,
    requireAppleAuthorization: false,
  }),
});

export const establishLocalE2ESession = internalMutation({
  args: {
    localSubjectHash: v.string(),
    sessionId: v.string(),
    publicAccountIdCandidate: v.string(),
    refreshTokenHash: v.string(),
    now: v.number(),
    expiresAt: v.number(),
  },
  handler: (ctx: MutationCtx, args): Promise<{
    publicAccountId: string;
    sessionId: string;
    refreshExpiresAt: number;
  }> => establish(ctx, {
    subjectHash: args.localSubjectHash,
    relayEmail: undefined,
    encryptedAppleRefresh: undefined,
    sessionId: args.sessionId,
    publicAccountIdCandidate: args.publicAccountIdCandidate,
    refreshTokenHash: args.refreshTokenHash,
    now: args.now,
    expiresAt: args.expiresAt,
    requireAppleAuthorization: false,
  }),
});

export const rotateSession = internalMutation({
  args: {
    refreshTokenHash: v.string(),
    replacementRefreshTokenHash: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    requireBoundedString(args.refreshTokenHash, 32, 128);
    requireBoundedString(args.replacementRefreshTokenHash, 32, 128);
    if (!Number.isSafeInteger(args.now)) fail("IDENTITY_INPUT_INVALID");
    if (args.refreshTokenHash === args.replacementRefreshTokenHash) {
      fail("IDENTITY_INPUT_INVALID");
    }

    const priorUse = await ctx.db
      .query("refreshTokenHistory")
      .withIndex("by_token_hash", (index) => index.eq("tokenHash", args.refreshTokenHash))
      .unique();
    if (priorUse) {
      const replayedSession = await ctx.db
        .query("sessions")
        .withIndex("by_session_id", (index) =>
          index.eq("sessionId", priorUse.sessionId),
        )
        .unique();
      if (replayedSession && replayedSession.revokedAt === undefined) {
        await ctx.db.patch(replayedSession._id, { revokedAt: args.now });
      }
      return { status: "reused" as const };
    }

    const session = await ctx.db
      .query("sessions")
      .withIndex("by_refresh_token_hash", (index) =>
        index.eq("refreshTokenHash", args.refreshTokenHash),
      )
      .unique();
    if (!session) return { status: "invalid" as const };
    if (session.revokedAt !== undefined) return { status: "revoked" as const };
    if (session.expiresAt <= args.now) {
      await ctx.db.patch(session._id, { revokedAt: args.now });
      return { status: "expired" as const };
    }
    if (args.now < session.rotatedAt) fail("IDENTITY_INPUT_INVALID");
    const account = await ctx.db.get(session.accountId);
    if (!account || account.deletionStartedAt !== undefined) {
      return { status: "invalid" as const };
    }
    const duplicateReplacement = await ctx.db
      .query("sessions")
      .withIndex("by_refresh_token_hash", (index) =>
        index.eq("refreshTokenHash", args.replacementRefreshTokenHash),
      )
      .unique();
    const duplicateHistoricalReplacement = await ctx.db
      .query("refreshTokenHistory")
      .withIndex("by_token_hash", (index) =>
        index.eq("tokenHash", args.replacementRefreshTokenHash),
      )
      .unique();
    if (duplicateReplacement || duplicateHistoricalReplacement) {
      fail("SESSION_IDENTIFIER_CONFLICT");
    }

    await ctx.db.insert("refreshTokenHistory", {
      tokenHash: args.refreshTokenHash,
      sessionId: session.sessionId,
      accountId: session.accountId,
      rotatedAt: args.now,
      expiresAt: session.expiresAt,
    });
    await ctx.db.patch(session._id, {
      refreshTokenHash: args.replacementRefreshTokenHash,
      rotatedAt: args.now,
    });
    return {
      status: "rotated" as const,
      publicAccountId: account.publicAccountId,
      sessionId: session.sessionId,
      refreshExpiresAt: session.expiresAt,
    };
  },
});

export const revokeSessionByRefresh = internalMutation({
  args: {
    refreshTokenHash: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    requireBoundedString(args.refreshTokenHash, 32, 128);
    if (!Number.isSafeInteger(args.now)) fail("IDENTITY_INPUT_INVALID");
    let session = await ctx.db
      .query("sessions")
      .withIndex("by_refresh_token_hash", (index) =>
        index.eq("refreshTokenHash", args.refreshTokenHash),
      )
      .unique();
    if (!session) {
      const priorUse = await ctx.db
        .query("refreshTokenHistory")
        .withIndex("by_token_hash", (index) =>
          index.eq("tokenHash", args.refreshTokenHash),
        )
        .unique();
      if (priorUse) {
        session = await ctx.db
          .query("sessions")
          .withIndex("by_session_id", (index) =>
            index.eq("sessionId", priorUse.sessionId),
          )
          .unique();
      }
    }
    if (session && session.revokedAt === undefined) {
      await ctx.db.patch(session._id, { revokedAt: args.now });
    }
    return { revoked: session !== null };
  },
});

export const revokeAccountSessions = internalMutation({
  args: {
    accountId: v.id("accounts"),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_account", (index) => index.eq("accountId", args.accountId))
      .filter((query) => query.eq(query.field("revokedAt"), undefined))
      .take(100);
    let revokedCount = 0;
    for (const session of sessions) {
      if (session.revokedAt === undefined) {
        await ctx.db.patch(session._id, { revokedAt: args.now });
        revokedCount += 1;
      }
    }
    return { revokedCount, hasMore: sessions.length === 100 };
  },
});

export const markAppleAuthorizationRevoked = internalMutation({
  args: {
    accountId: v.id("accounts"),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const authorization = await ctx.db
      .query("appleAuthorizations")
      .withIndex("by_account", (index) => index.eq("accountId", args.accountId))
      .unique();
    if (authorization && authorization.revokedAt === undefined) {
      await ctx.db.patch(authorization._id, { revokedAt: args.now });
    }
    return { revoked: authorization !== null };
  },
});

export const processAppleIdentityNotification = internalMutation({
  args: {
    notificationEventId: v.string(),
    jwtId: v.string(),
    eventType: v.string(),
    appleSubjectHash: v.string(),
    eventTime: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    requireBoundedString(args.notificationEventId, 1, 320);
    requireBoundedString(args.jwtId, 1, 255);
    requireBoundedString(args.eventType, 1, 64);
    requireBoundedString(args.appleSubjectHash, 32, 128);
    const eventTimeMillis = args.eventTime * 1_000;
    if (
      !Number.isSafeInteger(args.eventTime)
      || !Number.isSafeInteger(eventTimeMillis)
      || !Number.isSafeInteger(args.now)
    ) {
      fail("IDENTITY_INPUT_INVALID");
    }
    const revokesAuthorization =
      args.eventType === "consent-revoked" || args.eventType === "account-delete";

    const duplicate = await ctx.db
      .query("appleIdentityNotifications")
      .withIndex("by_notification_event_id", (index) =>
        index.eq("notificationEventId", args.notificationEventId),
      )
      .unique();
    if (duplicate) {
      return {
        duplicate: true,
        accountId: duplicate.accountId,
        revokedSessionCount: 0,
      };
    }

    const account = await ctx.db
      .query("accounts")
      .withIndex("by_apple_subject_hash", (index) =>
        index.eq("appleSubjectHash", args.appleSubjectHash),
      )
      .unique();
    let revokedSessionCount = 0;
    if (account && revokesAuthorization) {
      const authorization = await ctx.db
        .query("appleAuthorizations")
        .withIndex("by_account", (index) => index.eq("accountId", account._id))
        .unique();
      const authorizationEpoch = authorization?.authorizedAt
        ?? authorization?.updatedAt
        ?? authorization?.createdAt;
      const appliesToCurrentAuthorization = authorizationEpoch !== undefined
        && eventTimeMillis >= authorizationEpoch;
      if (
        appliesToCurrentAuthorization
        && authorization
        && authorization.revokedAt === undefined
      ) {
        await ctx.db.patch(authorization._id, { revokedAt: args.now });
      }
      if (appliesToCurrentAuthorization) {
        const sessions = await ctx.db
          .query("sessions")
          .withIndex("by_account", (index) => index.eq("accountId", account._id))
          .filter((query) => query.and(
            query.eq(query.field("revokedAt"), undefined),
            query.gt(query.field("expiresAt"), args.now),
          ))
          .take(maximumActiveSessionsPerAccount + 1);
        if (sessions.length > maximumActiveSessionsPerAccount) {
          fail("SESSION_LIMIT_INVARIANT_BROKEN");
        }
        for (const session of sessions) {
          await ctx.db.patch(session._id, { revokedAt: args.now });
          revokedSessionCount += 1;
        }
      }
    }
    await ctx.db.insert("appleIdentityNotifications", {
      notificationEventId: args.notificationEventId,
      jwtId: args.jwtId,
      eventType: args.eventType,
      appleSubjectHash: args.appleSubjectHash,
      accountId: account?._id,
      eventTime: args.eventTime,
      processedAt: args.now,
    });
    return {
      duplicate: false,
      accountId: account?._id,
      revokedSessionCount,
    };
  },
});

export const deleteExpiredRefreshHistory = internalMutation({
  args: { now: v.number() },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    if (!Number.isSafeInteger(args.now)) fail("IDENTITY_INPUT_INVALID");
    const expired = await ctx.db
      .query("refreshTokenHistory")
      .withIndex("by_expires_at", (index) => index.lte("expiresAt", args.now))
      .take(100);
    for (const row of expired) await ctx.db.delete(row._id);
    return { deletedCount: expired.length, hasMore: expired.length === 100 };
  },
});

export const consumeIdentityRateLimits = internalMutation({
  args: {
    buckets: v.array(v.object({
      bucketKey: v.string(),
      limit: v.int64(),
      windowMillis: v.number(),
    })),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    if (
      !Number.isSafeInteger(args.now)
      || args.buckets.length < 1
      || args.buckets.length > 4
    ) {
      fail("IDENTITY_INPUT_INVALID");
    }
    const seen = new Set<string>();
    const existing: Array<Doc<"identityRateLimits"> | null> = [];
    for (const bucket of args.buckets) {
      requireBoundedString(bucket.bucketKey, 32, 128);
      if (
        seen.has(bucket.bucketKey)
        || bucket.limit < 1n
        || bucket.limit > 10_000n
        || !Number.isSafeInteger(bucket.windowMillis)
        || bucket.windowMillis < 1_000
        || bucket.windowMillis > 86_400_000
      ) {
        fail("IDENTITY_INPUT_INVALID");
      }
      seen.add(bucket.bucketKey);
      existing.push(await ctx.db
        .query("identityRateLimits")
        .withIndex("by_bucket_key", (index) =>
          index.eq("bucketKey", bucket.bucketKey),
        )
        .unique());
    }

    const retryAfterMillis = args.buckets.reduce((longestRetry, bucket, index) => {
      const row = existing[index];
      if (row && row.expiresAt > args.now && row.count >= bucket.limit) {
        return Math.max(longestRetry, row.expiresAt - args.now);
      }
      return longestRetry;
    }, 0);
    if (retryAfterMillis > 0) return { allowed: false, retryAfterMillis };

    for (let index = 0; index < args.buckets.length; index += 1) {
      const bucket = args.buckets[index];
      const row = existing[index];
      if (row && row.expiresAt > args.now) {
        await ctx.db.patch(row._id, { count: row.count + 1n });
      } else if (row) {
        await ctx.db.patch(row._id, {
          windowStartedAt: args.now,
          count: 1n,
          expiresAt: args.now + bucket.windowMillis,
        });
      } else {
        await ctx.db.insert("identityRateLimits", {
          bucketKey: bucket.bucketKey,
          windowStartedAt: args.now,
          count: 1n,
          expiresAt: args.now + bucket.windowMillis,
        });
      }
    }
    return { allowed: true, retryAfterMillis: 0 };
  },
});

export const deleteExpiredIdentityRateLimits = internalMutation({
  args: { now: v.number() },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    if (!Number.isSafeInteger(args.now)) fail("IDENTITY_INPUT_INVALID");
    const expired = await ctx.db
      .query("identityRateLimits")
      .withIndex("by_expires_at", (index) => index.lte("expiresAt", args.now))
      .take(100);
    for (const row of expired) await ctx.db.delete(row._id);
    return { deletedCount: expired.length, hasMore: expired.length === 100 };
  },
});

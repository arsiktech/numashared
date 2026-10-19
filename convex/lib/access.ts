import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

declare const process: { env: Record<string, string | undefined> };

type AccessContext = QueryCtx | MutationCtx;

export function fail(code: string, retryable = false): never {
  throw new ConvexError({ code, retryable });
}

export async function requireSession(ctx: AccessContext): Promise<{
  account: Doc<"accounts">;
  session: Doc<"sessions">;
}> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) fail("AUTH_REQUIRED");
  const expectedIssuer = process.env.NUMA_SHARED_SESSION_ISSUER;
  if (!expectedIssuer || identity.issuer !== expectedIssuer) fail("AUTH_ISSUER_REJECTED");
  const expectedAudience = process.env.NUMA_SHARED_SESSION_AUDIENCE;
  if (
    !expectedAudience
    || identity.numa_session_audience !== expectedAudience
  ) fail("AUTH_AUDIENCE_REJECTED");
  if (identity.token_use !== "access") fail("AUTH_TOKEN_USE_REJECTED");
  const sessionId = identity.sid;
  if (typeof sessionId !== "string" || sessionId.length < 16) fail("AUTH_SESSION_REQUIRED");

  const session = await ctx.db
    .query("sessions")
    .withIndex("by_session_id", (query) => query.eq("sessionId", sessionId))
    .unique();
  if (!session || session.revokedAt !== undefined || session.expiresAt <= Date.now()) {
    fail("AUTH_SESSION_REVOKED");
  }
  const account = await ctx.db.get(session.accountId);
  if (
    !account
    || account.publicAccountId !== identity.subject
    || account.deletionStartedAt !== undefined
  ) fail("AUTH_SESSION_REVOKED");
  const appleAuthorization = await ctx.db
    .query("appleAuthorizations")
    .withIndex("by_account", (query) => query.eq("accountId", account._id))
    .unique();
  if (appleAuthorization?.revokedAt !== undefined) fail("AUTH_SESSION_REVOKED");
  return { account, session };
}

export async function requireActiveMembership(
  ctx: AccessContext,
  potId: string,
  accountId: Id<"accounts">,
): Promise<Doc<"potMembers">> {
  const membership = await ctx.db
    .query("potMembers")
    .withIndex("by_pot_account", (query) =>
      query.eq("potId", potId).eq("accountId", accountId),
    )
    .unique();
  if (!membership) fail("NOT_MEMBER");
  if (membership.status !== "active") fail("MEMBERSHIP_ARCHIVED");
  const pot = await ctx.db
    .query("pots")
    .withIndex("by_pot_id", (query) => query.eq("potId", potId))
    .unique();
  if (pot?.deletingAt !== undefined) fail("POT_DELETING");
  return membership;
}

export async function requireReadableMembership(
  ctx: AccessContext,
  potId: string,
  accountId: Id<"accounts">,
): Promise<Doc<"potMembers">> {
  const membership = await ctx.db
    .query("potMembers")
    .withIndex("by_pot_account", (query) =>
      query.eq("potId", potId).eq("accountId", accountId),
    )
    .unique();
  if (!membership) fail("NOT_MEMBER");
  if (membership.status === "archived" && membership.archivedAtSequence === undefined) {
    fail("MEMBERSHIP_ARCHIVED");
  }
  return membership;
}

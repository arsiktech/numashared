import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fail } from "./access";

export const eventWriteLimitPerHour = 2_000n;
export const potCreateLimitPerDay = 20n;
export const inviteIssueLimitPerDay = 100n;
export const maximumActivePotsPerAccount = 100;

type AccountWriteScope = "event" | "potCreate" | "inviteIssue";

export async function consumeAccountWriteQuota(
  ctx: MutationCtx,
  args: {
    accountId: Id<"accounts">;
    scope: AccountWriteScope;
    amount: bigint;
    limit: bigint;
    windowMillis: number;
    now: number;
  },
): Promise<void> {
  if (
    args.amount < 1n
    || args.amount > args.limit
    || !Number.isSafeInteger(args.now)
    || !Number.isSafeInteger(args.windowMillis)
    || args.windowMillis < 1_000
  ) {
    fail("WRITE_QUOTA_INPUT_INVALID");
  }
  const existing = await ctx.db
    .query("accountWriteQuotas")
    .withIndex("by_account_scope", (index) =>
      index.eq("accountId", args.accountId).eq("scope", args.scope),
    )
    .unique();
  if (existing && existing.expiresAt > args.now) {
    if (existing.count + args.amount > args.limit) {
      fail("ACCOUNT_WRITE_RATE_LIMITED", true);
    }
    await ctx.db.patch(existing._id, { count: existing.count + args.amount });
    return;
  }
  const expiresAt = args.now + args.windowMillis;
  if (!Number.isSafeInteger(expiresAt)) fail("WRITE_QUOTA_INPUT_INVALID");
  if (existing) {
    await ctx.db.patch(existing._id, {
      windowStartedAt: args.now,
      count: args.amount,
      expiresAt,
    });
  } else {
    await ctx.db.insert("accountWriteQuotas", {
      accountId: args.accountId,
      scope: args.scope,
      windowStartedAt: args.now,
      count: args.amount,
      expiresAt,
    });
  }
}

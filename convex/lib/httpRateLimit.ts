import { anyApi } from "convex/server";

import type { ActionCtx } from "../_generated/server";
import { hashIdentityRateKey, IdentityError } from "./identity";

declare const process: { env: Record<string, string | undefined> };

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMillis: number;
}

export type PrivacySafeRateLimitPolicy = {
  namespace: string;
  value: string;
  limit: bigint;
  windowMillis: number;
};

export async function trustedRequestSource(
  ctx: ActionCtx,
  request: Request,
): Promise<string> {
  try {
    const metadata = await ctx.meta.getRequestMetadata();
    if (metadata.ip) return metadata.ip;
  } catch {
    // convex-test does not currently implement request metadata. The fallback
    // is restricted to disposable anonymous-local deployments; production
    // fails closed rather than collapsing users into one exhaustible bucket.
  }
  if (process.env.NUMA_SHARED_DEPLOYMENT_CLASS === "anonymous-local") {
    const testSource = request.headers.get("x-numa-shared-test-source");
    if (testSource && /^[A-Za-z0-9._-]{1,64}$/.test(testSource)) {
      return `anonymous-local:${testSource}`;
    }
    return "anonymous-local-request-source";
  }
  throw new IdentityError("REQUEST_SOURCE_UNAVAILABLE", 503);
}

export async function consumePrivacySafeRateLimits(
  ctx: ActionCtx,
  tokenHashSecret: string,
  policies: readonly PrivacySafeRateLimitPolicy[],
  nowMillis: number,
): Promise<RateLimitResult> {
  const buckets = await Promise.all(policies.map(async (policy) => ({
    bucketKey: await hashIdentityRateKey(
      policy.namespace,
      policy.value,
      tokenHashSecret,
    ),
    limit: policy.limit,
    windowMillis: policy.windowMillis,
  })));
  await ctx.runMutation(anyApi.authSessions.deleteExpiredIdentityRateLimits, {
    now: nowMillis,
  });
  return await ctx.runMutation(anyApi.authSessions.consumeIdentityRateLimits, {
    buckets,
    now: nowMillis,
  }) as RateLimitResult;
}

export async function consumeTrustedSourceRateLimit(
  ctx: ActionCtx,
  sourceIP: string,
  tokenHashSecret: string,
  namespace: string,
  limit: bigint,
  errorCode: string,
  nowMillis: number,
): Promise<void> {
  const rateLimit = await consumePrivacySafeRateLimits(
    ctx,
    tokenHashSecret,
    [{ namespace, value: sourceIP, limit, windowMillis: 60_000 }],
    nowMillis,
  );
  if (!rateLimit.allowed) throw new IdentityError(errorCode, 429);
}

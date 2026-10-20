"use node";

import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, type ActionCtx } from "./_generated/server";
import {
  buildApnsRequest,
  classifyApnsResponse,
  createProviderTokenSource,
  readApnsConfiguration,
  sendApnsBatch,
  type ApnsRequest,
} from "./lib/apnsTransport";
import { requireApprovedWriteTarget } from "./lib/deployment";
import { composeBatchMessages } from "./lib/notificationMatrix";
import type { EventPushPlan } from "./notifications";

const providerTokenSource = createProviderTokenSource();

type DeliveryResult = {
  attempted: number;
  sent: number;
  rejected: number;
  removed: number;
};

type PushTargets = {
  body: string | null;
  tokens: Array<{
    deviceToken: string;
    environment: "sandbox" | "production";
  }>;
};

async function sendMessages(
  ctx: ActionCtx,
  potId: string,
  messages: ReadonlyArray<{
    deviceToken: string;
    environment: "sandbox" | "production";
    body: string;
  }>,
): Promise<DeliveryResult> {
  if (messages.length === 0) return { attempted: 0, sent: 0, rejected: 0, removed: 0 };
  const configuration = readApnsConfiguration();
  const providerToken = providerTokenSource(configuration);
  const requests: ApnsRequest[] = messages.map((message) => buildApnsRequest({
    configuration,
    providerToken,
    deviceToken: message.deviceToken,
    environment: message.environment,
    body: message.body,
    potId,
  }));
  let responses;
  try {
    responses = await sendApnsBatch(requests);
  } catch {
    throw new Error("APNS_TRANSPORT_FAILED");
  }

  let sent = 0;
  let rejected = 0;
  let removed = 0;
  for (const response of responses) {
    const classification = classifyApnsResponse(response.status, response.body);
    if (classification.kind === "success") {
      sent += 1;
      continue;
    }
    rejected += 1;
    if (classification.kind !== "unregistered") continue;
    const result = await ctx.runMutation(internal.notifications.dropPushToken, {
      deviceToken: response.deviceToken,
      invalidatedAtMillis: classification.invalidatedAtMillis,
    });
    if (result.removed) removed += 1;
  }
  return { attempted: requests.length, sent, rejected, removed };
}

// Single-event delivery. New events go through pushQueue + deliverBatchPush; this stays
// so pushes already scheduled before that change still run.
export const deliverEventPush = internalAction({
  args: { potId: v.string(), eventId: v.string() },
  handler: async (ctx, args): Promise<DeliveryResult> => {
    requireApprovedWriteTarget();
    const targets: PushTargets = await ctx.runQuery(
      internal.notifications.pushTargets,
      args,
    );
    const body = targets.body;
    if (!body || targets.tokens.length === 0) {
      return { attempted: 0, sent: 0, rejected: 0, removed: 0 };
    }
    return await sendMessages(
      ctx,
      args.potId,
      targets.tokens.map((token) => ({ ...token, body })),
    );
  },
});

const batchPlanPageSize = 100;

// Coalesced delivery for one pot's queued events: at most one balance message and one
// "needs your choice" message per person, whatever the batch size.
export const deliverBatchPush = internalAction({
  args: { potId: v.string(), eventIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<DeliveryResult> => {
    requireApprovedWriteTarget();
    let potName: string | null = null;
    const plans: EventPushPlan[] = [];
    for (let start = 0; start < args.eventIds.length; start += batchPlanPageSize) {
      const page: { potName: string | null; plans: EventPushPlan[] } = await ctx.runQuery(
        internal.notifications.batchPushPlan,
        { potId: args.potId, eventIds: args.eventIds.slice(start, start + batchPlanPageSize) },
      );
      if (page.potName === null) return { attempted: 0, sent: 0, rejected: 0, removed: 0 };
      potName = page.potName;
      plans.push(...page.plans);
    }
    if (potName === null || plans.length === 0) {
      return { attempted: 0, sent: 0, rejected: 0, removed: 0 };
    }
    const messages = composeBatchMessages(potName, plans);
    const accountIds = [...new Set(messages.map((message) => message.accountId))];
    const tokens: Array<{
      accountId: Id<"accounts">;
      deviceToken: string;
      environment: "sandbox" | "production";
    }> = await ctx.runQuery(internal.notifications.pushTokensForAccounts, { accountIds });
    return await sendMessages(
      ctx,
      args.potId,
      messages.flatMap((message) => tokens
        .filter((token) => token.accountId === message.accountId)
        .map((token) => ({
          deviceToken: token.deviceToken,
          environment: token.environment,
          body: message.body,
        }))),
    );
  },
});

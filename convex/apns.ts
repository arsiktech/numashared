"use node";

import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import {
  buildApnsRequest,
  classifyApnsResponse,
  createProviderTokenSource,
  readApnsConfiguration,
  sendApnsBatch,
  type ApnsRequest,
} from "./lib/apnsTransport";
import { requireApprovedWriteTarget } from "./lib/deployment";

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

    const configuration = readApnsConfiguration();
    const providerToken = providerTokenSource(configuration);
    const requests: ApnsRequest[] = targets.tokens.map((token) => buildApnsRequest({
      configuration,
      providerToken,
      deviceToken: token.deviceToken,
      environment: token.environment,
      body,
      potId: args.potId,
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
  },
});

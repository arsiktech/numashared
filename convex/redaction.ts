import { v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { eraseAuthoredTextBatch } from "./lib/redactText";
import { requireApprovedWriteTarget } from "./lib/deployment";

/**
 * Account deletion invokes this internal-only bounded step until `hasMore` is
 * false, then removes the account identity. It is deliberately not callable
 * by an authenticated client as an independent history-editing operation.
 */
export const eraseAuthoredTextForAccount = internalMutation({
  args: {
    accountId: v.id("accounts"),
  },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    return await eraseAuthoredTextBatch(ctx, args.accountId);
  },
});

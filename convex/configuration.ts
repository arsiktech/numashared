import { v } from "convex/values";

import { internalMutation, query } from "./_generated/server";
import { fail } from "./lib/access";
import { requireApprovedWriteTarget } from "./lib/deployment";

export const current = query({
  args: {},
  handler: async (ctx) => {
    const configuration = await ctx.db
      .query("appConfiguration")
      .withIndex("by_key", (index) => index.eq("key", "global"))
      .unique();
    return {
      minimumSupportedBuild: configuration?.minimumSupportedBuild ?? null,
    };
  },
});

export const setMinimumSupportedBuild = internalMutation({
  args: { minimumSupportedBuild: v.number(), now: v.number() },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    if (
      !Number.isSafeInteger(args.minimumSupportedBuild)
      || args.minimumSupportedBuild < 1
      || !Number.isSafeInteger(args.now)
      || args.now < 0
    ) fail("APP_CONFIGURATION_INVALID");
    const existing = await ctx.db
      .query("appConfiguration")
      .withIndex("by_key", (index) => index.eq("key", "global"))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        minimumSupportedBuild: args.minimumSupportedBuild,
        updatedAt: args.now,
      });
    } else {
      await ctx.db.insert("appConfiguration", {
        key: "global",
        minimumSupportedBuild: args.minimumSupportedBuild,
        updatedAt: args.now,
      });
    }
    return { minimumSupportedBuild: args.minimumSupportedBuild };
  },
});

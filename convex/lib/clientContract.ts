import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Swift build 11 is still in production. Its reader accepts only the original text manifests
 * (no expense note, no edit reason, no repayment method or note) and budget groups of one or two
 * people; anything else stops sync for that member. The Expo app (build 12 and later) writes the
 * wider contract, so the server accepts it only once production stops serving build 11, that is
 * once `appConfiguration.minimumSupportedBuild` is at least this build.
 */
export const extendedContractMinimumBuild = 12;

/** The group size every reader understands. */
export const legacyMaximumBudgetGroupSize = 2;

export type ClientContract = {
  /** Expense notes, edit reasons, repayment method and note. */
  extendedText: boolean;
  /** Largest budget group a new or changed group may have. */
  maximumBudgetGroupSize: number;
};

export const legacyClientContract: ClientContract = {
  extendedText: false,
  maximumBudgetGroupSize: legacyMaximumBudgetGroupSize,
};

export function clientContractFor(minimumSupportedBuild: number | null | undefined): ClientContract {
  if (minimumSupportedBuild == null || minimumSupportedBuild < extendedContractMinimumBuild) {
    return legacyClientContract;
  }
  return { extendedText: true, maximumBudgetGroupSize: 6 };
}

export async function loadClientContract(ctx: QueryCtx | MutationCtx): Promise<ClientContract> {
  const configuration = await ctx.db
    .query("appConfiguration")
    .withIndex("by_key", (index) => index.eq("key", "global"))
    .unique();
  return clientContractFor(configuration?.minimumSupportedBuild);
}

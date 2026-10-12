import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fail } from "./access";

const deletionBatchSize = 100;

export async function eraseAuthoredTextBatch(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
): Promise<{ deletedFieldCount: bigint; hasMore: boolean }> {
  const fetched = await ctx.db
    .query("eventTexts")
    .withIndex("by_author", (index) => index.eq("authorAccountId", accountId))
    .take(deletionBatchSize + 1);
  const batch = fetched.slice(0, deletionBatchSize);
  const nextRevisionByPot = new Map<string, bigint>();
  const potIdByPublicId = new Map<string, Id<"pots">>();
  const redactedAt = Date.now();

  for (const sidecar of batch) {
    let nextRevision = nextRevisionByPot.get(sidecar.potId);
    if (nextRevision === undefined) {
      const pot = await ctx.db
        .query("pots")
        .withIndex("by_pot_id", (index) => index.eq("potId", sidecar.potId))
        .unique();
      if (!pot) fail("POT_MISSING");
      nextRevision = pot.nextTextRevision;
      nextRevisionByPot.set(sidecar.potId, nextRevision);
      potIdByPublicId.set(sidecar.potId, pot._id);
    }
    await ctx.db.insert("textRedactions", {
      potId: sidecar.potId,
      eventId: sidecar.eventId,
      sequence: sidecar.sequence,
      field: sidecar.field,
      revision: nextRevision,
      redactedAt,
    });
    nextRevisionByPot.set(sidecar.potId, nextRevision + 1n);
    await ctx.db.delete(sidecar._id);
  }

  for (const [potId, nextTextRevision] of nextRevisionByPot) {
    const internalPotId = potIdByPublicId.get(potId);
    if (!internalPotId) fail("POT_MISSING");
    await ctx.db.patch(internalPotId, { nextTextRevision });
  }

  return {
    deletedFieldCount: BigInt(batch.length),
    hasMore: fetched.length > batch.length,
  };
}

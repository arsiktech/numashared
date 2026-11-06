// Read-only access for an AI agent.
//
// The person presses Connect in Settings. The phone makes a random secret, keeps it to show once,
// and sends only its SHA-256 here. The person pastes the secret link into their agent. The agent
// then calls POST /mcp (convex/agentMcp.ts) and can read what that person can read: the
// households they belong to, the people in them, balances and records. It cannot change anything,
// and it never moves money. The person can see what the agent did and disconnect it at any time.
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { fail, requireActiveMembership, requireSession } from "./lib/access";
import { requireApprovedWriteTarget } from "./lib/deployment";

export const maximumAgents = 5;
/** Calls per agent per minute: generous for a conversation, low enough to stop a runaway loop. */
export const callsPerMinute = 60;
const activityKeepMillis = 90 * 24 * 3_600_000;
const activityListLimit = 50;

const keyHashPattern = /^[0-9a-f]{64}$/;

/** Connects an agent. The secret never reaches the server; only its hash does. */
export const connect = mutation({
  args: {
    name: v.string(),
    keyHash: v.string(),
    keyHint: v.string(),
    potId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireApprovedWriteTarget();
    const { account } = await requireSession(ctx);
    if (!keyHashPattern.test(args.keyHash)) fail("AGENT_KEY_INVALID");
    if (args.potId !== undefined) await requireActiveMembership(ctx, args.potId, account._id);
    const active = (await ctx.db.query("agentConnections")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .collect()).filter((row) => row.revokedAt === undefined);
    if (active.length >= maximumAgents) fail("TOO_MANY_AGENTS");
    if (await ctx.db.query("agentConnections")
      .withIndex("by_key_hash", (q) => q.eq("keyHash", args.keyHash)).first()) {
      fail("AGENT_KEY_INVALID");
    }
    const now = Date.now();
    const id = await ctx.db.insert("agentConnections", {
      accountId: account._id,
      name: args.name.trim().slice(0, 60) || "My agent",
      keyHash: args.keyHash,
      keyHint: args.keyHint.slice(0, 12),
      ...(args.potId === undefined ? {} : { potId: args.potId }),
      createdAt: now,
      windowStartedAt: now,
      windowCount: 0,
    });
    return { id };
  },
});

/** The person's connected agents, without anything that could be used to act as them. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const { account } = await requireSession(ctx);
    const rows = await ctx.db.query("agentConnections")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .collect();
    return rows
      .filter((row) => row.revokedAt === undefined)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((row) => ({
        id: row._id,
        name: row.name,
        hint: row.keyHint,
        potId: row.potId ?? null,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt ?? null,
      }));
  },
});

/** Disconnects an agent at once: its secret stops working on the next call. */
export const disconnect = mutation({
  args: { id: v.id("agentConnections") },
  handler: async (ctx, { id }) => {
    const { account } = await requireSession(ctx);
    const row = await ctx.db.get(id);
    if (!row || row.accountId !== account._id) fail("AGENT_NOT_FOUND");
    if (row.revokedAt === undefined) await ctx.db.patch(id, { revokedAt: Date.now() });
    return null;
  },
});

/** The latest things connected agents did, newest first. */
export const recentActivity = query({
  args: {},
  handler: async (ctx) => {
    const { account } = await requireSession(ctx);
    const rows = await ctx.db.query("agentActivity")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .order("desc")
      .take(activityListLimit);
    const names = new Map<string, string>();
    for (const row of rows) {
      const key = String(row.connectionId);
      if (!names.has(key)) names.set(key, (await ctx.db.get(row.connectionId))?.name ?? "Disconnected agent");
    }
    return rows.map((row) => ({
      id: row._id,
      agent: names.get(String(row.connectionId))!,
      tool: row.tool,
      ok: row.ok,
      error: row.error ?? null,
      at: row.at,
    }));
  },
});

export type AgentAuth =
  | { ok: true; accountId: Id<"accounts">; connectionId: Id<"agentConnections">; potId: string | null }
  | { ok: false; reason: "unknown" | "disconnected" | "account" | "limited" };

async function accountIsUsable(ctx: MutationCtx, accountId: Id<"accounts">): Promise<boolean> {
  const account = await ctx.db.get(accountId);
  if (!account || account.deletionStartedAt !== undefined) return false;
  const authorization = await ctx.db.query("appleAuthorizations")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .unique();
  return authorization?.revokedAt === undefined;
}

/** Checks an agent's secret on every call, and counts the call. */
export const authenticate = internalMutation({
  args: { keyHash: v.string() },
  handler: async (ctx, { keyHash }): Promise<AgentAuth> => {
    const row = await ctx.db.query("agentConnections")
      .withIndex("by_key_hash", (q) => q.eq("keyHash", keyHash))
      .unique();
    if (!row) return { ok: false, reason: "unknown" };
    if (row.revokedAt !== undefined) return { ok: false, reason: "disconnected" };
    if (!(await accountIsUsable(ctx, row.accountId))) return { ok: false, reason: "account" };
    const now = Date.now();
    const windowMillis = 60_000;
    const fresh = now - row.windowStartedAt >= windowMillis;
    if (!fresh && row.windowCount >= callsPerMinute) return { ok: false, reason: "limited" };
    await ctx.db.patch(row._id, {
      windowStartedAt: fresh ? now : row.windowStartedAt,
      windowCount: fresh ? 1 : row.windowCount + 1,
      lastUsedAt: now,
    });
    return { ok: true, accountId: row.accountId, connectionId: row._id, potId: row.potId ?? null };
  },
});

/** Notes one tool call for the person's activity list, and drops entries older than 90 days. */
export const record = internalMutation({
  args: {
    connectionId: v.id("agentConnections"),
    accountId: v.id("accounts"),
    tool: v.string(),
    ok: v.boolean(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("agentActivity", {
      accountId: args.accountId,
      connectionId: args.connectionId,
      tool: args.tool.slice(0, 60),
      ok: args.ok,
      ...(args.error === undefined ? {} : { error: args.error.slice(0, 200) }),
      at: now,
    });
    const oldest = await ctx.db.query("agentActivity")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .order("asc")
      .first();
    if (oldest && oldest.at < now - activityKeepMillis) await ctx.db.delete(oldest._id);
    return null;
  },
});

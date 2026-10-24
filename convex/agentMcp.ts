// The MCP endpoint agents connect to (Streamable HTTP, JSON answers, read-only tools).
// The secret comes either in the link itself (/mcp/<secret>), which works in any client that takes
// just a URL, or as `Authorization: Bearer <secret>`, which keeps it out of access logs. Each call
// is checked against the connection, counted, and recorded in the person's activity list.
import { ConvexError } from "convex/values";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import type { AgentAuth } from "./agentAccess";
import { AGENT_INSTRUCTIONS, AgentInputError, agentTools, type AgentIo } from "./lib/agentTools";
import { sha256Hex } from "./lib/hash";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "numa-shared", title: "Numa Shared", version: "1.0.0" };

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type RpcResponse = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
const rpcError = (id: RpcRequest["id"], code: number, message: string): RpcResponse =>
  ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

const REFUSALS: Record<Exclude<AgentAuth, { ok: true }>["reason"], [number, string]> = {
  unknown: [401, "This agent link is not valid. Connect the agent again from Numa Shared, Settings, AI agents."],
  disconnected: [401, "This agent was disconnected in Numa Shared. Connect it again from Settings, AI agents."],
  account: [403, "This Numa Shared account is not available."],
  limited: [429, "Too many calls in a minute. Wait a moment and try again."],
};

const CODE_MESSAGES: Record<string, string> = {
  NOT_MEMBER: "That household is not one this person belongs to. Use list_households for valid ids.",
  MEMBERSHIP_ARCHIVED: "This person is no longer an active member of that household.",
  AGENT_NOT_ALLOWED: "This agent is limited to another household.",
  POT_DELETING: "That household is being deleted.",
  POT_MISSING: "That household does not exist.",
  HOUSEHOLD_TOO_LARGE_FOR_AGENT: "That household has too much history for an agent to read at once.",
  AGENT_BAD_CURSOR: "before_sequence is not a valid cursor.",
};

function secretFrom(request: Request): string | null {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer) return bearer;
  const tail = new URL(request.url).pathname.replace(/^\/mcp\/?/, "");
  if (!tail) return null;
  try { return decodeURIComponent(tail); } catch { return null; }
}

function errorText(error: unknown): string {
  if (error instanceof AgentInputError) return error.message;
  if (error instanceof ConvexError) {
    const data = error.data as { code?: string } | string;
    const code = typeof data === "string" ? data : data?.code;
    return (code && CODE_MESSAGES[code]) || "The request was refused.";
  }
  return "Something went wrong in Numa Shared. Try again.";
}

export const mcp = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  // No server-sent stream: every answer comes back in the POST response.
  if (request.method === "GET") return json({ error: "Use POST" }, 405, { allow: "POST" });
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.method !== "POST") return json({ error: "Use POST" }, 405, { allow: "POST" });

  const secret = secretFrom(request);
  if (!secret || secret.length > 200) {
    return json(rpcError(null, -32001, REFUSALS.unknown[1]), 401, { "www-authenticate": "Bearer" });
  }
  const auth: AgentAuth = await ctx.runMutation(internal.agentAccess.authenticate, { keyHash: await sha256Hex(secret) });
  if (!auth.ok) {
    const [status, message] = REFUSALS[auth.reason];
    return json(rpcError(null, -32001, message), status, status === 401 ? { "www-authenticate": "Bearer" } : {});
  }

  let body: unknown;
  try { body = await request.json(); } catch { return json(rpcError(null, -32700, "The request is not valid JSON."), 400); }
  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as RpcRequest[];
  if (!messages.length || messages.length > 20) return json(rpcError(null, -32600, "Send between 1 and 20 messages."), 400);

  const io: AgentIo = {
    read: (reader, args) => {
      const scoped = { accountId: auth.accountId, scopePotId: auth.potId, ...args } as never;
      switch (reader) {
        case "households": return ctx.runQuery(internal.agentData.households, scoped);
        case "members": return ctx.runQuery(internal.agentData.members, scoped);
        case "balances": return ctx.runQuery(internal.agentData.balances, scoped);
        case "records": return ctx.runQuery(internal.agentData.records, scoped);
      }
    },
  };

  const answer = async (m: RpcRequest): Promise<RpcResponse | null> => {
    if (!m || typeof m !== "object" || typeof m.method !== "string") return rpcError(m?.id, -32600, "Not a JSON-RPC request.");
    const isNotification = m.id === undefined;
    switch (m.method) {
      case "initialize": {
        const asked = typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : PROTOCOL_VERSIONS[0]!;
        return {
          jsonrpc: "2.0",
          id: m.id ?? null,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: AGENT_INSTRUCTIONS,
          },
        };
      }
      case "ping": return { jsonrpc: "2.0", id: m.id ?? null, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id: m.id ?? null,
          result: {
            tools: agentTools.map((t) => ({
              name: t.name,
              title: t.title,
              description: t.description,
              inputSchema: t.inputSchema,
              annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, openWorldHint: false },
            })),
          },
        };
      case "tools/call": {
        const name = String(m.params?.name ?? "");
        const tool = agentTools.find((t) => t.name === name);
        if (!tool) return rpcError(m.id, -32602, `Unknown tool ${name}. This connection can only read.`);
        const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
        let result: { content: Array<{ type: "text"; text: string }>; structuredContent?: unknown; isError?: boolean };
        let failure: string | undefined;
        try {
          const value = await tool.run(io, args);
          const structured = value && typeof value === "object" && !Array.isArray(value) ? value : { result: value ?? null };
          result = { content: [{ type: "text", text: JSON.stringify(value ?? null, null, 2) }], structuredContent: structured };
        } catch (error) {
          failure = errorText(error);
          result = { content: [{ type: "text", text: failure }], isError: true };
        }
        await ctx.runMutation(internal.agentAccess.record, {
          connectionId: auth.connectionId,
          accountId: auth.accountId,
          tool: tool.name,
          ok: failure === undefined,
          ...(failure === undefined ? {} : { error: failure }),
        });
        return { jsonrpc: "2.0", id: m.id ?? null, result };
      }
      default:
        if (isNotification) return null;
        return rpcError(m.id, -32601, `Method not found: ${m.method}`);
    }
  };

  const replies: RpcResponse[] = [];
  for (const message of messages) {
    const reply = await answer(message);
    if (reply) replies.push(reply);
  }
  if (replies.length === 0) return new Response(null, { status: 202 });
  return json(batch ? replies : replies[0]);
});

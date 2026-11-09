// The MCP endpoint agents connect to (Streamable HTTP, JSON answers). Reading tools, and writing
// tools that the person's switches allow (convex/agentWrites.ts enforces them).
//
// Credentials: an OAuth access token (convex/agentOAuth.ts) or a secret link's secret, sent as
// `Authorization: Bearer <token>`. A secret link (/mcp/<secret>) also works, for clients that take
// only a URL; the path accepts only such secrets (`nsag_`), never OAuth tokens. One JSON-RPC
// message per POST: batches are refused. A call without a valid credential gets 401 with a WWW-Authenticate header that points
// to the protected resource metadata, which is how an agent finds the "Connect" flow.
//
// Protocol: both eras of MCP. Clients that open with `initialize` (2025-11-25 and earlier) get the
// handshake. Clients on 2026-07-28 send the version with every request and may call
// server/discover; there are no sessions either way. Each call is checked against the connection,
// counted, and recorded in the person's activity list (tool name and answered or refused only).
import { ConvexError } from "convex/values";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import type { AgentAuth } from "./agentAccess";
import { AGENT_INSTRUCTIONS, AgentInputError, agentTools, runTool, type AgentIo } from "./lib/agentTools";
import { sha256Hex } from "./lib/hash";
import { OAUTH_SCOPE, isLoopbackHost, ownResources, requestOrigin, resourceMetadataURL } from "./lib/oauth";

declare const process: { env: Record<string, string | undefined> };

const MODERN_VERSIONS = ["2026-07-28"];
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
const SERVER_INFO = { name: "numa-shared", title: "Numa Shared", version: "1.2.0" };
const META_VERSION = "io.modelcontextprotocol/protocolVersion";

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type RpcResponse = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string; data?: unknown } };

// Agents send only a bearer token, never cookies, so a browser-based client on any origin may call.
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID",
  "access-control-expose-headers": "WWW-Authenticate, MCP-Protocol-Version",
  "access-control-max-age": "600",
};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...cors, ...extra },
  });
const rpcError = (id: RpcRequest["id"], code: number, message: string, data?: unknown): RpcResponse =>
  ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });

const REFUSALS: Record<Exclude<AgentAuth, { ok: true }>["reason"], [number, string]> = {
  unknown: [401, "This agent is not connected to Numa Shared. Connect it again."],
  expired: [401, "The access token expired. Refresh it or connect again."],
  disconnected: [401, "This agent was disconnected in Numa Shared. Connect it again."],
  account: [403, "This Numa Shared account is not available."],
  limited: [429, "Too many calls in a minute. Wait a moment and try again."],
};

const SWITCH_HINT = "The person can turn it on in Numa Shared, Settings, AI agents. Don't ask them to unless they want you to do this.";

const CODE_MESSAGES: Record<string, string> = {
  NOT_MEMBER: "That household is not one this person belongs to. Use list_households for valid ids.",
  MEMBERSHIP_ARCHIVED: "This person is no longer an active member of that household.",
  AGENT_NOT_ALLOWED: "This agent is limited to another household.",
  POT_DELETING: "That household is being deleted.",
  POT_MISSING: "That household does not exist.",
  POT_ARCHIVED: "That household is archived and can't change.",
  HOUSEHOLD_TOO_LARGE_FOR_AGENT: "That household has too much history for an agent to read at once.",
  AGENT_BAD_CURSOR: "before_sequence is not a valid cursor.",
  // Switches (Settings, AI agents).
  AGENT_SWITCH_ADD_RECORDS_OFF: `Refused: the "Add expenses and repayments" switch is off for this agent. ${SWITCH_HINT}`,
  AGENT_SWITCH_EDIT_RECORDS_OFF: `Refused: the "Edit and void records" switch is off for this agent. ${SWITCH_HINT}`,
  AGENT_SWITCH_MANAGE_HOUSEHOLD_OFF: `Refused: the "Manage the household" switch is off for this agent. ${SWITCH_HINT}`,
  AGENT_DISCONNECTED: "This agent was disconnected in Numa Shared. Connect it again.",
  AGENT_WRITE_LIMITED: "Too many changes in a minute. Wait a moment and try again with the same request_id.",
  ACCOUNT_WRITE_RATE_LIMITED: "This person has made too many changes this hour. Try again later.",
  AGENT_REQUEST_ID_INVALID: "request_id must be 8 to 100 letters, digits, '.', '_', ':' or '-'.",
  AGENT_REQUEST_ID_REUSED: "That request_id was already used for a different change. Use a new request_id for a new change.",
  // What the agent sent.
  AGENT_CURRENCY_MISMATCH: "Refused: the currency is not the household's. Numa Shared doesn't convert currencies.",
  AGENT_AMOUNT_INVALID: "The amount is not valid.",
  AGENT_TEXT_TOO_LONG: "Some text is too long.",
  AGENT_CATEGORY_UNKNOWN: "That category doesn't exist.",
  AGENT_METHOD_UNKNOWN: "That repayment method doesn't exist.",
  AGENT_DATE_INVALID: "The date is not valid.",
  AGENT_TIME_ZONE_INVALID: "The time zone is not valid.",
  AGENT_TITLE_REQUIRED: "An expense needs a title or a category.",
  AGENT_NAME_REQUIRED: "A name is required.",
  AGENT_REASON_REQUIRED: "A reason is required.",
  AGENT_UNKNOWN_PERSON: "That person or group is not in this household. Use list_members for member_id and unitId values.",
  AGENT_PERSON_LEFT: "That person has left the household.",
  AGENT_PERSON_JOINED: "That person has already joined, so they don't need an invite.",
  AGENT_SPLIT_INVALID: "The split is not valid.",
  AGENT_SPLIT_REQUIRED: "This expense isn't split equally, so a new amount needs the new split too.",
  AGENT_REPAYMENT_SAME_GROUP: "A repayment needs two different people or groups.",
  AGENT_GROUP_TOO_LARGE: "That group is too large.",
  AGENT_GROUPS_OVERLAP: "A person can be in only one group.",
  AGENT_INVITE_EXISTS: "That person already has a live invite code, made in the app or earlier. Ask the owner to share it from the app, or call again with replace_existing true, which stops the old code working.",
  // Records.
  AGENT_RECORD_NOT_FOUND: "That record doesn't exist in this household. Use list_records.",
  AGENT_RECORD_VOIDED: "That record is voided. A voided record can't be edited or voided again.",
  AGENT_RECORD_CONTESTED: "Two people edited that record at once. Someone has to choose a version in the app first.",
  AGENT_RECORD_CHANGED: "Someone changed that record since you read it. Read it again with list_records and use its new revision.",
  AGENT_REPAYMENT_IMMUTABLE: "Repayments can't be edited or voided. If one is wrong, the person can flag it in the app.",
  AGENT_OPENING_BALANCE_EDIT: "Opening balances can't be edited through an agent.",
  AGENT_NOTHING_TO_CHANGE: "Nothing would change.",
  // The household (the same rules as the app).
  NOT_OWNER: "Only the household's owner can do that.",
  BUDGET_GROUPS_LOCKED: "Groups can't change once the household has recorded money.",
  INVALID_BUDGET_GROUP: "That group is not allowed (too many people, or other app versions in this household can't show it yet).",
  TOPOLOGY_REVISION_CONFLICT: "The groups changed at the same moment. Try again.",
  OWNER_UNIT_NOT_BOUND: "The owner needs to open this household in the app once before groups can change.",
  INVITE_PENDING_MEMBER_ALREADY_ACTIVE: "That person already has a live invite code.",
  INACTIVE_UNIT: "One of those people or groups no longer takes part in new records.",
  INVALID_PAYER_MEMBER: "That person can't be the payer.",
  TOO_MANY_UNITS: "The household has as many people as it can hold.",
};

/**
 * The Authorization header, or a secret link's secret in the path. Only secret-link secrets
 * (`nsag_`) are read from the path: OAuth access tokens must arrive in the header, so they never
 * sit in URLs, proxy logs or history.
 */
function credentialFrom(request: Request): { credential: string; fromPath: boolean } | null {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer) return { credential: bearer, fromPath: false };
  const tail = new URL(request.url).pathname.replace(/^\/mcp\/?/, "");
  if (!tail.startsWith("nsag_")) return null;
  try { return { credential: decodeURIComponent(tail), fromPath: true }; } catch { return null; }
}

/** What the agent reads when a tool is refused. Server codes are not secret; unknown ones are named. */
export function errorText(error: unknown): string {
  if (error instanceof AgentInputError) return error.message;
  if (error instanceof ConvexError) {
    const data = error.data as { code?: string; detail?: string } | string;
    const code = typeof data === "string" ? data : data?.code;
    const detail = typeof data === "string" ? undefined : data?.detail;
    const message = (code && CODE_MESSAGES[code]) || (code ? `The change was refused (${code}).` : "The request was refused.");
    return detail ? `${message} (${detail})` : message;
  }
  return "Something went wrong in Numa Shared. Try again.";
}

/** Streamable HTTP asks servers to check Origin. Bearer-only, so any https or loopback page may call. */
function originAllowed(origin: string | null): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));
  } catch {
    return false;
  }
}

/** RFC 6750 challenge. Header values are quoted; ours never contain quotes. */
function challenge(origin: string, error?: "invalid_token"): Record<string, string> {
  const parts = [
    ...(error ? [`error="${error}"`] : []),
    `resource_metadata="${resourceMetadataURL(origin)}"`,
    `scope="${OAUTH_SCOPE}"`,
  ];
  return { "www-authenticate": `Bearer ${parts.join(", ")}` };
}

/** Decodes a `=?base64?…?=` header value (Streamable HTTP value encoding). */
function headerValue(value: string | null): string | null {
  if (value === null) return null;
  const encoded = value.match(/^=\?base64\?([A-Za-z0-9+/=]*)\?=$/)?.[1];
  if (encoded === undefined) return value;
  try { return new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))); } catch { return null; }
}

export const mcp = httpAction(async (ctx, request) => {
  if (!originAllowed(request.headers.get("origin"))) {
    return json(rpcError(null, -32600, "This origin may not call Numa Shared."), 403);
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  // No server-sent stream and no sessions: every answer comes back in the POST response.
  if (request.method !== "POST") return json({ error: "Use POST" }, 405, { allow: "POST" });

  const origin = requestOrigin(process.env, request);
  const presented = credentialFrom(request);
  if (!presented || presented.credential.length > 200) {
    return json(rpcError(null, -32001, "Connect this agent to Numa Shared first."), 401, challenge(origin));
  }
  const auth: AgentAuth = await ctx.runMutation(internal.agentAccess.authenticate, {
    tokenHash: await sha256Hex(presented.credential),
    resources: ownResources(process.env),
    linkOnly: presented.fromPath,
  });
  if (!auth.ok) {
    const [status, message] = REFUSALS[auth.reason];
    return json(rpcError(null, -32001, message), status, status === 401 ? challenge(origin, "invalid_token") : {});
  }

  let body: unknown;
  try { body = await request.json(); } catch { return json(rpcError(null, -32700, "The request is not valid JSON."), 400); }
  // One message per POST. MCP removed JSON-RPC batching in 2025-06-18, and the clients we serve
  // never sent batches; a batch would also run many tools on one counted call.
  if (Array.isArray(body)) {
    return json(rpcError(null, -32600, "JSON-RPC batches are not supported. Send one message per request."), 400);
  }
  const message = body as RpcRequest;

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
    write: (op, requestId) => ctx.runMutation(internal.agentWrites.write, {
      connectionId: auth.connectionId, requestId, origin, op,
    }),
  };

  // A 2026-07-28 request names its version in _meta and mirrors it, the method and the tool name
  // in headers. Requests without it are served as the legacy (initialize-based) protocol.
  const headerVersion = request.headers.get("mcp-protocol-version");
  const modernOf = (m: RpcRequest): { version: string } | { error: RpcResponse; status: number } | null => {
    const meta = m.params?._meta as Record<string, unknown> | undefined;
    const version = typeof meta?.[META_VERSION] === "string" ? (meta[META_VERSION] as string) : undefined;
    if (version === undefined) return null;
    if (!SUPPORTED_VERSIONS.includes(version) || !MODERN_VERSIONS.includes(version)) {
      return { status: 400, error: rpcError(m.id, -32022, "Unsupported protocol version", { supported: SUPPORTED_VERSIONS, requested: version }) };
    }
    if (headerVersion !== version || request.headers.get("mcp-method") !== m.method) {
      return { status: 400, error: rpcError(m.id, -32020, "Header mismatch: MCP-Protocol-Version and Mcp-Method must match the body.") };
    }
    if (m.method === "tools/call" && headerValue(request.headers.get("mcp-name")) !== m.params?.name) {
      return { status: 400, error: rpcError(m.id, -32020, "Header mismatch: Mcp-Name must match the tool name.") };
    }
    return { version };
  };

  const toolList = () => agentTools.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      title: t.title,
      readOnlyHint: t.writes === undefined,
      destructiveHint: t.destructive === true,
      // Writes take a request_id: repeating a call with the same one changes nothing more.
      idempotentHint: true,
      openWorldHint: false,
    },
  }));

  const answer = async (m: RpcRequest): Promise<{ reply: RpcResponse | null; status?: number }> => {
    if (!m || typeof m !== "object" || typeof m.method !== "string") return { reply: rpcError(m?.id, -32600, "Not a JSON-RPC request.") };
    const isNotification = m.id === undefined;
    const era = modernOf(m);
    if (era && "error" in era) return { reply: era.error, status: era.status };
    const modern = era !== null;
    const done = (result: Record<string, unknown>): RpcResponse => ({
      jsonrpc: "2.0",
      id: m.id ?? null,
      result: modern
        ? { resultType: "complete", ...result, _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO } }
        : result,
    });
    switch (m.method) {
      case "initialize": {
        const asked = typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : LEGACY_VERSIONS[0]!;
        const clientInfo = m.params?.clientInfo as { name?: unknown; title?: unknown } | undefined;
        const clientName = typeof clientInfo?.title === "string" ? clientInfo.title : clientInfo?.name;
        if (typeof clientName === "string" && clientName.trim()) {
          await ctx.runMutation(internal.agentAccess.nameFromClient, { connectionId: auth.connectionId, clientName });
        }
        return {
          reply: done({
            protocolVersion: LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: AGENT_INSTRUCTIONS,
          }),
        };
      }
      case "server/discover":
        return {
          reply: done({
            supportedVersions: SUPPORTED_VERSIONS,
            capabilities: { tools: {} },
            instructions: AGENT_INSTRUCTIONS,
            ttlMs: 3_600_000,
            cacheScope: "public",
          }),
        };
      case "ping": return { reply: done({}) };
      case "tools/list":
        return { reply: done(modern ? { tools: toolList(), ttlMs: 3_600_000, cacheScope: "public" } : { tools: toolList() }) };
      case "tools/call": {
        const name = String(m.params?.name ?? "");
        const tool = agentTools.find((t) => t.name === name);
        if (!tool) return { reply: rpcError(m.id, -32602, `Unknown tool ${name}. Use tools/list for the tools Numa Shared offers.`) };
        const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
        let result: { content: Array<{ type: "text"; text: string }>; structuredContent?: unknown; isError?: boolean };
        let ok = true;
        try {
          const value = await runTool(io, tool, args);
          const structured = value && typeof value === "object" && !Array.isArray(value) ? value : { result: value ?? null };
          result = { content: [{ type: "text", text: JSON.stringify(value ?? null, null, 2) }], structuredContent: structured };
        } catch (error) {
          ok = false;
          result = { content: [{ type: "text", text: errorText(error) }], isError: true };
        }
        await ctx.runMutation(internal.agentAccess.record, {
          connectionId: auth.connectionId,
          accountId: auth.accountId,
          tool: tool.name,
          ok,
        });
        return { reply: done(result) };
      }
      default:
        if (isNotification) return { reply: null };
        return { reply: rpcError(m.id, -32601, `Method not found: ${m.method}`), ...(modern ? { status: 404 } : {}) };
    }
  };

  const { reply, status } = await answer(message);
  if (!reply) return new Response(null, { status: 202, headers: cors });
  return json(reply, status ?? 200);
});

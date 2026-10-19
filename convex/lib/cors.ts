// The web app runs on its own origin (for example https://shared.numaworth.com) and calls a few of
// these HTTP endpoints from the browser. Only origins listed in NUMA_SHARED_WEB_ORIGINS
// (comma-separated, exact https origins) get CORS headers; everyone else gets none, as before.
import { httpActionGeneric, type PublicHttpAction } from "convex/server";

export function allowedWebOrigin(
  environment: Readonly<Record<string, string | undefined>>,
  origin: string | null,
): string | null {
  if (!origin) return null;
  const allowed = (environment.NUMA_SHARED_WEB_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(o));
  return allowed.includes(origin) ? origin : null;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
  };
}

/** The same handler, plus CORS headers for an allowed web origin. */
export function withCors(action: PublicHttpAction): PublicHttpAction {
  const handler = (action as unknown as { _handler: (ctx: unknown, request: Request) => Promise<Response> })._handler;
  return httpActionGeneric(async (ctx, request) => {
    const response = await handler(ctx, request);
    const origin = allowedWebOrigin(process.env, request.headers.get("Origin"));
    if (!origin) return response;
    const out = new Response(response.body, response);
    for (const [k, v] of Object.entries(corsHeaders(origin))) out.headers.set(k, v);
    out.headers.append("Vary", "Origin");
    return out;
  });
}

/** Answers the browser's preflight for an allowed web origin; refuses it otherwise. */
export const preflight = httpActionGeneric(async (_ctx, request) => {
  const origin = allowedWebOrigin(process.env, request.headers.get("Origin"));
  if (!origin) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: { ...corsHeaders(origin), Vary: "Origin" } });
});

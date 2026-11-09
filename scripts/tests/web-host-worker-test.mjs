// The shared.numaworth.com Worker passes AI agents' MCP calls through to the backend instead of
// redirecting them, because a cross-origin redirect drops the Authorization header.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import worker from "../../tools/web-host/worker.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function capture(response = new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return response; };
  return calls;
}

const env = { ASSETS: { fetch: async () => new Response("app") } };

test("POST /mcp is proxied with its bearer token and names the public origin", async () => {
  const calls = capture();
  const response = await worker.fetch(new Request("https://shared.numaworth.com/mcp", {
    method: "POST",
    headers: { authorization: "Bearer nsat_x", "content-type": "application/json", "mcp-protocol-version": "2026-07-28", "x-numa-public-origin": "https://evil.example" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }), env);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://adept-camel-457.convex.site/mcp");
  const headers = calls[0].init.headers;
  assert.equal(headers.get("authorization"), "Bearer nsat_x");
  assert.equal(headers.get("mcp-protocol-version"), "2026-07-28");
  assert.equal(headers.get("x-numa-public-origin"), "https://shared.numaworth.com");
  assert.equal(calls[0].init.method, "POST");
});

test("protected resource metadata is proxied, not 404", async () => {
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const calls = capture();
    const response = await worker.fetch(new Request(`https://shared.numaworth.com${path}`), env);
    assert.equal(response.status, 200);
    assert.equal(calls[0].url, `https://adept-camel-457.convex.site${path}`);
  }
});

test("a 401 from the backend reaches the agent with its WWW-Authenticate header", async () => {
  capture(new Response("{}", { status: 401, headers: { "www-authenticate": "Bearer resource_metadata=\"x\"" } }));
  const response = await worker.fetch(new Request("https://shared.numaworth.com/mcp", { method: "POST", body: "{}" }), env);
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /resource_metadata/);
});

test("the app, including the Connect page, may not be framed by another site", async () => {
  const assets = {
    fetch: async (request) => new URL(request.url).pathname === "/missing"
      ? new Response("not found", { status: 404 })
      : new Response("app", { status: 200, headers: { "content-type": "text/html" } }),
  };
  for (const path of ["/app/", "/app/connect?request=nsar_x", "/app/_expo/static/js/web/entry-abc.js", "/app/missing"]) {
    const response = await worker.fetch(new Request(`https://shared.numaworth.com${path}`), { ASSETS: assets });
    assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'", path);
    assert.equal(response.headers.get("x-frame-options"), "DENY", path);
  }
  const bundle = await worker.fetch(new Request("https://shared.numaworth.com/app/_expo/static/js/web/entry-abc.js"), { ASSETS: assets });
  assert.equal(bundle.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await bundle.text(), "app");
  const missing = await worker.fetch(new Request("https://shared.numaworth.com/app/missing"), { ASSETS: assets });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), null);
});

test("other POSTs still redirect so rate limits see the caller", async () => {
  const calls = capture();
  const response = await worker.fetch(new Request("https://shared.numaworth.com/auth/refresh", { method: "POST", body: "{}" }), env);
  assert.equal(response.status, 307);
  assert.equal(calls.length, 0);
});

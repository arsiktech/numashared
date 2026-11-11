// OAuth 2.1 pieces for connecting an AI agent (MCP authorization, spec revision 2026-07-28).
// Pure functions only: addresses, metadata documents, redirect and PKCE checks, client
// registration parsing. The endpoints that use them are in convex/agentOAuth.ts.
//
// Addresses:
// - The authorization server (issuer) is this deployment's own site URL (CONVEX_SITE_URL).
// - The MCP server is `<origin>/mcp` for each public origin that serves it: the site URL itself
//   and every origin in NUMA_SHARED_WEB_ORIGINS (shared.numaworth.com proxies /mcp here and
//   names itself in the x-numa-public-origin header). A token is valid on any of them, because
//   they are the same server.

type Env = Readonly<Record<string, string | undefined>>;

/** Read the person's households. Every connection has it. */
export const READ_SCOPE = "shared:read";
/**
 * Change them as the person, within the switches they set in Settings, AI agents. The switches,
 * not the token, decide each call. Numa Shared never moves money.
 */
export const WRITE_SCOPE = "shared:write";
export const OAUTH_SCOPES = [READ_SCOPE, WRITE_SCOPE] as const;
/** Everything an agent may ask for, space-separated, as the WWW-Authenticate challenge names it. */
export const OAUTH_SCOPE = OAUTH_SCOPES.join(" ");
export const ACCESS_TOKEN_SECONDS = 3_600;
export const REFRESH_TOKEN_MILLIS = 30 * 24 * 3_600_000;
/** A retried refresh within this window gets the same new pair instead of closing the connection (RFC 9700 4.14.2). */
export const REFRESH_GRACE_MILLIS = 30_000;
export const CODE_MILLIS = 5 * 60_000;
export const REQUEST_MILLIS = 10 * 60_000;
export const METADATA_CACHE_MILLIS = 3_600_000;
export const PUBLIC_ORIGIN_HEADER = "x-numa-public-origin";

const trimSlash = (value: string) => value.replace(/\/+$/, "");

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** This deployment's site URL, which is also the OAuth issuer. */
export function siteOrigin(env: Env): string {
  const site = env.CONVEX_SITE_URL;
  if (!site) throw new Error("OAUTH_SITE_URL_MISSING");
  return trimSlash(site);
}

export const issuerOf = siteOrigin;

/** Every origin that serves this MCP server. */
export function publicOrigins(env: Env): string[] {
  const extra = (env.NUMA_SHARED_WEB_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(o));
  return [...new Set([siteOrigin(env), ...extra])];
}

/** The origin a request reached: a listed proxy origin when it names itself, else the site URL. */
export function requestOrigin(env: Env, request: Request): string {
  const named = request.headers.get(PUBLIC_ORIGIN_HEADER)?.trim();
  if (named && publicOrigins(env).includes(named)) return named;
  return siteOrigin(env);
}

export const resourceOf = (origin: string) => `${origin}/mcp`;
export const resourceMetadataURL = (origin: string) => `${origin}/.well-known/oauth-protected-resource/mcp`;

export function ownResources(env: Env): string[] {
  return publicOrigins(env).map(resourceOf);
}

/** RFC 8707 resource as clients send it: lower-case scheme and host, no trailing slash, no fragment. */
export function canonicalResource(value: string): string | null {
  if (value.length > 300) return null;
  try {
    const url = new URL(value);
    if (url.hash || url.search || url.username || url.password) return null;
    // The URL parser already lower-cases the scheme and host; the path keeps its case.
    return trimSlash(`${url.protocol}//${url.host}${url.pathname}`);
  } catch {
    return null;
  }
}

/** Matches a requested resource against this server's own; null when it names another server. */
export function matchResource(env: Env, requested: string | null | undefined): string | null {
  if (!requested) return null;
  const canonical = canonicalResource(requested);
  if (!canonical) return null;
  return ownResources(env).find((own) => own === canonical) ?? null;
}

export function protectedResourceMetadata(env: Env, origin: string) {
  return {
    resource: resourceOf(origin),
    authorization_servers: [issuerOf(env)],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Numa Shared",
  };
}

export function authorizationServerMetadata(env: Env) {
  const issuer = issuerOf(env);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [...OAUTH_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * Where the consent page lives: NUMA_SHARED_WEB_APP_URL (https), or a loopback http address on
 * the anonymous local test deployment only.
 */
export function webAppURL(env: Env): string | null {
  const value = env.NUMA_SHARED_WEB_APP_URL?.trim();
  if (!value || value.length > 300) return null;
  try {
    const url = new URL(value);
    const local = env.NUMA_SHARED_DEPLOYMENT_CLASS === "anonymous-local"
      && url.protocol === "http:" && isLoopbackHost(url.hostname);
    if (url.protocol !== "https:" && !local) return null;
    if (url.search || url.hash) return null;
    return trimSlash(url.toString());
  } catch {
    return null;
  }
}

/** App schemes of agents we support that are not reverse-DNS names. */
const KNOWN_APP_SCHEMES = new Set(["cursor:"]);
/** A private-use scheme named after a domain in reverse order, e.g. com.example.app (RFC 8252 section 7.1). */
const REVERSE_DNS_SCHEME = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+:$/;

/**
 * A redirect URI a client may register. An allowlist: https, http on a loopback address (native
 * apps, terminal agents, MCP Inspector), a known agent's app scheme (cursor://), or a reverse-DNS
 * private-use scheme. Any other scheme (search-ms:, ms-msdt:, javascript: …) is refused, so an
 * operating-system handler can never be a redirect target. Never a fragment or credentials.
 */
export function redirectUriAllowed(value: string): boolean {
  if (value.length > 500) return false;
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === "https:") return url.hostname.length > 0;
    if (url.protocol === "http:") return isLoopbackHost(url.hostname);
    if (url.protocol.length > 60) return false;
    return KNOWN_APP_SCHEMES.has(url.protocol) || REVERSE_DNS_SCHEME.test(url.protocol);
  } catch {
    return false;
  }
}

export function isLoopbackRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/** Exact match, except that a loopback redirect may use any port (RFC 8252 section 7.3). */
export function redirectMatches(registered: readonly string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  if (!isLoopbackRedirect(presented)) return false;
  const p = new URL(presented);
  return registered.some((r) => {
    if (!isLoopbackRedirect(r)) return false;
    const u = new URL(r);
    return u.hostname === p.hostname && u.pathname === p.pathname && u.search === p.search;
  });
}

/** What the consent page names as the place the person returns to. */
export function redirectLabel(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.host;
    return `${url.protocol}//${url.host}`;
  } catch {
    return "an unknown address";
  }
}

export function withQuery(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
}

export const validCodeVerifier = (value: string) => /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
export const validCodeChallenge = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** A random secret with a readable prefix: nsat_ access, nsrt_ refresh, nsac_ code, nsar_ request, nsc_ client. */
export function randomSecret(prefix: string, bytes = 32): string {
  return `${prefix}_${base64url(crypto.getRandomValues(new Uint8Array(bytes)))}`;
}

/**
 * The token a refresh rotates into: HMAC-SHA-256 of the presented refresh token under a server
 * secret, with the prefix as domain separation. The same refresh always gives the same pair, so a
 * retry inside the grace window gets what the first attempt got, and no plaintext is stored.
 * Without the secret, nobody can work out the next token from the presented one.
 */
export async function rotatedSecret(serverSecret: string, prefix: "nsat" | "nsrt", presented: string): Promise<string> {
  return `${prefix}_${base64url(await hmacSha256(serverSecret, `numa-shared/oauth-rotation/v1/${prefix}/${presented}`))}`;
}

/** HMAC-SHA-256 of `label` under `secret`. */
export async function hmacSha256(secret: string, label: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(label)));
}

/** Accepts the request's scope: ours, plus offline_access, which clients may add for refresh tokens. */
export function scopeAccepted(scope: string | null | undefined): boolean {
  if (!scope) return true;
  const parts = scope.split(" ").filter(Boolean);
  return parts.length <= 5 && parts.every((part) => (OAUTH_SCOPES as readonly string[]).includes(part) || part === "offline_access");
}

export type ClientRegistration = {
  name: string;
  redirectUris: string[];
  clientUri?: string;
  authMethod: "none" | "client_secret_post" | "client_secret_basic";
  grantTypes: string[];
};

type Failure = { error: string; description: string };

const cleanName = (value: unknown, fallback: string) =>
  typeof value === "string" && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60) : fallback;

function httpsURL(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 300) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Validates an RFC 7591 registration request. */
export function parseRegistration(body: unknown): { ok: true; value: ClientRegistration } | ({ ok: false } & Failure) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_client_metadata", description: "Send the client metadata as a JSON object." };
  }
  const meta = body as Record<string, unknown>;
  const uris = meta.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10 || !uris.every((u) => typeof u === "string" && redirectUriAllowed(u))) {
    return {
      ok: false,
      error: "invalid_redirect_uri",
      description: "redirect_uris must list 1 to 10 addresses without fragments: https, loopback http, cursor:// or a reverse-DNS app scheme (RFC 8252).",
    };
  }
  const grantTypes = Array.isArray(meta.grant_types) ? meta.grant_types.map(String) : ["authorization_code", "refresh_token"];
  if (!grantTypes.includes("authorization_code") || grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    return { ok: false, error: "invalid_client_metadata", description: "Only authorization_code and refresh_token are supported." };
  }
  const responseTypes = Array.isArray(meta.response_types) ? meta.response_types.map(String) : ["code"];
  if (responseTypes.some((r) => r !== "code")) {
    return { ok: false, error: "invalid_client_metadata", description: "Only the code response type is supported." };
  }
  const method = meta.token_endpoint_auth_method ?? "none";
  if (method !== "none" && method !== "client_secret_post" && method !== "client_secret_basic") {
    return { ok: false, error: "invalid_client_metadata", description: "token_endpoint_auth_method must be none, client_secret_post or client_secret_basic." };
  }
  const clientUri = httpsURL(meta.client_uri);
  return {
    ok: true,
    value: {
      name: cleanName(meta.client_name, "An AI agent"),
      redirectUris: [...new Set(uris as string[])],
      ...(clientUri ? { clientUri } : {}),
      authMethod: method,
      grantTypes,
    },
  };
}

/**
 * A client id that names its own metadata document: an https URL with a path, no fragment, no
 * credentials, on the default port, and not a raw IP address or a local name (the server fetches it).
 */
export function isMetadataClientId(value: string): boolean {
  if (value.length > 300) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hash || url.username || url.password || url.port) return false;
    if (url.pathname === "/" || url.pathname === "") return false;
    const host = url.hostname;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[") || !host.includes(".")) return false;
    if (/(^|\.)(localhost|local|internal|lan|home|intranet|corp)$/i.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Validates a fetched Client ID Metadata Document against the URL it was fetched from. */
export function parseClientMetadataDocument(clientId: string, document: unknown):
  { ok: true; value: ClientRegistration } | ({ ok: false } & Failure) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { ok: false, error: "invalid_client", description: "The client metadata document is not a JSON object." };
  }
  const doc = document as Record<string, unknown>;
  if (doc.client_id !== clientId) {
    return { ok: false, error: "invalid_client", description: "The client metadata document names another client_id." };
  }
  const method = doc.token_endpoint_auth_method ?? "none";
  if (method !== "none") {
    return { ok: false, error: "invalid_client", description: "Only public clients (token_endpoint_auth_method none) can use a metadata document here." };
  }
  const parsed = parseRegistration({ ...doc, token_endpoint_auth_method: "none" });
  if (!parsed.ok) return { ok: false, error: "invalid_client", description: parsed.description };
  if (typeof doc.client_name !== "string" || !doc.client_name.trim()) {
    return { ok: false, error: "invalid_client", description: "The client metadata document has no client_name." };
  }
  return parsed;
}

/** How long a fetched metadata document may be cached, from its Cache-Control header (1 minute to 1 day). */
export function metadataCacheMillis(cacheControl: string | null): number {
  const maxAge = cacheControl?.match(/max-age=(\d+)/)?.[1];
  if (cacheControl && /no-store|no-cache/.test(cacheControl)) return 60_000;
  if (!maxAge) return METADATA_CACHE_MILLIS;
  return Math.min(Math.max(Number(maxAge) * 1_000, 60_000), 86_400_000);
}

/** The client id's host, shown on the consent page next to a metadata client's own name. */
export function hostOf(value: string): string | null {
  try { return new URL(value).host; } catch { return null; }
}

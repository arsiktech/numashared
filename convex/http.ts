import { httpRouter } from "convex/server";

import { mcp } from "./agentMcp";
import { spendsHttp } from "./cardSync";
import { preflight, withCors } from "./lib/cors";

import {
  appleExchange,
  appleNotification,
  googleExchange,
  accountDeletionPreview,
  deleteAccount,
  e2eBootstrap,
  logout,
  refresh,
} from "./identityHttp";
import {
  aasa,
  appConfiguration,
  inviteLanding,
  inviteResolve,
  marketing,
  marketingAsset,
  privacy,
  support,
  terms,
} from "./web";

const http = httpRouter();

http.route({ path: "/", method: "GET", handler: marketing });
http.route({ pathPrefix: "/assets/", method: "GET", handler: marketingAsset });
http.route({ path: "/auth/apple/exchange", method: "POST", handler: withCors(appleExchange) });
http.route({
  path: "/auth/apple/notifications",
  method: "POST",
  handler: appleNotification,
});
http.route({ path: "/auth/google/exchange", method: "POST", handler: withCors(googleExchange) });
http.route({ path: "/auth/refresh", method: "POST", handler: withCors(refresh) });
http.route({ path: "/auth/logout", method: "POST", handler: withCors(logout) });
http.route({
  path: "/auth/account/deletion-preview",
  method: "POST",
  handler: withCors(accountDeletionPreview),
});
http.route({ path: "/auth/account/delete", method: "POST", handler: withCors(deleteAccount) });
http.route({ path: "/auth/e2e/bootstrap", method: "POST", handler: e2eBootstrap });
http.route({
  path: "/.well-known/apple-app-site-association",
  method: "GET",
  handler: aasa,
});
http.route({ pathPrefix: "/join/", method: "GET", handler: inviteLanding });
http.route({ pathPrefix: "/join/", method: "POST", handler: withCors(inviteResolve) });
http.route({ path: "/privacy", method: "GET", handler: privacy });
http.route({ path: "/support", method: "GET", handler: support });
http.route({ path: "/terms", method: "GET", handler: terms });
http.route({ path: "/app-config", method: "GET", handler: withCors(appConfiguration) });
http.route({ path: "/card-sync/spends", method: "POST", handler: spendsHttp });
// Read-only agent access (MCP). The secret is in the link or the Authorization header.
for (const method of ["POST", "GET", "DELETE", "OPTIONS"] as const) {
  http.route({ path: "/mcp", method, handler: mcp });
  http.route({ pathPrefix: "/mcp/", method, handler: mcp });
}

// Preflight for the endpoints the web app calls from another origin (see lib/cors.ts).
for (const path of ["/auth/apple/exchange", "/auth/google/exchange", "/auth/refresh", "/auth/logout", "/auth/account/deletion-preview", "/auth/account/delete", "/app-config"]) {
  http.route({ path, method: "OPTIONS", handler: preflight });
}
http.route({ pathPrefix: "/join/", method: "OPTIONS", handler: preflight });

export default http;

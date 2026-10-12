import { httpRouter } from "convex/server";

import {
  appleExchange,
  appleNotification,
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
} from "./web";

const http = httpRouter();

http.route({ path: "/", method: "GET", handler: marketing });
http.route({ pathPrefix: "/assets/", method: "GET", handler: marketingAsset });
http.route({ path: "/auth/apple/exchange", method: "POST", handler: appleExchange });
http.route({
  path: "/auth/apple/notifications",
  method: "POST",
  handler: appleNotification,
});
http.route({ path: "/auth/refresh", method: "POST", handler: refresh });
http.route({ path: "/auth/logout", method: "POST", handler: logout });
http.route({
  path: "/auth/account/deletion-preview",
  method: "POST",
  handler: accountDeletionPreview,
});
http.route({ path: "/auth/account/delete", method: "POST", handler: deleteAccount });
http.route({ path: "/auth/e2e/bootstrap", method: "POST", handler: e2eBootstrap });
http.route({
  path: "/.well-known/apple-app-site-association",
  method: "GET",
  handler: aasa,
});
http.route({ pathPrefix: "/join/", method: "GET", handler: inviteLanding });
http.route({ pathPrefix: "/join/", method: "POST", handler: inviteResolve });
http.route({ path: "/privacy", method: "GET", handler: privacy });
http.route({ path: "/support", method: "GET", handler: support });
http.route({ path: "/app-config", method: "GET", handler: appConfiguration });

export default http;

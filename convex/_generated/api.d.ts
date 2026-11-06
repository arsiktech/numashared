/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accountDeletion from "../accountDeletion.js";
import type * as agentAccess from "../agentAccess.js";
import type * as agentData from "../agentData.js";
import type * as agentMcp from "../agentMcp.js";
import type * as apns from "../apns.js";
import type * as authSessions from "../authSessions.js";
import type * as cardSync from "../cardSync.js";
import type * as configuration from "../configuration.js";
import type * as events from "../events.js";
import type * as http from "../http.js";
import type * as identityHttp from "../identityHttp.js";
import type * as iso4217 from "../iso4217.js";
import type * as lib_agentTools from "../lib/agentTools.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_accountWriteQuota from "../lib/accountWriteQuota.js";
import type * as lib_apnsTransport from "../lib/apnsTransport.js";
import type * as lib_appendEvents from "../lib/appendEvents.js";
import type * as lib_appleIdentity from "../lib/appleIdentity.js";
import type * as lib_authConfig from "../lib/authConfig.js";
import type * as lib_budgetGroupTopology from "../lib/budgetGroupTopology.js";
import type * as lib_clientContract from "../lib/clientContract.js";
import type * as lib_cors from "../lib/cors.js";
import type * as lib_deployment from "../lib/deployment.js";
import type * as lib_environment from "../lib/environment.js";
import type * as lib_eventValidation from "../lib/eventValidation.js";
import type * as lib_financialRecordState from "../lib/financialRecordState.js";
import type * as lib_googleIdentity from "../lib/googleIdentity.js";
import type * as lib_hash from "../lib/hash.js";
import type * as lib_httpRateLimit from "../lib/httpRateLimit.js";
import type * as lib_identity from "../lib/identity.js";
import type * as lib_inviteCode from "../lib/inviteCode.js";
import type * as lib_inviteTicket from "../lib/inviteTicket.js";
import type * as lib_ios18TimeZoneIdentifiers from "../lib/ios18TimeZoneIdentifiers.js";
import type * as lib_jwt from "../lib/jwt.js";
import type * as lib_notificationMatrix from "../lib/notificationMatrix.js";
import type * as lib_redactText from "../lib/redactText.js";
import type * as lib_sessionTokens from "../lib/sessionTokens.js";
import type * as lib_uuidV7 from "../lib/uuidV7.js";
import type * as lib_webContent from "../lib/webContent.js";
import type * as members from "../members.js";
import type * as model from "../model.js";
import type * as notifications from "../notifications.js";
import type * as pots from "../pots.js";
import type * as pushQueue from "../pushQueue.js";
import type * as redaction from "../redaction.js";
import type * as web from "../web.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accountDeletion: typeof accountDeletion;
  agentAccess: typeof agentAccess;
  agentData: typeof agentData;
  agentMcp: typeof agentMcp;
  apns: typeof apns;
  authSessions: typeof authSessions;
  cardSync: typeof cardSync;
  configuration: typeof configuration;
  events: typeof events;
  http: typeof http;
  identityHttp: typeof identityHttp;
  iso4217: typeof iso4217;
  "lib/access": typeof lib_access;
  "lib/agentTools": typeof lib_agentTools;
  "lib/accountWriteQuota": typeof lib_accountWriteQuota;
  "lib/apnsTransport": typeof lib_apnsTransport;
  "lib/appendEvents": typeof lib_appendEvents;
  "lib/appleIdentity": typeof lib_appleIdentity;
  "lib/authConfig": typeof lib_authConfig;
  "lib/budgetGroupTopology": typeof lib_budgetGroupTopology;
  "lib/clientContract": typeof lib_clientContract;
  "lib/cors": typeof lib_cors;
  "lib/deployment": typeof lib_deployment;
  "lib/environment": typeof lib_environment;
  "lib/eventValidation": typeof lib_eventValidation;
  "lib/financialRecordState": typeof lib_financialRecordState;
  "lib/googleIdentity": typeof lib_googleIdentity;
  "lib/hash": typeof lib_hash;
  "lib/httpRateLimit": typeof lib_httpRateLimit;
  "lib/identity": typeof lib_identity;
  "lib/inviteCode": typeof lib_inviteCode;
  "lib/inviteTicket": typeof lib_inviteTicket;
  "lib/ios18TimeZoneIdentifiers": typeof lib_ios18TimeZoneIdentifiers;
  "lib/jwt": typeof lib_jwt;
  "lib/notificationMatrix": typeof lib_notificationMatrix;
  "lib/redactText": typeof lib_redactText;
  "lib/sessionTokens": typeof lib_sessionTokens;
  "lib/uuidV7": typeof lib_uuidV7;
  "lib/webContent": typeof lib_webContent;
  members: typeof members;
  model: typeof model;
  notifications: typeof notifications;
  pots: typeof pots;
  pushQueue: typeof pushQueue;
  redaction: typeof redaction;
  web: typeof web;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};

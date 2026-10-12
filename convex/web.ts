import { anyApi } from "convex/server";
import { v } from "convex/values";

import { httpAction, internalQuery } from "./_generated/server";
import { requireApprovedWriteTarget } from "./lib/deployment";
import {
  consumePrivacySafeRateLimits,
  trustedRequestSource,
} from "./lib/httpRateLimit";
import {
  hashInviteCode,
  isCanonicalInviteToken,
  normalizeInviteCode,
} from "./lib/inviteCode";
import {
  createInviteClaimTicket,
  readInviteTicketSecret,
} from "./lib/inviteTicket";
import { sha256Hex } from "./lib/hash";
import {
  aasaDocument,
  genericInviteHTML,
  homeAsset,
  invitePreviewHTML,
  marketingHTML,
  privacyHTML,
  readAasaConfiguration,
  readInvitePageConfiguration,
  readPrivacyPageConfiguration,
  readSupportPageConfiguration,
  supportHTML,
  type PublicInvitePreview,
} from "./lib/webContent";

declare const process: { env: Record<string, string | undefined> };

type StoredInvitePreview =
  | { status: "invalid" | "expired" | "revoked" | "used" }
  | {
    status: "active";
    inviteId: string;
    kind: "perMember" | "potLink";
    potName: string | null;
    expiresAt: number;
    minimumReaderSchemaVersion: number;
  };

type InviteCredential =
  | { kind: "code"; value: string; displayCode: string }
  | { kind: "token"; value: string; displayCode: string | null };

const htmlSecurityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

// The marketing route alone may load its own same-origin script, font and
// screenshots. Every other HTML route keeps htmlSecurityHeaders unchanged.
const marketingSecurityHeaders = {
  ...htmlSecurityHeaders,
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function unavailableResponse(): Response {
  return new Response("Numa Shared web configuration unavailable.", {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function jsonResponse(
  value: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: htmlSecurityHeaders });
}

function wantsJSON(request: Request): boolean {
  return request.headers.get("accept")?.toLowerCase().includes("application/json")
    ?? false;
}

function credentialFromRequest(request: Request): InviteCredential | null {
  const url = new URL(request.url);
  const encoded = url.pathname.slice("/join/".length);
  if (encoded.length === 0 || encoded.length > 1_536 || encoded.includes("/")) {
    return null;
  }
  try {
    const value = decodeURIComponent(encoded);
    const code = normalizeInviteCode(value);
    if (code) return { kind: "code", value: code, displayCode: code };
    if (!isCanonicalInviteToken(value)) return null;
    const pairedCode = normalizeInviteCode(url.searchParams.get("code") ?? "");
    return { kind: "token", value, displayCode: pairedCode };
  } catch {
    return null;
  }
}

export const invitePreviewByCredentialHash = internalQuery({
  args: {
    credentialKind: v.union(v.literal("code"), v.literal("token")),
    credentialHash: v.string(),
    pairedCodeHash: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<StoredInvitePreview> => {
    const matches = args.credentialKind === "code"
      ? await ctx.db
        .query("invites")
        .withIndex("by_code_hash", (index) =>
          index.eq("codeHash", args.credentialHash),
        )
        .take(2)
      : await ctx.db
        .query("invites")
        .withIndex("by_token_hash", (index) =>
          index.eq("tokenHash", args.credentialHash),
        )
        .take(2);
    if (matches.length !== 1) return { status: "invalid" };
    const invite = matches[0];
    if (
      args.credentialKind === "token"
      && (!args.pairedCodeHash || args.pairedCodeHash !== invite.codeHash)
    ) {
      return { status: "invalid" };
    }
    if (invite.status === "revoked") return { status: "revoked" };
    if (invite.status === "consumed") return { status: "used" };
    if (invite.expiresAt <= args.now) return { status: "expired" };
    const pot = await ctx.db
      .query("pots")
      .withIndex("by_pot_id", (index) => index.eq("potId", invite.potId))
      .unique();
    if (!pot || pot.minimumReaderSchemaVersion < 1n || pot.minimumReaderSchemaVersion > 65535n) {
      return { status: "invalid" };
    }
    return {
      status: "active",
      inviteId: invite.inviteId,
      kind: invite.kind,
      potName: pot.name ?? null,
      expiresAt: invite.expiresAt,
      minimumReaderSchemaVersion: Number(pot.minimumReaderSchemaVersion),
    };
  },
});

export const aasa = httpAction(async () => {
  try {
    const document = aasaDocument(readAasaConfiguration(process.env));
    return new Response(JSON.stringify(document), {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=300",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return unavailableResponse();
  }
});

export const marketing = httpAction(async () => {
  try {
    return new Response(
      marketingHTML(readSupportPageConfiguration(process.env)),
      { status: 200, headers: marketingSecurityHeaders },
    );
  } catch {
    return unavailableResponse();
  }
});

export const marketingAsset = httpAction(async (_ctx, request) => {
  const name = new URL(request.url).pathname.slice("/assets/".length);
  const asset = homeAsset(name);
  if (!asset) {
    return new Response("Not found.", {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  return new Response(asset.body, {
    status: 200,
    headers: {
      // Asset URLs carry a content hash in the page, so a day is safe.
      "Cache-Control": "public, max-age=86400",
      "Content-Type": asset.type,
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

export const inviteLanding = httpAction(async () => {
  try {
    return htmlResponse(genericInviteHTML(readInvitePageConfiguration(process.env)));
  } catch {
    return unavailableResponse();
  }
});

export const inviteResolve = httpAction(async (ctx, request) => {
  const asJSON = wantsJSON(request);
  try {
    requireApprovedWriteTarget();
    const now = Date.now();
    const credential = credentialFromRequest(request);
    const secret = readInviteTicketSecret(process.env);
    const source = await trustedRequestSource(ctx, request);
    const rateLimit = await consumePrivacySafeRateLimits(ctx, secret, [
      {
        namespace: "invite-preview-source",
        value: source,
        limit: 20n,
        windowMillis: 60_000,
      },
      {
        namespace: "invite-preview-code",
        value: credential
          ? `credential:${credential.displayCode ?? credential.value}`
          : "invalid",
        limit: 10n,
        windowMillis: 60_000,
      },
    ], now);
    if (!rateLimit.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(rateLimit.retryAfterMillis / 1_000));
      if (asJSON) {
        return jsonResponse(
          { status: "rateLimited" },
          429,
          { "Retry-After": String(retryAfterSeconds) },
        );
      }
      return new Response("Please wait and try again.", {
        status: 429,
        headers: {
          ...htmlSecurityHeaders,
          "Content-Type": "text/plain; charset=utf-8",
          "Retry-After": String(retryAfterSeconds),
        },
      });
    }

    let preview: StoredInvitePreview = { status: "invalid" };
    if (credential) {
      preview = await ctx.runQuery(anyApi.web.invitePreviewByCredentialHash, {
        credentialKind: credential.kind,
        credentialHash: credential.kind === "code"
          ? await hashInviteCode(credential.value, secret)
          : await sha256Hex(credential.value),
        ...(credential.kind === "token" && credential.displayCode
          ? { pairedCodeHash: await hashInviteCode(credential.displayCode, secret) }
          : {}),
        now,
      }) as StoredInvitePreview;
    }
    if (preview.status !== "active") {
      if (asJSON) return jsonResponse(preview);
      return htmlResponse(invitePreviewHTML(
        preview,
        readInvitePageConfiguration(process.env),
        credential?.displayCode ?? undefined,
      ));
    }

    const publicPreview: PublicInvitePreview = {
      status: "active",
      kind: preview.kind,
      potName: preview.potName,
      expiresAt: preview.expiresAt,
    };
    if (!asJSON) {
      return htmlResponse(invitePreviewHTML(
        publicPreview,
        readInvitePageConfiguration(process.env),
        credential?.displayCode ?? undefined,
      ));
    }
    return jsonResponse({
      ...publicPreview,
      minimumReaderSchemaVersion: preview.minimumReaderSchemaVersion,
      claimTicket: await createInviteClaimTicket(preview.inviteId, now, secret),
    });
  } catch {
    return unavailableResponse();
  }
});

export const privacy = httpAction(async () => {
  try {
    return htmlResponse(privacyHTML(readPrivacyPageConfiguration(process.env)));
  } catch {
    return unavailableResponse();
  }
});

export const support = httpAction(async () => {
  try {
    return htmlResponse(supportHTML(readSupportPageConfiguration(process.env)));
  } catch {
    return unavailableResponse();
  }
});

export const appConfiguration = httpAction(async (ctx) => {
  try {
    const configuration = await ctx.runQuery(anyApi.configuration.current, {});
    return jsonResponse(configuration);
  } catch {
    return unavailableResponse();
  }
});

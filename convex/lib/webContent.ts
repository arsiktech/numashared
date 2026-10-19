import { homeAssets, homeScript, homeTemplate } from "./homePage.generated";

export type AasaConfiguration = { appIdentifier: string };
/**
 * Where an invited person can get Numa Shared. Each is optional: the App Store listing once the app
 * is published, the TestFlight public link while it is in beta, and the web app.
 */
export type InvitePageConfiguration = { appStoreURL?: string; testFlightURL?: string; webAppURL?: string };
export type PrivacyPageConfiguration = {
  controllerName: string;
  controllerAddress: string;
  privacyEmail: string;
  transferMechanism: string;
};
export type SupportPageConfiguration = {
  supportEmail: string;
};

export type PublicInvitePreview =
  | { status: "invalid" | "expired" | "revoked" | "used" }
  | {
    status: "active";
    kind: "perMember" | "potLink";
    potName: string | null;
    expiresAt: number;
  };

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const appIdentifierPattern = /^[A-Z0-9]{10}\.tech\.arsik\.numashared$/;

function requiredText(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  minimumLength: number,
  maximumLength: number,
): string {
  const value = environment[name]?.trim();
  if (!value || value.length < minimumLength || value.length > maximumLength) {
    throw new Error("WEB_CONFIGURATION_INVALID");
  }
  return value;
}

/** An optional https link on one host (or under one path); unset or empty means "not offered". */
function optionalURL(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  allowed: (url: URL) => boolean,
): string | undefined {
  const value = environment[name]?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (value.length > 512 || url.protocol !== "https:" || !allowed(url)) {
      throw new Error("WEB_CONFIGURATION_INVALID");
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error("WEB_CONFIGURATION_INVALID");
  }
}

function email(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = requiredText(environment, name, 5, 254);
  if (!emailPattern.test(value)) throw new Error("WEB_CONFIGURATION_INVALID");
  return value;
}

export function readAasaConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): AasaConfiguration {
  const appIdentifier = requiredText(
    environment,
    "NUMA_SHARED_APP_IDENTIFIER",
    32,
    128,
  );
  if (!appIdentifierPattern.test(appIdentifier)) {
    throw new Error("WEB_CONFIGURATION_INVALID");
  }
  return { appIdentifier };
}

export function readInvitePageConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): InvitePageConfiguration {
  return {
    appStoreURL: optionalURL(environment, "NUMA_SHARED_APP_STORE_URL", (u) => u.hostname === "apps.apple.com"),
    testFlightURL: optionalURL(environment, "NUMA_SHARED_TESTFLIGHT_URL",
      (u) => u.hostname === "testflight.apple.com" && u.pathname.startsWith("/join/")),
    webAppURL: optionalURL(environment, "NUMA_SHARED_WEB_APP_URL", () => true),
  };
}

/**
 * The ways to get going from an invite: the web app (with the code filled in), then the iPhone app
 * from TestFlight while in beta, else from the App Store.
 */
function inviteActions(configuration: InvitePageConfiguration, inviteCode?: string): string {
  const out: string[] = [];
  if (configuration.webAppURL) {
    const href = `${configuration.webAppURL}/join${inviteCode ? `?code=${encodeURIComponent(inviteCode)}` : ""}`;
    out.push(`<a class="button" rel="noopener noreferrer" href="${escapeHTML(href)}">Open in your browser</a>`);
  }
  if (configuration.testFlightURL) {
    out.push(`<a class="button secondary" rel="noopener noreferrer" href="${escapeHTML(configuration.testFlightURL)}">Get the iPhone app (TestFlight beta)</a>`);
  } else if (configuration.appStoreURL) {
    out.push(`<a class="button secondary" rel="noopener noreferrer" href="${escapeHTML(configuration.appStoreURL)}">Get Numa Shared on the App Store</a>`);
  }
  return out.length ? `<p class="actions">${out.join(" ")}</p>` : "";
}

export function readPrivacyPageConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): PrivacyPageConfiguration {
  return {
    controllerName: requiredText(
      environment,
      "NUMA_SHARED_CONTROLLER_NAME",
      2,
      160,
    ),
    controllerAddress: requiredText(
      environment,
      "NUMA_SHARED_CONTROLLER_ADDRESS",
      4,
      240,
    ),
    privacyEmail: email(environment, "NUMA_SHARED_PRIVACY_EMAIL"),
    transferMechanism: requiredText(
      environment,
      "NUMA_SHARED_TRANSFER_MECHANISM",
      10,
      320,
    ),
  };
}

export function readSupportPageConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): SupportPageConfiguration {
  return {
    supportEmail: email(environment, "NUMA_SHARED_SUPPORT_EMAIL"),
  };
}

function escapeHTML(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(args: {
  title: string;
  description: string;
  body: string;
  head?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHTML(args.title)}</title>
<meta name="description" content="${escapeHTML(args.description)}">
${args.head ?? ""}
<style>
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;background:#f5f2eb;color:#292722}*{box-sizing:border-box}body{margin:0;padding:40px 20px;overflow-wrap:anywhere}main{max-width:680px;margin:0 auto;background:#fffdf8;border:1px solid #ddd7ca;border-radius:24px;padding:32px;box-shadow:0 12px 40px #29272212}h1,h2{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif;letter-spacing:-.02em}h1{font-size:2rem;margin-top:0}h2{margin-top:2rem}p,li{font-size:1.04rem;line-height:1.55}a,button{color:inherit;font-weight:650}button,.button{display:inline-block;border:1px solid #292722;border-radius:999px;background:#292722;color:#fffdf8;padding:12px 18px;text-decoration:none;font:inherit;font-weight:650;cursor:pointer}.actions{display:flex;flex-wrap:wrap;gap:10px}.button.secondary{background:transparent;color:inherit}small{color:#686258}a:focus-visible,button:focus-visible{outline:3px solid currentColor;outline-offset:5px}@media(max-width:480px){body{padding:20px 16px}main{padding:24px}}@media(prefers-color-scheme:dark){:root{background:#1c1b18;color:#f4f0e7}main{background:#24221e;border-color:#454139}small{color:#bdb8ae}.button,button{background:#f4f0e7;color:#24221e;border-color:#f4f0e7}.button.secondary{background:transparent;color:#f4f0e7}}
</style>
</head>
<body><main>${args.body}</main></body>
</html>`;
}

export function aasaDocument(configuration: AasaConfiguration) {
  return {
    applinks: {
      apps: [] as never[],
      details: [{
        appIDs: [configuration.appIdentifier],
        components: [{
          "/": "/join/*",
          caseSensitive: false,
          comment: "Matches Numa Shared invite links only.",
        }],
      }],
    },
  };
}

export function marketingHTML(
  configuration: SupportPageConfiguration,
): string {
  // The home page is authored in web-home/ and generated into homePage.generated.ts
  // (npm run build:home). Only the support address is substituted at request time.
  return homeTemplate.replaceAll(
    "{{SUPPORT_EMAIL}}",
    escapeHTML(configuration.supportEmail),
  );
}

export type HomeAsset = { type: string; body: ArrayBuffer };

const homeAssetCache = new Map<string, HomeAsset>();

/** Static files for the marketing route. Only these exact names are served. */
export function homeAsset(name: string): HomeAsset | null {
  const cached = homeAssetCache.get(name);
  if (cached) return cached;
  let asset: HomeAsset | null = null;
  if (name === "home.js") {
    asset = {
      type: "text/javascript; charset=utf-8",
      body: new TextEncoder().encode(homeScript).buffer as ArrayBuffer,
    };
  } else if (Object.prototype.hasOwnProperty.call(homeAssets, name)) {
    const stored = homeAssets[name];
    const binary = atob(stored.base64);
    const body = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      body[index] = binary.charCodeAt(index);
    }
    asset = { type: stored.type, body: body.buffer as ArrayBuffer };
  }
  if (asset) homeAssetCache.set(name, asset);
  return asset;
}

export function genericInviteHTML(
  configuration: InvitePageConfiguration,
  inviteCode?: string,
): string {
  return page({
    title: "Numa Shared invite",
    description: "A private invitation to share household expenses in Numa Shared.",
    head: `<meta property="og:title" content="Numa Shared invite">
<meta property="og:description" content="A private invitation to share household expenses in Numa Shared.">
<meta property="og:type" content="website">
<meta name="robots" content="noindex,nofollow">`,
    body: `<h1>Numa Shared invite</h1>
<p>Someone invited you to a shared pot. Details stay private until you choose to view them.</p>
<form method="post"><button type="submit">View invite</button></form>
${inviteActions(configuration, inviteCode)}
<small>If the app is already installed, return to the message and tap the invite link again. You can also enter the six-character code in Join.</small>`,
  });
}

export function invitePreviewHTML(
  preview: PublicInvitePreview,
  configuration: InvitePageConfiguration,
  inviteCode?: string,
): string {
  let heading: string;
  let detail: string;
  let codeInstruction = "";
  if (preview.status === "active") {
    heading = preview.potName ? `Join ${preview.potName}` : "Join a shared pot";
    detail = preview.kind === "potLink"
      ? "This link needs the pot owner’s approval before any history becomes visible."
      : "This private invite can be claimed once.";
    if (inviteCode) {
      codeInstruction = `<p>Enter <strong>${escapeHTML(inviteCode)}</strong> in Join after installing.</p>`;
    }
  } else if (preview.status === "expired") {
    heading = "This invite expired";
    detail = "Ask the pot owner for a new invite.";
  } else if (preview.status === "revoked") {
    heading = "This invite is no longer active";
    detail = "Ask the pot owner for a new invite.";
  } else if (preview.status === "used") {
    heading = "This invite was already used";
    detail = "Open Numa Shared on the device that joined, or ask the pot owner for help.";
  } else {
    heading = "This invite isn’t valid";
    detail = "Ask the pot owner for a new invite.";
  }
  return page({
    title: heading,
    description: "Numa Shared invite status.",
    body: `<h1>${escapeHTML(heading)}</h1><p>${escapeHTML(detail)}</p>${codeInstruction}
${preview.status === "active" ? inviteActions(configuration, inviteCode) : ""}`,
  });
}

export function privacyHTML(configuration: PrivacyPageConfiguration): string {
  const controller = escapeHTML(configuration.controllerName);
  const address = escapeHTML(configuration.controllerAddress);
  const contact = escapeHTML(configuration.privacyEmail);
  // The configured legal phrase may already be sentence-final. Normalize only
  // duplicate terminal periods so the template cannot publish `..`.
  const transfer = escapeHTML(configuration.transferMechanism).replace(/\.+$/u, "");
  return page({
    title: "Numa Shared privacy policy",
    description: "How Numa Shared handles personal data.",
    body: `<h1>Privacy policy</h1><p><small>Last updated 15 July 2026</small></p>
<p>Numa Shared records shared household expenses. It does not move money, connect to bank accounts, sell data, or use data for advertising.</p>
<h2>Controller and contact</h2><p>${controller}, ${address}, is responsible for this service. Privacy requests: <a href="mailto:${contact}">${contact}</a>.</p>
<h2>Data used</h2><ul><li>Sign in with Apple account identifier and relay email, when Apple provides it.</li><li>Pot membership, display names, expense and settlement records, and free text entered by members.</li><li>Device push token, notification preference, and security/session records needed to operate sync.</li><li>Crash diagnostics only under the build and consent settings disclosed in the app.</li></ul>
<h2>Why and how long</h2><p>Data is used only for account access, shared-pot sync, invitations, notifications, support, security, and legal compliance. Identifiers, authored free text, and push tokens are removed or redacted through account deletion. Shared arithmetic may remain for other members as their legitimate shared record. A sole-member pot is deleted.</p>
<h2>Processors and transfers</h2><p>Convex provides the hosted database and functions. International transfers use ${transfer}. The controller keeps processor terms and transfer safeguards under review.</p>
<h2>Your choices and rights</h2><p>You can export your data, hide amounts on this device, mute a pot, sign out, and delete your account in the app. Depending on where you live, you may also request access, correction, erasure, restriction, portability, or object to processing. Pending-member names supplied by another person can also be anonymized after a verified request.</p>
<h2>Age and tracking</h2><p>Accounts are for people aged 13 or older, subject to a higher local minimum where required. No advertising or cross-app tracking is used.</p>`,
  });
}

export function supportHTML(configuration: SupportPageConfiguration): string {
  const email = escapeHTML(configuration.supportEmail);
  return page({
    title: "Numa Shared support",
    description: "Help with Numa Shared.",
    body: `<h1>Support</h1>
<p>Numa Shared never moves money. It records what household members say happened and derives who owes whom.</p>
<h2>Invite trouble</h2><p>Expired, revoked, or already-used links cannot be reopened. Ask the pot owner for a new invite. A pot link still needs owner approval before history appears.</p>
<h2>Edit or settle</h2><p>Editing corrects a record and keeps the correction visible in history. Settling records a payment made somewhere else; Numa Shared does not send that payment.</p>
<h2>Balances and spending</h2><p>Balances show who owes whom after shared expenses and recorded settlements. Spending reports summarize expense records; they do not say that money moved between members.</p>
<h2>Leaving a pot</h2><p>Resolve or acknowledge any remaining balance first. If you are the owner, transfer ownership before leaving. Your member remains archived in the shared history so past arithmetic does not change.</p>
<h2>Lost phone or sign-in trouble</h2><p>Use the device passcode and Find My erase for a lost phone. Sign in with the same Apple account to restore synced pots. Never send invite tokens, device tokens, or Apple credentials by email.</p>
<h2>Export after removal</h2><p>A removed member keeps a frozen, read-only local snapshot through the removal event and can export that snapshot from the device. Later pot activity is not included.</p>
<h2>Contact</h2><p><a class="button" href="mailto:${email}?subject=Numa%20Shared%20support">Email ${email}</a></p>
<p><a href="/">Back to Numa Shared</a></p>`,
  });
}

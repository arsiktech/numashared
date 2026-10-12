import { hashIdentityRateKey, secureStringEqual } from "./identity";

const ticketLifetimeMillis = 10 * 60_000;
const inviteIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const signaturePattern = /^[A-Za-z0-9_-]{43}$/;

export type InviteClaimTicketProof = {
  inviteId: string;
  expiresAt: number;
  isFresh: boolean;
};

export function isInviteClaimTicketId(value: string): boolean {
  return inviteIdPattern.test(value);
}

export function readInviteTicketSecret(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const secret = environment.NUMA_SHARED_TOKEN_HASH_SECRET;
  if (!secret || secret.length < 32 || secret.length > 1_024) {
    throw new Error("INVITE_TICKET_CONFIGURATION_INVALID");
  }
  return secret;
}

function encodeInviteId(inviteId: string): string {
  const bytes = new TextEncoder().encode(inviteId);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeInviteId(encoded: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const inviteId = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return isInviteClaimTicketId(inviteId) ? inviteId : null;
  } catch {
    return null;
  }
}

async function ticketSignature(
  encodedInviteId: string,
  expiresAt: number,
  secret: string,
): Promise<string> {
  return await hashIdentityRateKey(
    "invite-claim-ticket-v1",
    `${encodedInviteId}\u0000${expiresAt}`,
    secret,
  );
}

export async function createInviteClaimTicket(
  inviteId: string,
  nowMillis: number,
  secret: string,
): Promise<string> {
  if (
    !isInviteClaimTicketId(inviteId)
    || !Number.isSafeInteger(nowMillis)
    || secret.length < 32
    || secret.length > 1_024
  ) {
    throw new Error("INVITE_TICKET_CONFIGURATION_INVALID");
  }
  const expiresAt = nowMillis + ticketLifetimeMillis;
  const encodedInviteId = encodeInviteId(inviteId);
  const signature = await ticketSignature(encodedInviteId, expiresAt, secret);
  return `${encodedInviteId}.${expiresAt}.${signature}`;
}

export async function verifyInviteClaimTicket(
  ticket: string,
  nowMillis: number,
  secret: string,
): Promise<string | null> {
  const proof = await verifyInviteClaimTicketProof(ticket, nowMillis, secret);
  return proof?.isFresh ? proof.inviteId : null;
}

export async function verifyInviteClaimTicketProof(
  ticket: string,
  nowMillis: number,
  secret: string,
): Promise<InviteClaimTicketProof | null> {
  if (
    ticket.length > 512
    || !Number.isSafeInteger(nowMillis)
    || secret.length < 32
    || secret.length > 1_024
  ) {
    return null;
  }
  const parts = ticket.split(".");
  if (parts.length !== 3) return null;
  const [encodedInviteId, encodedExpiresAt, signature] = parts;
  if (!/^\d{13}$/.test(encodedExpiresAt) || !signaturePattern.test(signature)) {
    return null;
  }
  const expiresAt = Number(encodedExpiresAt);
  if (
    !Number.isSafeInteger(expiresAt)
    || expiresAt > nowMillis + ticketLifetimeMillis
  ) {
    return null;
  }
  const inviteId = decodeInviteId(encodedInviteId);
  if (!inviteId) return null;
  const expected = await ticketSignature(encodedInviteId, expiresAt, secret);
  if (!secureStringEqual(signature, expected)) return null;
  return { inviteId, expiresAt, isFresh: expiresAt > nowMillis };
}

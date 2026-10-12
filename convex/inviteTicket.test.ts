import { describe, expect, test } from "vitest";

import { sha256Hex } from "./lib/hash";
import {
  hashInviteCode,
  isCanonicalInviteCode,
  isCanonicalInviteToken,
  normalizeInviteCode,
} from "./lib/inviteCode";
import {
  createInviteClaimTicket,
  readInviteTicketSecret,
  verifyInviteClaimTicket,
  verifyInviteClaimTicketProof,
} from "./lib/inviteTicket";

const nowMillis = 1_750_000_000_000;
const inviteId = "01890f5e-7b00-7000-9000-000000000001";
const secret = "invite-ticket-test-secret-at-least-32-bytes";

describe("typed invite credential contract", () => {
  test("normalizes human entry but requires canonical issuance", () => {
    expect(normalizeInviteCode("ab-c123")).toBe("ABC123");
    expect(normalizeInviteCode(" AB C123 ")).toBe("ABC123");
    expect(normalizeInviteCode("too-short")).toBeNull();
    expect(normalizeInviteCode("ABC12!")).toBeNull();
    expect(isCanonicalInviteCode("ABC123")).toBe(true);
    expect(isCanonicalInviteCode("abc123")).toBe(false);
    expect(isCanonicalInviteToken("link-token-0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isCanonicalInviteToken("link/token/0123456789abcdef0123456789abcdef")).toBe(false);
  });

  test("uses a deployment-secret HMAC for low-entropy invite codes", async () => {
    const code = "ABC123";
    const otherSecret = "other-invite-code-secret-at-least-32-bytes";
    await expect(hashInviteCode(code, secret)).resolves.not.toBe(
      await sha256Hex(code),
    );
    await expect(hashInviteCode(code, secret)).resolves.not.toBe(
      await hashInviteCode(code, otherSecret),
    );
  });

  test("accepts a signed ticket for less than ten minutes, then expires it", async () => {
    const ticket = await createInviteClaimTicket(inviteId, nowMillis, secret);
    await expect(verifyInviteClaimTicket(ticket, nowMillis, secret))
      .resolves.toBe(inviteId);
    await expect(verifyInviteClaimTicket(ticket, nowMillis + 10 * 60_000 - 1, secret))
      .resolves.toBe(inviteId);
    await expect(verifyInviteClaimTicket(ticket, nowMillis + 10 * 60_000, secret))
      .resolves.toBeNull();
    await expect(verifyInviteClaimTicketProof(
      ticket,
      nowMillis + 10 * 60_000,
      secret,
    )).resolves.toEqual({
      inviteId,
      expiresAt: nowMillis + 10 * 60_000,
      isFresh: false,
    });
  });

  test("rejects tampering, a different secret, and malformed configuration", async () => {
    const ticket = await createInviteClaimTicket(inviteId, nowMillis, secret);
    const [encodedInviteId, expiry, signature] = ticket.split(".");
    for (const candidate of [
      `${encodedInviteId}x.${expiry}.${signature}`,
      `${encodedInviteId}.${Number(expiry) + 1}.${signature}`,
      `${encodedInviteId}.${expiry}.${signature.slice(0, -1)}A`,
      "not-a-ticket",
    ]) {
      await expect(verifyInviteClaimTicket(candidate, nowMillis, secret))
        .resolves.toBeNull();
    }
    await expect(verifyInviteClaimTicket(
      ticket,
      nowMillis,
      "different-ticket-secret-at-least-32-bytes",
    )).resolves.toBeNull();
    expect(() => readInviteTicketSecret({})).toThrow(
      "INVITE_TICKET_CONFIGURATION_INVALID",
    );
  });
});

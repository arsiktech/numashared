import { hashIdentityRateKey } from "./identity";

const canonicalInviteCodePattern = /^[A-Z0-9]{6}$/;
const canonicalInviteTokenPattern = /^[A-Za-z0-9_-]{32,512}$/;

export function normalizeInviteCode(value: string): string | null {
  if (value.length < 6 || value.length > 32) return null;
  const normalized = value.trim().replace(/[\s-]/g, "").toUpperCase();
  return canonicalInviteCodePattern.test(normalized) ? normalized : null;
}

export function isCanonicalInviteCode(value: string): boolean {
  return canonicalInviteCodePattern.test(value);
}

export function isCanonicalInviteToken(value: string): boolean {
  return canonicalInviteTokenPattern.test(value);
}

export async function hashInviteCode(code: string, secret: string): Promise<string> {
  if (
    !isCanonicalInviteCode(code)
    || secret.length < 32
    || secret.length > 1_024
  ) {
    throw new Error("INVITE_CODE_CONFIGURATION_INVALID");
  }
  return await hashIdentityRateKey("invite-code-v1", code, secret);
}

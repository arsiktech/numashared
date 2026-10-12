// SHA-256 hex digest for high-entropy values such as invite link tokens. Low-entropy
// typed invite codes use a deployment-secret HMAC instead (lib/inviteCode.ts).
export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// SHA-256 hex digest for high-entropy values such as invite link tokens. Low-entropy
// typed invite codes use a deployment-secret HMAC instead (lib/inviteCode.ts). The
// identity code passes its own crypto provider, as it does for every primitive.
export async function sha256Hex(value: string, cryptoProvider: Crypto = crypto): Promise<string> {
  const digest = new Uint8Array(
    await cryptoProvider.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

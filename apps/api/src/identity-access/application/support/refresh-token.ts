import { createHash, randomBytes } from "node:crypto";

/** 256 bits of CSPRNG output. Guessing is not a threat this design has to defend against. */
const REFRESH_TOKEN_BYTES = 32;

export interface GeneratedRefreshToken {
  /** Returned to the client exactly once, in a cookie. Never persisted, logged or echoed. */
  readonly token: string;
  readonly tokenHash: Uint8Array;
}

/**
 * SHA-256 rather than Argon2id, deliberately. The token is high-entropy random material, so
 * there is no small search space for a memory-hard function to protect, and the digest must
 * be deterministic: a per-row salt would make it impossible to find a session by its token.
 */
export function hashRefreshToken(token: string): Uint8Array {
  return createHash("sha256").update(token, "utf8").digest();
}

export function generateRefreshToken(): GeneratedRefreshToken {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");

  return { token, tokenHash: hashRefreshToken(token) };
}

import { Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { argon2id, hash, needsRehash, verify } from "argon2";
import type { PasswordHasher } from "../../../application/contracts/password-hasher";

/**
 * OWASP's current Argon2id baseline: 19 MiB of memory, two passes, one lane. Memory is the
 * parameter that actually costs an attacker with GPUs, so it is raised before time cost.
 */
const ARGON2_PARAMETERS = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class Argon2PasswordHasher implements PasswordHasher {
  /**
   * A hash of ephemeral random material, computed once per process. No password can match
   * it and it is never persisted, so verifying against it is pure timing equalization
   * rather than a credential of any kind.
   */
  private decoyHash: Promise<string> | undefined;

  async hash(password: string): Promise<string> {
    return hash(password, ARGON2_PARAMETERS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      // A stored value argon2 cannot parse is a failed verification, not a 500. Surfacing
      // it would tell a client that this particular account is special.
      return false;
    }
  }

  async verifyDecoy(password: string): Promise<void> {
    await this.verify(await this.resolveDecoyHash(), password);
  }

  needsRehash(passwordHash: string): boolean {
    try {
      return needsRehash(passwordHash, ARGON2_PARAMETERS);
    } catch {
      return true;
    }
  }

  private async resolveDecoyHash(): Promise<string> {
    this.decoyHash ??= this.hash(randomBytes(32).toString("base64url"));

    return this.decoyHash;
  }
}

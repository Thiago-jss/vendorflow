import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";

/**
 * Bounds memory when an attacker sprays unique addresses. Reached only after pruning, and
 * eviction is oldest-first, so a flood of fresh keys cannot starve a genuinely locked one
 * before its window elapses.
 */
const MAXIMUM_TRACKED_ACCOUNTS = 100_000;

interface AttemptWindow {
  failures: number;
  windowEndsAt: number;
}

export interface FailedLoginAttemptLimiterOptions {
  readonly maximumFailedAttempts: number;
  readonly windowMilliseconds: number;
  readonly now?: () => number;
}

/**
 * Per-account failed-login limit, complementing the source-address limit that
 * `@nestjs/throttler` applies at the HTTP edge. An address limit alone does not stop a
 * distributed password-spray against one account.
 *
 * PROCESS-LOCAL AND DELIBERATELY SO FOR THIS SLICE. Counters live in this process's heap,
 * so they are correct for exactly one API instance and are lost on restart. A second
 * instance would multiply the effective allowance by the number of instances. Replacing
 * this with a Redis-backed counter is a prerequisite for horizontal API scaling; see
 * docs/architecture/authentication-session-security.md.
 */
@Injectable()
export class FailedLoginAttemptLimiter {
  private readonly windows = new Map<string, AttemptWindow>();
  private readonly maximumFailedAttempts: number;
  private readonly windowMilliseconds: number;
  private readonly now: () => number;

  constructor(options: FailedLoginAttemptLimiterOptions) {
    this.maximumFailedAttempts = options.maximumFailedAttempts;
    this.windowMilliseconds = options.windowMilliseconds;
    this.now = options.now ?? Date.now;
  }

  isLocked(normalizedEmail: string): boolean {
    const window = this.readWindow(normalizedEmail);

    return (
      window !== undefined && window.failures >= this.maximumFailedAttempts
    );
  }

  /**
   * Recorded for every failed login, including one for an address that does not exist.
   * Counting only real accounts would make the lockout itself an enumeration oracle.
   */
  recordFailure(normalizedEmail: string): void {
    const key = this.keyOf(normalizedEmail);
    const existing = this.readWindow(normalizedEmail);

    if (existing === undefined) {
      this.prune();
      this.windows.set(key, {
        failures: 1,
        windowEndsAt: this.now() + this.windowMilliseconds,
      });
      return;
    }

    existing.failures += 1;
  }

  /** A successful login clears only this account's counter, never another account's. */
  reset(normalizedEmail: string): void {
    this.windows.delete(this.keyOf(normalizedEmail));
  }

  /**
   * The address never enters the map. A heap dump or a future diagnostic dump of this
   * structure must not become a list of the product's account addresses (SEC-009).
   */
  private keyOf(normalizedEmail: string): string {
    return createHash("sha256").update(normalizedEmail, "utf8").digest("hex");
  }

  private readWindow(normalizedEmail: string): AttemptWindow | undefined {
    const key = this.keyOf(normalizedEmail);
    const window = this.windows.get(key);

    if (window === undefined) {
      return undefined;
    }

    if (window.windowEndsAt <= this.now()) {
      this.windows.delete(key);
      return undefined;
    }

    return window;
  }

  private prune(): void {
    const now = this.now();

    for (const [key, window] of this.windows) {
      if (window.windowEndsAt <= now) {
        this.windows.delete(key);
      }
    }

    for (const key of this.windows.keys()) {
      if (this.windows.size <= MAXIMUM_TRACKED_ACCOUNTS) {
        break;
      }

      this.windows.delete(key);
    }
  }
}

/**
 * Bounds memory when a caller sprays unique keys (distinct IPs, distinct principals).
 * Reached only after pruning, and eviction is oldest-first, so a flood of fresh keys cannot
 * starve a genuinely throttled one before its window elapses. Mirrors
 * `FailedLoginAttemptLimiter`'s bound for the same reason.
 */
const MAXIMUM_TRACKED_KEYS = 100_000;

interface Window {
  hits: number;
  windowEndsAt: number;
}

export interface FixedWindowRateLimiterOptions {
  readonly limit: number;
  readonly windowMilliseconds: number;
  readonly now?: () => number;
}

/**
 * A process-local, fixed-window hit counter keyed by an arbitrary string.
 *
 * Generalizes the counting half of `FailedLoginAttemptLimiter` so a caller with a dimension
 * that is not "failed login by account" — a source address, an authenticated principal — can
 * get the same bounded, self-pruning counter without duplicating it.
 *
 * PROCESS-LOCAL AND DELIBERATELY SO FOR THIS SLICE. Counters live in this process's heap, so
 * they are correct for exactly one API instance and are lost on restart. A second instance
 * would multiply the effective allowance by the number of instances; a distributed counter
 * (e.g. Redis-backed) is a prerequisite for horizontal API scaling.
 */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly limit: number;
  private readonly windowMilliseconds: number;
  private readonly now: () => number;

  constructor(options: FixedWindowRateLimiterOptions) {
    this.limit = options.limit;
    this.windowMilliseconds = options.windowMilliseconds;
    this.now = options.now ?? Date.now;
  }

  /**
   * Records one hit against `key` and reports whether the caller is still within budget.
   * Always increments, even once the budget is spent, so a caller that keeps calling after
   * being refused does not get a fresh window by coincidence of timing.
   */
  hit(key: string): { readonly allowed: boolean } {
    const existing = this.readWindow(key);

    if (existing === undefined) {
      this.prune();
      this.windows.set(key, {
        hits: 1,
        windowEndsAt: this.now() + this.windowMilliseconds,
      });
      return { allowed: this.limit >= 1 };
    }

    existing.hits += 1;
    return { allowed: existing.hits <= this.limit };
  }

  private readWindow(key: string): Window | undefined {
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
      if (this.windows.size <= MAXIMUM_TRACKED_KEYS) {
        break;
      }

      this.windows.delete(key);
    }
  }
}

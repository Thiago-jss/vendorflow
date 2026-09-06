import { createHash } from "node:crypto";
import { FailedLoginAttemptLimiter } from "./failed-login-attempt-limiter";

describe("FailedLoginAttemptLimiter", () => {
  const email = "employee@example.com";
  let currentTime = 1_000_000;

  function buildLimiter(): FailedLoginAttemptLimiter {
    return new FailedLoginAttemptLimiter({
      maximumFailedAttempts: 5,
      windowMilliseconds: 900_000,
      now: () => currentTime,
    });
  }

  beforeEach(() => {
    currentTime = 1_000_000;
  });

  it("allows attempts until the configured failure count is reached", () => {
    const limiter = buildLimiter();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      limiter.recordFailure(email);
      expect(limiter.isLocked(email)).toBe(false);
    }

    limiter.recordFailure(email);
    expect(limiter.isLocked(email)).toBe(true);
  });

  it("limits each account independently", () => {
    const limiter = buildLimiter();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.recordFailure(email);
    }

    expect(limiter.isLocked(email)).toBe(true);
    expect(limiter.isLocked("other@example.com")).toBe(false);
  });

  it("releases the account once the window elapses", () => {
    const limiter = buildLimiter();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.recordFailure(email);
    }

    currentTime += 899_999;
    expect(limiter.isLocked(email)).toBe(true);

    currentTime += 2;
    expect(limiter.isLocked(email)).toBe(false);
  });

  it("resets only the account that authenticated successfully", () => {
    const limiter = buildLimiter();
    const other = "other@example.com";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.recordFailure(email);
      limiter.recordFailure(other);
    }

    limiter.reset(email);

    expect(limiter.isLocked(email)).toBe(false);
    expect(limiter.isLocked(other)).toBe(true);
  });

  it("starts a fresh window after a reset rather than resuming the old count", () => {
    const limiter = buildLimiter();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      limiter.recordFailure(email);
    }

    limiter.reset(email);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      limiter.recordFailure(email);
      expect(limiter.isLocked(email)).toBe(false);
    }
  });

  it("keys its state by a digest, so the address itself never enters the map", () => {
    const limiter = buildLimiter();
    limiter.recordFailure(email);

    const keys = Array.from(
      (limiter as unknown as { windows: Map<string, unknown> }).windows.keys(),
    );

    expect(keys).toEqual([
      createHash("sha256").update(email, "utf8").digest("hex"),
    ]);
    expect(keys.join()).not.toContain("example.com");
  });

  it("does not accumulate state for accounts whose window has elapsed", () => {
    const limiter = buildLimiter();
    const windows = (limiter as unknown as { windows: Map<string, unknown> })
      .windows;

    for (let account = 0; account < 50; account += 1) {
      limiter.recordFailure(`sprayed-${account}@example.com`);
    }

    expect(windows.size).toBe(50);

    currentTime += 900_001;
    limiter.recordFailure("one-more@example.com");

    expect(windows.size).toBe(1);
  });
});

import { nextPublishAttemptAt, publishRetryDelayMs } from "./publish-backoff";

describe("publishRetryDelayMs", () => {
  const base = { baseDelayMs: 1_000, maxDelayMs: 60_000 };

  it("doubles with each attempt", () => {
    const delays = [1, 2, 3, 4].map((attemptCount) =>
      publishRetryDelayMs({ ...base, attemptCount, random: () => 1 })
    );

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it("stops doubling at the ceiling", () => {
    expect(publishRetryDelayMs({ ...base, attemptCount: 20, random: () => 1 })).toBe(60_000);
  });

  it("never collapses a long backoff into an immediate retry", () => {
    // Full jitter would allow ~0 here, which turns a broker outage into a hot loop.
    expect(publishRetryDelayMs({ ...base, attemptCount: 6, random: () => 0 })).toBe(16_000);
  });

  it("spreads recovering retries across the upper half of the interval", () => {
    const early = publishRetryDelayMs({ ...base, attemptCount: 4, random: () => 0 });
    const late = publishRetryDelayMs({ ...base, attemptCount: 4, random: () => 1 });

    expect(early).toBe(4_000);
    expect(late).toBe(8_000);
  });

  it("treats a zeroth attempt as the first", () => {
    expect(publishRetryDelayMs({ ...base, attemptCount: 0, random: () => 1 })).toBe(1_000);
  });
});

describe("nextPublishAttemptAt", () => {
  it("returns an instant in the future, measured from the given clock", () => {
    const now = new Date("2026-09-09T12:00:00.000Z");
    const next = nextPublishAttemptAt({
      attemptCount: 1,
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
      now,
      random: () => 1
    });

    expect(next.toISOString()).toBe("2026-09-09T12:00:01.000Z");
  });
});

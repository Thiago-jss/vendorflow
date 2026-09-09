/**
 * REL-006's "retried with backoff", as arithmetic rather than as an intention.
 *
 * Exponential in the attempt number and capped, with jitter over the upper half of the
 * interval. The jitter matters more than the curve here: without it, a broker that recovers
 * after an outage receives every parked message's retry in the same millisecond, which is how
 * a recovery turns into a second outage. Keeping the floor at half the interval stops jitter
 * from collapsing a long backoff into an immediate retry.
 *
 * `random` is a parameter so the curve can be asserted rather than sampled.
 */
export function publishRetryDelayMs(input: {
  readonly attemptCount: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly random?: () => number;
}): number {
  const exponent = Math.max(input.attemptCount - 1, 0);
  const uncapped = input.baseDelayMs * 2 ** Math.min(exponent, 30);
  const capped = Math.min(uncapped, input.maxDelayMs);
  const random = input.random ?? Math.random;

  return Math.round(capped / 2 + random() * (capped / 2));
}

export function nextPublishAttemptAt(input: {
  readonly attemptCount: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly now?: Date;
  readonly random?: () => number;
}): Date {
  const now = input.now ?? new Date();

  return new Date(now.getTime() + publishRetryDelayMs(input));
}

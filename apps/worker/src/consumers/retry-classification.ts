/**
 * Which retry tiers this message has already served, read from RabbitMQ's own dead-letter
 * bookkeeping.
 *
 * When a queue dead-letters a message, RabbitMQ writes an `x-death` entry naming the queue it
 * died in and why. That entry is written by the broker that actually performed the delay, which
 * is why it is trustworthy in a way a counter this worker maintained would not be: a consumer
 * that died between republishing and acknowledging would replay its own count, and one that
 * died before writing it would reset the ladder to zero and retry forever.
 *
 * **The tier is read from the queue name, not from a running total**, and that is a deliberate
 * correction rather than a stylistic choice. RabbitMQ 4 discards a client-supplied `x-death`
 * when a message is published again: after a second delay the header contains only the second
 * retry queue's entry, and the first is gone. Summing counts therefore reports "one completed
 * cycle" forever and the ladder never escalates — the message loops on tier two until something
 * else stops it. Naming the tier in the queue means each pass is self-describing, and the one
 * entry the broker keeps is exactly the one that matters.
 *
 * Taking the highest tier rather than the only tier costs nothing and keeps the reading correct
 * on a broker that *does* accumulate the array.
 *
 * Unrecognized `x-death` shapes count as no completed tiers rather than throwing. Miscounting
 * costs at most an extra retry; refusing to parse would send a legitimate message to the
 * dead-letter queue over a header.
 */
export function completedRetryTiers(
  headers: unknown,
  retryQueues: readonly string[],
): number {
  if (typeof headers !== "object" || headers === null) {
    return 0;
  }

  const deaths = (headers as Record<string, unknown>)["x-death"];

  if (!Array.isArray(deaths)) {
    return 0;
  }

  return deaths.reduce<number>((highest, entry) => {
    if (typeof entry !== "object" || entry === null) {
      return highest;
    }

    const queue = (entry as Record<string, unknown>)["queue"];

    if (typeof queue !== "string") {
      return highest;
    }

    // A tier's position in the ladder is its identity: having come out of the second retry
    // queue means two delays have been served, whatever the array says about the first.
    const tier = retryQueues.indexOf(queue);

    return tier === -1 ? highest : Math.max(highest, tier + 1);
  }, 0);
}

export type RetryDecision =
  | { readonly kind: "retry"; readonly tier: number }
  | { readonly kind: "dead-letter" };

/**
 * REL-006's bounded attempts. Tiers already served choose the next one; running out of tiers is
 * terminal, and terminal means the dead-letter queue, never a silent drop and never another lap
 * around the ladder.
 */
export function classifyRetry(
  completedTiers: number,
  tierCount: number,
): RetryDecision {
  if (completedTiers >= tierCount) {
    return { kind: "dead-letter" };
  }

  return { kind: "retry", tier: completedTiers };
}

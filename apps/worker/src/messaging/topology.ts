import type { ConfirmChannel } from "amqplib";

/**
 * The whole RabbitMQ topology, in one place, declared identically by whoever connects first.
 *
 * Shape, and why each object earns its place (ADR-003):
 *
 * ```
 *                    publish (topic, routing key = event type)
 *   relay ─────────────────────────────► <prefix>.events ──► <prefix>.purchase-request-events
 *                                              ▲                        │ consumer failure
 *                    TTL expiry ───────────────┘                        ▼
 *   <prefix>.events.retry.1 ──► …retry.1 queue (10s) ─────┐   republish to the next tier
 *   <prefix>.events.retry.2 ──► …retry.2 queue (60s) ─────┼──────────────┘
 *   <prefix>.events.retry.3 ──► …retry.3 queue (300s) ────┘
 *                                                             exhausted / poison
 *   <prefix>.events.dlx ──────► <prefix>.purchase-request-events.dlq ◄──────┘
 * ```
 *
 * **One exchange per retry tier, rather than one retry exchange with tier-specific routing
 * keys.** A retry queue returns its expired messages to the main exchange by dead-lettering
 * them, and a dead-lettered message keeps the routing key it was published with unless the
 * queue overrides it. Publishing to a shared retry exchange under a tier key would therefore
 * either return the message to the main exchange under `retry.2` — where nothing is bound —
 * or force a fixed override that destroys the event's real routing key for every consumer
 * that comes later. A tier-per-exchange keeps `purchase_request.approval_decided` intact from
 * the first publication to the dead-letter queue.
 *
 * **The work queue dead-letters to the terminal exchange, not to a retry tier.** Retrying is
 * a decision the consumer makes from the retry queue named in `x-death`, and it acts on it by
 * republishing to the next tier's exchange. The queue's
 * own dead-letter route is the backstop for everything the consumer did not decide — a
 * rejection it could not classify, a channel that died mid-handling — and losing those into a
 * retry loop would hide them. They land in the DLQ, where they are visible.
 */
export interface TopologyNames {
  readonly eventsExchange: string;
  readonly deadLetterExchange: string;
  readonly retryExchanges: readonly string[];
  readonly workQueue: string;
  readonly retryQueues: readonly string[];
  readonly deadLetterQueue: string;
  readonly bindingPatterns: readonly string[];
}

/**
 * One queue serves every event this system emits, and it is bound by **family** rather than by
 * event type, so a new event inside a family needs no topology change at all.
 *
 * There are two families because there are two aggregates. A purchase order is not a purchase
 * request transition: FR-054 lets an order be cancelled long after its request reached ORDERED,
 * and a consumer that cares about orders should be able to bind to `purchase_order.#` without
 * also receiving every approval decision in the tenant. Keeping them separate costs one extra
 * binding per queue now and avoids a routing-key migration later.
 *
 * A readonly list rather than a single string: every queue in the ladder — work, each retry
 * tier and the dead letter — iterates it, so adding a family is one entry here rather than
 * three edits in `assertTopology`.
 */
const BINDING_PATTERNS: readonly string[] = [
  "purchase_request.#",
  "purchase_order.#",
];

export function topologyNames(
  prefix: string,
  retryTierCount: number,
): TopologyNames {
  const tiers = Array.from({ length: retryTierCount }, (_, index) => index + 1);

  return {
    eventsExchange: `${prefix}.events`,
    deadLetterExchange: `${prefix}.events.dlx`,
    // Named by tier position rather than by delay: the delay is configuration, and a queue
    // whose name changes with its configuration cannot be re-declared after a tuning change.
    retryExchanges: tiers.map((tier) => `${prefix}.events.retry.${tier}`),
    workQueue: `${prefix}.purchase-request-events`,
    retryQueues: tiers.map(
      (tier) => `${prefix}.purchase-request-events.retry.${tier}`,
    ),
    deadLetterQueue: `${prefix}.purchase-request-events.dlq`,
    bindingPatterns: BINDING_PATTERNS,
  };
}

/**
 * Idempotent, and asserted by every process that connects. Declaring the topology from one
 * place means the relay and the consumer cannot disagree about it; asserting it on every
 * connection means a broker that lost its definitions is repaired by a reconnect.
 */
export async function assertTopology(
  channel: ConfirmChannel,
  names: TopologyNames,
  retryDelaysMs: readonly number[],
): Promise<void> {
  await channel.assertExchange(names.eventsExchange, "topic", {
    durable: true,
  });
  await channel.assertExchange(names.deadLetterExchange, "topic", {
    durable: true,
  });

  for (const retryExchange of names.retryExchanges) {
    await channel.assertExchange(retryExchange, "topic", { durable: true });
  }

  await channel.assertQueue(names.workQueue, {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": names.deadLetterExchange,
    },
  });
  for (const pattern of names.bindingPatterns) {
    await channel.bindQueue(names.workQueue, names.eventsExchange, pattern);
  }

  for (const [index, retryQueue] of names.retryQueues.entries()) {
    const retryExchange = names.retryExchanges[index];
    const delayMs = retryDelaysMs[index];

    if (retryExchange === undefined || delayMs === undefined) {
      // `topologyNames` derives both lists from the same tier count, so this is unreachable.
      // It is checked rather than asserted because a half-declared retry ladder would drop
      // messages silently, and a loud failure at startup is the cheaper outcome.
      throw new Error(`Retry tier ${index + 1} has no exchange or no delay`);
    }

    await channel.assertQueue(retryQueue, {
      durable: true,
      arguments: {
        // The delay itself. On expiry the message is dead-lettered back to the main exchange
        // with its original routing key, which is what puts it in front of the consumer again.
        "x-message-ttl": delayMs,
        "x-dead-letter-exchange": names.eventsExchange,
      },
    });
    // The same patterns as the work queue. A retry tier that bound fewer families would
    // silently drop the ones it missed the first time a message of that family failed.
    for (const pattern of names.bindingPatterns) {
      await channel.bindQueue(retryQueue, retryExchange, pattern);
    }
  }

  // Terminal. No TTL and no dead-letter route: a message here waits for a person.
  await channel.assertQueue(names.deadLetterQueue, { durable: true });

  for (const pattern of names.bindingPatterns) {
    await channel.bindQueue(
      names.deadLetterQueue,
      names.deadLetterExchange,
      pattern,
    );
  }
}

import { z } from "zod";

const url = z.string().url();

const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

/**
 * Comma-separated retry delays, in milliseconds, one per RabbitMQ retry tier (REL-006).
 *
 * It is configuration rather than a constant for one honest reason: an integration test
 * cannot wait 10 + 60 + 300 seconds to prove that the third exhausted attempt reaches the
 * dead-letter queue. The production defaults are the real ladder.
 */
const retryDelays = z
  .string()
  .default("10000,60000,300000")
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .refine(
    (entries) =>
      entries.length > 0 &&
      entries.every((entry) => /^[1-9]\d*$/.test(entry)),
    { message: "CONSUMER_RETRY_DELAYS_MS must be positive integers" },
  )
  .transform((entries) => entries.map((entry) => Number(entry)));

export const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    /**
     * REL-008. The worker takes no business traffic, but an orchestrator still has to be able
     * to tell "the process is alive" from "the process can do its job".
     */
    WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3002),

    /**
     * The worker's first database-backed responsibility (ADR-002, evolution path 3). It reads
     * and advances the outbox and it writes consumer receipts, so PostgreSQL is no longer
     * optional for this process.
     */
    DATABASE_URL: url,
    RABBITMQ_URL: url,

    /** How often the relay looks for claimable work when the last sweep was not full. */
    OUTBOX_POLL_INTERVAL_MS: positiveInt(1_000),
    OUTBOX_BATCH_SIZE: positiveInt(20),
    /**
     * How long a claim survives the death of the relay that took it. Long enough that a slow
     * confirm is not stolen mid-flight, short enough that a crash is recovered promptly.
     */
    OUTBOX_LEASE_SECONDS: positiveInt(30),
    /** Ambiguous publication after this long: not published, and eligible again. */
    OUTBOX_PUBLISH_CONFIRM_TIMEOUT_MS: positiveInt(10_000),
    /** REL-006. After this many attempts a row becomes FAILED and waits for an operator. */
    OUTBOX_MAX_PUBLISH_ATTEMPTS: positiveInt(8),
    OUTBOX_RETRY_BASE_DELAY_MS: positiveInt(1_000),
    OUTBOX_RETRY_MAX_DELAY_MS: positiveInt(300_000),

    /** Unacknowledged messages one consumer may hold. Small: work is short and transactional. */
    RABBITMQ_PREFETCH: positiveInt(10),
    /**
     * Namespace for every exchange and queue this worker declares. Declaring a queue with
     * arguments that differ from an existing one is a channel-level error in RabbitMQ, so a
     * test that changes the retry ladder needs its own namespace.
     */
    RABBITMQ_TOPOLOGY_PREFIX: z.string().min(1).default("vendorflow"),
    /** How long the worker waits before trying a dropped broker connection again. */
    RABBITMQ_RECONNECT_DELAY_MS: positiveInt(5_000),

    CONSUMER_RETRY_DELAYS_MS: retryDelays,
  })
  .refine(
    (environment) =>
      environment.OUTBOX_PUBLISH_CONFIRM_TIMEOUT_MS <
      environment.OUTBOX_LEASE_SECONDS * 1_000,
    {
      // Otherwise a publication that is merely slow outlives its own lease, another relay
      // claims the row while the first is still waiting on a confirm, and the system
      // manufactures duplicates it did not have to.
      message:
        "OUTBOX_PUBLISH_CONFIRM_TIMEOUT_MS must be shorter than OUTBOX_LEASE_SECONDS",
      path: ["OUTBOX_PUBLISH_CONFIRM_TIMEOUT_MS"],
    },
  )
  .refine(
    (environment) =>
      environment.OUTBOX_RETRY_BASE_DELAY_MS <=
      environment.OUTBOX_RETRY_MAX_DELAY_MS,
    {
      message:
        "OUTBOX_RETRY_BASE_DELAY_MS must not exceed OUTBOX_RETRY_MAX_DELAY_MS",
      path: ["OUTBOX_RETRY_BASE_DELAY_MS"],
    },
  );

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(environment: Record<string, unknown>): Environment {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; ")}`);
  }

  return parsed.data;
}

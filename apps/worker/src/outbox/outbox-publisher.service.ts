import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import {
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PinoLogger } from "nestjs-pino";
import type { Environment } from "../config/env";
import { RabbitMqService } from "../messaging/rabbitmq.service";
import {
  isSupportedEventType,
  routingKeyFor,
  toEventEnvelope,
  SUPPORTED_SCHEMA_VERSION,
} from "./event-envelope";
import { nextPublishAttemptAt } from "./publish-backoff";
import {
  OutboxMessageRepository,
  type ClaimedOutboxMessage,
} from "./outbox-message.repository";

/**
 * The relay. It turns committed intents into published messages, and it is the only place in
 * the system where PostgreSQL and RabbitMQ meet.
 *
 * The loop is three separate steps on purpose, and the separation is the whole design:
 *
 * 1. **Claim** — one short PostgreSQL transaction, committed before anything touches the
 *    network.
 * 2. **Publish** — no transaction open at all, because a confirm can take as long as a broker
 *    feels like taking.
 * 3. **Record** — a second short PostgreSQL transaction.
 *
 * The gap between 2 and 3 is where at-least-once lives. A relay that dies there has published
 * a message the database does not know about; the lease expires, the row is claimed again, and
 * the message is published a second time. That duplicate is the cost of never losing a
 * committed fact, and it is paid by the consumer's durable deduplication (REL-003).
 */
@Injectable()
export class OutboxPublisherService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  /** Identifies this process's claims. Unique per run: a restart must not inherit a lease. */
  private readonly leaseOwner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`.slice(
    0,
    100,
  );
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private sweeping = false;

  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly outboxMessages: OutboxMessageRepository,
    private readonly rabbitMq: RabbitMqService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OutboxPublisherService.name);
  }

  onApplicationBootstrap(): void {
    this.schedule(0);
  }

  onModuleDestroy(): void {
    this.stopped = true;

    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Exposed for integration tests, which drive one sweep rather than waiting for the loop. */
  async sweepOnce(): Promise<number> {
    if (!this.rabbitMq.isUsable()) {
      // Deliberately claims nothing. Claiming increments `attempt_count`, so sweeping into an
      // unreachable broker would spend the whole retry budget on an outage the messages had
      // nothing to do with, and park perfectly good intents as FAILED. The work waits.
      return 0;
    }

    const batchSize = this.config.get("OUTBOX_BATCH_SIZE", { infer: true });
    const claimed = await this.outboxMessages.claimPublishableBatch({
      leaseOwner: this.leaseOwner,
      leaseSeconds: this.config.get("OUTBOX_LEASE_SECONDS", { infer: true }),
      batchSize,
    });

    for (const message of claimed) {
      await this.publishClaimed(message);
    }

    return claimed.length;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.runSweep();
    }, delayMs);
    this.timer.unref();
  }

  private async runSweep(): Promise<void> {
    if (this.sweeping) {
      return;
    }

    this.sweeping = true;
    const pollIntervalMs = this.config.get("OUTBOX_POLL_INTERVAL_MS", {
      infer: true,
    });
    const batchSize = this.config.get("OUTBOX_BATCH_SIZE", { infer: true });

    try {
      const published = await this.sweepOnce();

      // A full batch means there is probably more waiting, so the next sweep does not pay the
      // poll interval. An empty or partial batch means the queue is drained.
      this.schedule(published === batchSize ? 0 : pollIntervalMs);
    } catch (error: unknown) {
      this.logger.error(
        { err: error },
        "Outbox sweep failed; retrying on the next interval",
      );
      this.schedule(pollIntervalMs);
    } finally {
      this.sweeping = false;
    }
  }

  private async publishClaimed(message: ClaimedOutboxMessage): Promise<void> {
    if (
      !isSupportedEventType(message.eventType) ||
      message.schemaVersion !== SUPPORTED_SCHEMA_VERSION
    ) {
      // Unpublishable by construction: another attempt would reach the same conclusion.
      await this.outboxMessages.failPermanently({
        id: message.id,
        leaseOwner: this.leaseOwner,
        lastError: `Unsupported event type or schema version: ${message.eventType} v${message.schemaVersion}`,
      });
      this.logger.error(
        {
          outboxMessageId: message.id,
          eventType: message.eventType,
          schemaVersion: message.schemaVersion,
        },
        "Outbox row cannot be published and was marked FAILED",
      );

      return;
    }

    const routingKey = routingKeyFor(message.eventType);

    try {
      const envelope = toEventEnvelope({
        id: message.id,
        organizationId: message.organizationId,
        eventType: message.eventType,
        schemaVersion: message.schemaVersion,
        aggregateType: message.aggregateType,
        aggregateId: message.aggregateId,
        correlationId: message.correlationId,
        occurredAt: message.occurredAt,
        payload: message.payload,
      });

      await this.rabbitMq.publishConfirmed(
        this.rabbitMq.names.eventsExchange,
        routingKey,
        Buffer.from(JSON.stringify(envelope), "utf8"),
        {
          // The outbox row's identity, end to end. This is what the consumer deduplicates on.
          messageId: envelope.eventId,
          correlationId: envelope.correlationId,
          type: routingKey,
          contentType: "application/json",
          contentEncoding: "utf-8",
          // AMQP timestamps are seconds. The authoritative instant stays in the envelope.
          timestamp: Math.floor(Date.parse(envelope.occurredAt) / 1000),
          appId: "vendorflow-worker",
          headers: {
            "x-vf-schema-version": envelope.schemaVersion,
            "x-vf-organization-id": envelope.organizationId,
          },
        },
        this.config.get("OUTBOX_PUBLISH_CONFIRM_TIMEOUT_MS", { infer: true }),
      );

      const marked = await this.outboxMessages.markPublished({
        id: message.id,
        leaseOwner: this.leaseOwner,
      });

      if (!marked) {
        // The lease expired while the confirm was in flight and another relay owns the row.
        // It will be published again; the consumer absorbs the duplicate. Worth a log line
        // because a steady stream of these means the lease is too short.
        this.logger.warn(
          { outboxMessageId: message.id, correlationId: message.correlationId },
          "Publication confirmed after the lease was lost; a duplicate is expected",
        );
      }
    } catch (error: unknown) {
      await this.recordPublicationFailure(message, error);
    }
  }

  private async recordPublicationFailure(
    message: ClaimedOutboxMessage,
    error: unknown,
  ): Promise<void> {
    const maxAttempts = this.config.get("OUTBOX_MAX_PUBLISH_ATTEMPTS", {
      infer: true,
    });
    const outcome = await this.outboxMessages.releaseAfterFailure({
      id: message.id,
      leaseOwner: this.leaseOwner,
      nextAttemptAt: nextPublishAttemptAt({
        attemptCount: message.attemptCount,
        baseDelayMs: this.config.get("OUTBOX_RETRY_BASE_DELAY_MS", {
          infer: true,
        }),
        maxDelayMs: this.config.get("OUTBOX_RETRY_MAX_DELAY_MS", {
          infer: true,
        }),
      }),
      // The error's message only. Never the payload, never a stack trace, never a URL that
      // could carry broker credentials.
      lastError: error instanceof Error ? error.message : "Publication failed",
      maxAttempts,
    });

    const context = {
      outboxMessageId: message.id,
      correlationId: message.correlationId,
      organizationId: message.organizationId,
      attemptCount: message.attemptCount,
      outcome,
    };

    if (outcome === "FAILED") {
      this.logger.error(
        context,
        "Outbox publication exhausted its attempts and is parked for inspection",
      );

      return;
    }

    this.logger.warn(context, "Outbox publication failed and will be retried");
  }
}

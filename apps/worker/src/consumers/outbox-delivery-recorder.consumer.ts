import {
  Injectable,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PinoLogger } from "nestjs-pino";
import type { Environment } from "../config/env";
import {
  RabbitMqService,
  type ConsumerDelivery,
} from "../messaging/rabbitmq.service";
import {
  eventEnvelopeSchema,
  isSupportedEventType,
  SUPPORTED_SCHEMA_VERSION,
  type EventEnvelope,
} from "../outbox/event-envelope";
import { ConsumerReceiptRepository } from "./consumer-receipt.repository";
import { classifyRetry, completedRetryTiers } from "./retry-classification";

/**
 * The stable logical name this consumer records receipts under. It is part of the receipt's
 * primary key, so renaming it would make every past event look unprocessed. It is a constant
 * for that reason and not configuration.
 */
export const OUTBOX_DELIVERY_RECORDER = "outbox-delivery-recorder";

/** Why a message was sent to the terminal queue. Enumerated so a log line is greppable. */
type PoisonReason =
  | "unparseable-body"
  | "invalid-envelope"
  | "unsupported-event-type"
  | "unsupported-schema-version"
  | "unknown-or-foreign-event"
  | "retries-exhausted";

/**
 * The first real consumer, and deliberately not a product feature.
 *
 * It exists to prove the reliability contract end to end — durable deduplication, bounded
 * retry, terminal dead-lettering, tenant validation — without inventing Notifications, email
 * or any user-facing capability to hang it on. Its durable effect is a receipt: evidence that
 * this consumer processed this event exactly once, whatever the broker delivered.
 *
 * The acknowledgement rule is the one that matters: **ack only after the PostgreSQL
 * transaction commits.** A crash between commit and ack redelivers the message, and the
 * receipt absorbs it. A crash between ack and commit would lose the work — which is why that
 * ordering does not exist here.
 *
 * Every settlement goes through the `ConsumerDelivery` this handler was given, never through
 * the service's current channel. The handler is asynchronous and PostgreSQL is slow enough to
 * outlive a connection blink, so by the time it decides, the channel that delivered the
 * message may be gone and its delivery tags may already mean something else.
 */
@Injectable()
export class OutboxDeliveryRecorderConsumer implements OnApplicationBootstrap {
  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly rabbitMq: RabbitMqService,
    private readonly receipts: ConsumerReceiptRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OutboxDeliveryRecorderConsumer.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.rabbitMq.registerConsumer(
      this.rabbitMq.names.workQueue,
      (delivery) => this.handle(delivery),
    );
  }

  async handle(delivery: ConsumerDelivery): Promise<void> {
    const envelope = await this.readEnvelope(delivery);

    if (envelope === null) {
      return;
    }

    const completedTiers = completedRetryTiers(
      delivery.message.properties.headers,
      this.rabbitMq.names.retryQueues,
    );

    let outcome;

    try {
      outcome = await this.receipts.recordDelivery({
        consumer: OUTBOX_DELIVERY_RECORDER,
        eventId: envelope.eventId,
        organizationId: envelope.organizationId,
        eventType: envelope.eventType,
        deliveryCount: completedTiers + 1,
      });
    } catch (error: unknown) {
      // Transient by assumption: PostgreSQL unreachable, a lock timeout, a dropped
      // connection. Bounded retry decides how many times that assumption may be wrong.
      await this.retryOrDeadLetter(delivery, envelope, completedTiers, error);

      return;
    }

    if (outcome === "UNKNOWN_EVENT") {
      // Either no such committed intent, or one belonging to a different organization. A
      // message is provenance, never authority: the consumer refuses rather than trusting the
      // tenant the envelope claims (ADR-002).
      await this.deadLetter(delivery, envelope, "unknown-or-foreign-event");

      return;
    }

    // The transaction has committed. Only now is the message acknowledged, and only on the
    // channel that delivered it. A crash in the instant between the two redelivers the
    // message and the receipt absorbs it; a crash in the opposite order would lose the work,
    // which is why that order does not exist here. An acknowledgement that cannot be issued
    // because the channel is gone has the same shape: the broker redelivers, and the receipt
    // absorbs it again.
    delivery.ack();

    this.logger.info(
      {
        eventId: envelope.eventId,
        correlationId: envelope.correlationId,
        organizationId: envelope.organizationId,
        eventType: envelope.eventType,
        deliveryCount: completedTiers + 1,
      },
      outcome === "ALREADY_PROCESSED"
        ? "Duplicate delivery absorbed by the durable receipt"
        : "Recorded outgoing event delivery",
    );
  }

  /**
   * Poison classification. Every rejection here is terminal on purpose: a body that is not
   * JSON, a shape this system never produces, or a version this worker does not implement
   * will be exactly as wrong in five minutes. Retrying it would spend the whole ladder to
   * reach the same answer three times.
   */
  private async readEnvelope(
    delivery: ConsumerDelivery,
  ): Promise<EventEnvelope | null> {
    let body: unknown;

    try {
      body = JSON.parse(delivery.message.content.toString("utf8"));
    } catch {
      await this.deadLetter(delivery, null, "unparseable-body");

      return null;
    }

    const parsed = eventEnvelopeSchema.safeParse(body);

    if (!parsed.success) {
      await this.deadLetter(delivery, null, "invalid-envelope");

      return null;
    }

    if (parsed.data.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
      await this.deadLetter(delivery, parsed.data, "unsupported-schema-version");

      return null;
    }

    if (!isSupportedEventType(parsed.data.eventType)) {
      await this.deadLetter(delivery, parsed.data, "unsupported-event-type");

      return null;
    }

    return parsed.data;
  }

  private async retryOrDeadLetter(
    delivery: ConsumerDelivery,
    envelope: EventEnvelope,
    completedTiers: number,
    error: unknown,
  ): Promise<void> {
    if (!delivery.isSettleable()) {
      // The delivery cannot be acknowledged any more, so republishing it to the next tier
      // would put a copy on the ladder *and* leave the original to be redelivered. Doing
      // nothing lets the broker redeliver exactly once, on the tier it is already on.
      this.logger.warn(
        {
          err: error,
          eventId: envelope.eventId,
          correlationId: envelope.correlationId,
        },
        "The delivering channel closed before a retry could be scheduled; leaving the message to be redelivered",
      );

      return;
    }

    const decision = classifyRetry(
      completedTiers,
      this.rabbitMq.names.retryExchanges.length,
    );

    if (decision.kind === "dead-letter") {
      await this.deadLetter(
        delivery,
        envelope,
        "retries-exhausted",
        error,
        completedTiers,
      );

      return;
    }

    const delaysMs = this.config.get("CONSUMER_RETRY_DELAYS_MS", {
      infer: true,
    });
    const retryExchange = this.rabbitMq.names.retryExchanges[decision.tier];

    if (retryExchange === undefined) {
      await this.deadLetter(
        delivery,
        envelope,
        "retries-exhausted",
        error,
        completedTiers,
      );

      return;
    }

    try {
      // Republished rather than rejected: a rejection would follow the work queue's own
      // dead-letter route, which is terminal, and there is no way to pick a delay with a
      // `nack`. The original headers travel with it so RabbitMQ's `x-death` bookkeeping keeps
      // accumulating and the ladder cannot restart at the bottom.
      await this.rabbitMq.publishConfirmed(
        retryExchange,
        delivery.message.fields.routingKey,
        delivery.message.content,
        {
          ...delivery.message.properties,
          headers: delivery.message.properties.headers,
        },
        this.config.get("OUTBOX_PUBLISH_CONFIRM_TIMEOUT_MS", { infer: true }),
      );
      delivery.ack();
      this.logger.warn(
        {
          err: error,
          eventId: envelope.eventId,
          correlationId: envelope.correlationId,
          organizationId: envelope.organizationId,
          retryTier: decision.tier + 1,
          retryDelayMs: delaysMs[decision.tier],
        },
        "Consumer failed; scheduled for a delayed retry",
      );
    } catch (retryError: unknown) {
      // The broker refused the republish, so the delayed retry cannot be arranged. The
      // message goes back through the queue's own dead-letter route: visible in the terminal
      // queue, never requeued in a loop and never dropped.
      this.logger.error(
        {
          err: retryError,
          eventId: envelope.eventId,
          correlationId: envelope.correlationId,
        },
        "Could not schedule a delayed retry; rejecting to the dead-letter route",
      );
      delivery.rejectToDeadLetter();
    }
  }

  private async deadLetter(
    delivery: ConsumerDelivery,
    envelope: EventEnvelope | null,
    reason: PoisonReason,
    error?: unknown,
    completedTiers = 0,
  ): Promise<void> {
    const context = {
      err: error,
      reason,
      completedTiers,
      eventId: envelope?.eventId,
      correlationId:
        envelope?.correlationId ?? delivery.message.properties.correlationId,
      organizationId: envelope?.organizationId,
    };

    if (!delivery.isSettleable()) {
      // Same reasoning as a retry: an unacknowledgeable delivery republished to the terminal
      // exchange would be dead-lettered once and redelivered once. Redelivery alone is
      // enough, and it reaches the same verdict.
      this.logger.warn(
        context,
        "The delivering channel closed before the message could be dead-lettered; leaving it to be redelivered",
      );

      return;
    }

    try {
      // Explicit rather than a rejection, so the terminal message carries why it is there.
      // Nothing sensitive is added: identifiers and a fixed reason code.
      await this.rabbitMq.publishConfirmed(
        this.rabbitMq.names.deadLetterExchange,
        delivery.message.fields.routingKey,
        delivery.message.content,
        {
          ...delivery.message.properties,
          headers: {
            ...(delivery.message.properties.headers ?? {}),
            "x-vf-failure-reason": reason,
            // Stated explicitly because RabbitMQ discards a client-supplied `x-death` on
            // publish: without this, the terminal message would not say how much of the
            // ladder it served (REL-006 asks for enough metadata to investigate).
            "x-vf-completed-retry-tiers": completedTiers,
          },
        },
        this.config.get("OUTBOX_PUBLISH_CONFIRM_TIMEOUT_MS", { infer: true }),
      );
      delivery.ack();
    } catch (publishError: unknown) {
      this.logger.error(
        { ...context, err: publishError },
        "Could not publish to the dead-letter exchange; rejecting instead",
      );
      delivery.rejectToDeadLetter();

      return;
    }

    this.logger.error(context, "Message routed to the dead-letter queue");
  }
}

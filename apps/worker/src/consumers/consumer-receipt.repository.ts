import { Injectable } from "@nestjs/common";
import { DatabaseService } from "@vendorflow/database";

export type RecordDeliveryOutcome =
  | "RECORDED"
  | "ALREADY_PROCESSED"
  | "UNKNOWN_EVENT";

export interface RecordDeliveryInput {
  readonly consumer: string;
  readonly eventId: string;
  /** Taken from the envelope and proven against the persisted row before anything is written. */
  readonly organizationId: string;
  readonly eventType: string;
  readonly deliveryCount: number;
}

/**
 * REL-003, as a transaction.
 *
 * Three things happen inside one PostgreSQL transaction, in this order, and the order is the
 * requirement:
 *
 * 1. the message's claimed identity and tenant are proven against the persisted outbox row;
 * 2. the deduplication claim is made;
 * 3. the observable effect follows.
 *
 * In this phase steps 2 and 3 coincide — the receipt row *is* the effect, because the consumer
 * is infrastructure and has no product effect to produce. The shape is what matters: when a
 * real consumer arrives, it adds its effect after `createMany` reports a fresh row and
 * inherits an idempotency contract that is already proven. A consumer that produced its effect
 * first and deduplicated afterwards would be idempotent only until it crashed in between.
 */
@Injectable()
export class ConsumerReceiptRepository {
  constructor(private readonly database: DatabaseService) {}

  async recordDelivery(
    input: RecordDeliveryInput,
  ): Promise<RecordDeliveryOutcome> {
    return this.database.$transaction(async (transaction) => {
      // The envelope's organization identifier is provenance, not authority (ADR-002). This
      // is where that distinction is enforced: the tenant and the identity must both match a
      // row this system actually committed, or nothing is written at all.
      const origin = await transaction.outboxMessage.findUnique({
        where: {
          organizationId_id: {
            organizationId: input.organizationId,
            id: input.eventId,
          },
        },
        select: { id: true, eventType: true },
      });

      if (origin === null || origin.eventType !== input.eventType) {
        return "UNKNOWN_EVENT";
      }

      // `skipDuplicates` turns the primary key into the idempotency decision: a redelivery
      // inserts nothing and reports it, rather than raising an error the caller has to
      // interpret. Broker redelivery semantics are not what makes this safe — this row is.
      const inserted = await transaction.outboxConsumerReceipt.createMany({
        data: {
          consumer: input.consumer,
          eventId: input.eventId,
          organizationId: input.organizationId,
          eventType: origin.eventType,
          deliveryCount: input.deliveryCount,
        },
        skipDuplicates: true,
      });

      if (inserted.count === 0) {
        return "ALREADY_PROCESSED";
      }

      // A product consumer's observable effect belongs here, inside this transaction, after
      // the deduplication claim above has succeeded.

      return "RECORDED";
    });
  }
}

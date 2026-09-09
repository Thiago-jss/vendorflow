import { Injectable } from "@nestjs/common";
import { Prisma } from "@vendorflow/database";
import { transactionClient } from "../../../persistence/prisma-transaction-runner";
import type { TransactionScope } from "../../../persistence/transaction-scope";
import type {
  AppendOutboxMessageInput,
  OutboxMessageRecord,
  OutboxMessageRepository,
} from "../../application/contracts/outbox-message.repository";
import {
  outgoingAggregateTypes,
  outgoingEventTypes,
  type OutgoingAggregateType,
  type OutgoingEventType,
} from "../../application/contracts/outgoing-event";

@Injectable()
export class PrismaOutboxMessageRepository implements OutboxMessageRepository {
  async append(
    scope: TransactionScope,
    input: AppendOutboxMessageInput,
  ): Promise<OutboxMessageRecord> {
    const transaction = transactionClient(scope);

    // Status, attempt count and next attempt take their column defaults: a freshly committed
    // intent is claimable immediately and has been tried zero times. Naming them here would
    // let this insert and the relay disagree about what a new row looks like.
    const created = await transaction.outboxMessage.create({
      data: {
        organizationId: input.organizationId,
        eventType: input.eventType,
        schemaVersion: input.schemaVersion,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        correlationId: input.correlationId,
        occurredAt: input.occurredAt,
        payload: input.payload as Prisma.InputJsonObject,
      },
      select: {
        id: true,
        eventType: true,
        aggregateType: true,
        aggregateId: true,
        correlationId: true,
        occurredAt: true,
      },
    });

    return {
      id: created.id,
      eventType: toOutgoingEventType(created.eventType),
      aggregateType: toOutgoingAggregateType(created.aggregateType),
      aggregateId: created.aggregateId,
      correlationId: created.correlationId,
      occurredAt: created.occurredAt,
    };
  }
}

/**
 * Persistence returns the PostgreSQL enums as strings. Narrowing them here, in one place,
 * means a value added to the database but not to the application contract fails loudly
 * instead of reaching a caller as an unrecognized event type.
 */
function toOutgoingEventType(value: string): OutgoingEventType {
  const eventType = outgoingEventTypes.find((candidate) => candidate === value);

  if (eventType === undefined) {
    throw new Error("Persistence returned an unsupported outgoing event type");
  }

  return eventType;
}

function toOutgoingAggregateType(value: string): OutgoingAggregateType {
  const aggregateType = outgoingAggregateTypes.find(
    (candidate) => candidate === value,
  );

  if (aggregateType === undefined) {
    throw new Error(
      "Persistence returned an unsupported outgoing aggregate type",
    );
  }

  return aggregateType;
}

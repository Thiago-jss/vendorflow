import { Injectable } from "@nestjs/common";
import { Prisma } from "@vendorflow/database";
import { transactionClient } from "../../../platform/persistence/prisma-transaction-runner";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import {
  auditAggregateTypes,
  auditEventTypes,
  type AuditAggregateType,
  type AuditEventType,
} from "../../application/contracts/audit-event";
import type {
  AppendAuditEventInput,
  AuditEventRecord,
  AuditEventRepository,
} from "../../application/contracts/audit-event.repository";

@Injectable()
export class PrismaAuditEventRepository implements AuditEventRepository {
  async append(
    scope: TransactionScope,
    input: AppendAuditEventInput,
  ): Promise<AuditEventRecord> {
    const transaction = transactionClient(scope);

    // AUD-005. The position is taken inside the caller's transaction, immediately before the
    // insert, and the unique constraint on (organization, aggregate type, aggregate id,
    // sequence) is what actually decides it: a second writer that computed the same position
    // is refused by PostgreSQL rather than silently interleaved. The whole transaction rolls
    // back with it, so a duplicate audit record cannot exist.
    const highest = await transaction.auditEvent.aggregate({
      where: {
        organizationId: input.organizationId,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
      },
      _max: { sequence: true },
    });

    const created = await transaction.auditEvent.create({
      data: {
        organizationId: input.organizationId,
        actorId: input.actorId,
        eventType: input.eventType,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        sequence: (highest._max.sequence ?? 0) + 1,
        occurredAt: input.occurredAt,
        payload: input.payload as Prisma.InputJsonObject,
      },
      select: {
        id: true,
        eventType: true,
        aggregateType: true,
        aggregateId: true,
        sequence: true,
        occurredAt: true,
      },
    });

    return {
      id: created.id,
      eventType: toAuditEventType(created.eventType),
      aggregateType: toAuditAggregateType(created.aggregateType),
      aggregateId: created.aggregateId,
      sequence: created.sequence,
      occurredAt: created.occurredAt,
    };
  }
}

/**
 * Persistence returns the PostgreSQL enums as strings. Narrowing them here, in one place,
 * means a value added to the database but not to the application contract fails loudly
 * instead of reaching a caller as an unrecognized event type.
 */
function toAuditEventType(value: string): AuditEventType {
  const eventType = auditEventTypes.find((candidate) => candidate === value);

  if (eventType === undefined) {
    throw new Error("Persistence returned an unsupported audit event type");
  }

  return eventType;
}

function toAuditAggregateType(value: string): AuditAggregateType {
  const aggregateType = auditAggregateTypes.find(
    (candidate) => candidate === value,
  );

  if (aggregateType === undefined) {
    throw new Error("Persistence returned an unsupported audit aggregate type");
  }

  return aggregateType;
}

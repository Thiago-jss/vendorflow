import { Injectable } from "@nestjs/common";
import { DatabaseService, Prisma } from "@vendorflow/database";
import { transactionClient } from "../../../persistence/prisma-transaction-runner";
import type { TransactionScope } from "../../../persistence/transaction-scope";
import type {
  CompleteIdempotencyRecordInput,
  IdempotencyRecordCriteria,
  IdempotencyRecordRepository,
  IdempotencyRecordSnapshot,
  ReserveIdempotencyRecordInput,
} from "../../application/contracts/idempotency-record.repository";
import { IdempotencyReservationConflictError } from "../../application/contracts/idempotency.errors";
import type { IdempotencyOutcome } from "../../application/contracts/idempotent-operation";

/** Prisma's code for a unique-constraint violation. */
const UNIQUE_VIOLATION = "P2002";

@Injectable()
export class PrismaIdempotencyRecordRepository
  implements IdempotencyRecordRepository
{
  constructor(private readonly database: DatabaseService) {}

  async find(
    criteria: IdempotencyRecordCriteria,
  ): Promise<IdempotencyRecordSnapshot | null> {
    const record = await this.database.idempotencyRecord.findUnique({
      where: {
        organizationId_actorId_operation_idempotencyKeyHash: {
          organizationId: criteria.organizationId,
          actorId: criteria.actorId,
          operation: criteria.operation,
          idempotencyKeyHash: criteria.idempotencyKeyHash,
        },
      },
      select: { id: true, requestFingerprint: true, outcome: true },
    });

    if (record === null) {
      return null;
    }

    return {
      id: record.id,
      requestFingerprint: Buffer.from(record.requestFingerprint),
      outcome: toOutcome(record.outcome),
    };
  }

  async reserve(
    scope: TransactionScope,
    input: ReserveIdempotencyRecordInput,
  ): Promise<string> {
    const transaction = transactionClient(scope);

    try {
      const reserved = await transaction.idempotencyRecord.create({
        data: {
          organizationId: input.organizationId,
          actorId: input.actorId,
          operation: input.operation,
          idempotencyKeyHash: input.idempotencyKeyHash,
          requestFingerprint: input.requestFingerprint,
        },
        select: { id: true },
      });

      return reserved.id;
    } catch (error: unknown) {
      // An expected business concurrency conflict, not an infrastructure failure. Translated
      // here so no driver detail, constraint name or 500 ever reaches a caller (ADR-002).
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_VIOLATION
      ) {
        throw new IdempotencyReservationConflictError();
      }

      throw error;
    }
  }

  async complete(
    scope: TransactionScope,
    input: CompleteIdempotencyRecordInput,
  ): Promise<void> {
    const transaction = transactionClient(scope);
    // Tenant-scoped even though the identifier was produced a few statements ago: the scope
    // does not depend on the reservation above having run in this process (ADR-002).
    const completed = await transaction.idempotencyRecord.updateMany({
      where: { id: input.recordId, organizationId: input.organizationId },
      data: {
        outcome: input.outcome as Prisma.InputJsonObject,
        completedAt: input.completedAt,
      },
    });

    if (completed.count !== 1) {
      throw new Error("The idempotency reservation disappeared before completion");
    }
  }
}

/**
 * The column is JSONB and the contract is a flat scalar map. Narrowing here — rather than
 * casting — means a row written by something other than this capability is refused instead of
 * replayed as an outcome nobody can interpret.
 */
function toOutcome(value: Prisma.JsonValue | null): IdempotencyOutcome | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const outcome: Record<string, string | number | boolean | null> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (
      entry !== null &&
      typeof entry !== "string" &&
      typeof entry !== "number" &&
      typeof entry !== "boolean"
    ) {
      return null;
    }

    outcome[key] = entry ?? null;
  }

  return outcome;
}

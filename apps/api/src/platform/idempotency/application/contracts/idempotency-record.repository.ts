import type { TransactionScope } from "../../../persistence/transaction-scope";
import type {
  IdempotencyOutcome,
  IdempotentOperation,
} from "./idempotent-operation";

export const IDEMPOTENCY_RECORD_REPOSITORY = Symbol(
  "IDEMPOTENCY_RECORD_REPOSITORY",
);

/**
 * REL-004's uniqueness boundary, in full. There is no lookup by key alone and no optional
 * tenant: a record is owned by one organization and bound to one actor, so a key can never be
 * shared across users or tenants (MT-002, MT-003).
 */
export interface IdempotencyRecordCriteria {
  readonly organizationId: string;
  readonly actorId: string;
  readonly operation: IdempotentOperation;
  readonly idempotencyKeyHash: Buffer;
}

export interface ReserveIdempotencyRecordInput
  extends IdempotencyRecordCriteria {
  readonly requestFingerprint: Buffer;
}

export interface CompleteIdempotencyRecordInput {
  readonly recordId: string;
  readonly organizationId: string;
  readonly outcome: IdempotencyOutcome;
  readonly completedAt: Date;
}

export interface IdempotencyRecordSnapshot {
  readonly id: string;
  readonly requestFingerprint: Buffer;
  /** Never null for a committed record: a deferred constraint trigger refuses that at COMMIT. */
  readonly outcome: IdempotencyOutcome | null;
}

/**
 * Persistence for REL-004's durable records.
 *
 * `reserve` and `complete` take a `TransactionScope` and cannot be called outside one, because
 * the reservation, the business change, its audit event, its outgoing intent and the recorded
 * result are one fact: a rolled-back business transaction must leave no record that a later
 * retry would replay.
 *
 * `reserve` raises `IdempotencyReservationConflictError` — never a driver error — when the
 * uniqueness boundary is already taken. That is the concurrency authority: two calls carrying
 * one key cannot both reserve, whatever their pre-checks observed.
 */
export interface IdempotencyRecordRepository {
  find(
    criteria: IdempotencyRecordCriteria,
  ): Promise<IdempotencyRecordSnapshot | null>;

  reserve(
    scope: TransactionScope,
    input: ReserveIdempotencyRecordInput,
  ): Promise<string>;

  complete(
    scope: TransactionScope,
    input: CompleteIdempotencyRecordInput,
  ): Promise<void>;
}

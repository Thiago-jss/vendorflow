import { Inject, Injectable } from "@nestjs/common";
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
  type TransactionScope,
} from "../../../persistence/transaction-scope";
import type { TrustedPrincipal } from "../../../tenancy/trusted-principal";
import {
  IDEMPOTENCY_RECORD_REPOSITORY,
  type IdempotencyRecordRepository,
} from "../contracts/idempotency-record.repository";
import {
  IdempotencyKeyConflictError,
  IdempotencyReservationConflictError,
} from "../contracts/idempotency.errors";
import type {
  IdempotencyOutcome,
  IdempotentOperation,
} from "../contracts/idempotent-operation";
import {
  digestsMatch,
  fingerprintSemanticRequest,
  hashIdempotencyKey,
} from "../support/idempotency-key";

export interface IdempotentRequest {
  readonly operation: IdempotentOperation;
  /** The raw header value. It is hashed immediately and never stored, logged or echoed. */
  readonly idempotencyKey: string | undefined;
  /**
   * The normalized semantic request: route resource identifiers and the validated body values
   * that change the outcome. The caller assembles these *after* validation, so the fingerprint
   * describes an intent rather than a spelling.
   */
  readonly fingerprintParts: readonly string[];
}

/**
 * What a durable operation must be able to do, split so the replay path cannot accidentally
 * re-run the business logic:
 *
 * - `run` performs the whole change inside the transaction this capability opens, and returns
 *   both the caller's own value and the bounded scalar outcome to remember.
 * - `replay` rebuilds the same semantic answer from that remembered outcome, using ordinary
 *   authorized reads. It writes nothing.
 */
export interface IdempotentOperationHandler<T> {
  run(scope: TransactionScope): Promise<{
    readonly value: T;
    readonly outcome: IdempotencyOutcome;
  }>;
  replay(outcome: IdempotencyOutcome): Promise<T>;
}

/**
 * REL-004, as one platform capability rather than four hand-rolled implementations.
 *
 * The order of operations is the whole design:
 *
 * 1. **Hash and fingerprint before anything else.** A malformed key is a 400 that costs one
 *    regular-expression match, and the raw key never leaves this call.
 * 2. **Look for a committed record.** A match with the same fingerprint replays; a match with
 *    a different fingerprint fails closed with a conflict, because replaying would report an
 *    event that did not happen and executing would defeat the key.
 * 3. **Reserve inside the business transaction, first.** A concurrent call carrying the same
 *    key blocks on the unique index before doing any work, and loses. It never reaches the
 *    business logic, so there is no duplicate audit event, no second outbox row and no second
 *    allocated purchase order number to undo.
 * 4. **Record the outcome in that same transaction.** A rollback therefore leaves no record
 *    at all — and a deferred constraint trigger refuses to commit a reservation whose outcome
 *    was never written, so "a committed record is replayable" is a database invariant.
 * 5. **On a lost reservation, re-read and replay.** The loser's transaction has already rolled
 *    back; the winner's record is now visible, and the loser answers with it.
 *
 * The pre-check in step 2 is a fast path and a better error, never the authority. The unique
 * constraint in step 3 is the authority.
 */
@Injectable()
export class ExecuteIdempotently {
  constructor(
    @Inject(IDEMPOTENCY_RECORD_REPOSITORY)
    private readonly records: IdempotencyRecordRepository,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async execute<T>(
    principal: TrustedPrincipal,
    request: IdempotentRequest,
    handler: IdempotentOperationHandler<T>,
  ): Promise<T> {
    const idempotencyKeyHash = hashIdempotencyKey(request.idempotencyKey);
    const requestFingerprint = fingerprintSemanticRequest({
      organizationId: principal.organizationId,
      actorId: principal.userId,
      operation: request.operation,
      parts: request.fingerprintParts,
    });
    const criteria = {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      operation: request.operation,
      idempotencyKeyHash,
    };

    const existing = await this.records.find(criteria);

    if (existing !== null) {
      return this.replay(handler, existing, requestFingerprint);
    }

    try {
      return await this.transactionRunner.run(async (scope) => {
        const recordId = await this.records.reserve(scope, {
          ...criteria,
          requestFingerprint,
        });
        const { value, outcome } = await handler.run(scope);

        await this.records.complete(scope, {
          recordId,
          organizationId: principal.organizationId,
          outcome,
          completedAt: new Date(),
        });

        return value;
      });
    } catch (error: unknown) {
      if (!(error instanceof IdempotencyReservationConflictError)) {
        throw error;
      }

      const winner = await this.records.find(criteria);

      if (winner === null) {
        // The concurrent holder rolled back after all, so there is nothing to replay and
        // nothing was done. Reported as a conflict rather than retried here: a silent retry
        // inside a request handler is how one client's retry storm becomes the server's.
        throw error;
      }

      return this.replay(handler, winner, requestFingerprint);
    }
  }

  private async replay<T>(
    handler: IdempotentOperationHandler<T>,
    record: { readonly requestFingerprint: Buffer; readonly outcome: IdempotencyOutcome | null },
    requestFingerprint: Buffer,
  ): Promise<T> {
    if (!digestsMatch(record.requestFingerprint, requestFingerprint)) {
      throw new IdempotencyKeyConflictError();
    }

    if (record.outcome === null) {
      // Unreachable through this application: the deferred trigger refuses to commit a
      // record without an outcome. Checked rather than asserted, because replaying nothing
      // would be worse than refusing.
      throw new IdempotencyReservationConflictError();
    }

    return handler.replay(record.outcome);
  }
}

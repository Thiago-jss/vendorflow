import type { TransactionScope } from "../../../persistence/transaction-scope";
import type {
  OutgoingAggregateType,
  OutgoingEventPayload,
  OutgoingEventType,
} from "./outgoing-event";

export const OUTBOX_MESSAGE_REPOSITORY = Symbol("OUTBOX_MESSAGE_REPOSITORY");

export interface AppendOutboxMessageInput {
  /** Taken from the `TrustedPrincipal`, never from an emitting module's input (MT-003). */
  readonly organizationId: string;
  readonly eventType: OutgoingEventType;
  readonly schemaVersion: number;
  readonly aggregateType: OutgoingAggregateType;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
  readonly payload: OutgoingEventPayload;
}

export interface OutboxMessageRecord {
  /** The stable end-to-end event identity: AMQP `messageId` and consumer deduplication key. */
  readonly id: string;
  readonly eventType: OutgoingEventType;
  readonly aggregateType: OutgoingAggregateType;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
}

/**
 * There is one method and it appends, for the same reason the audit repository has one:
 * an interface that cannot express "publish now" is a stronger guarantee than a rule saying
 * not to. The API process never talks to a broker.
 *
 * `append` takes a `TransactionScope` rather than opening its own transaction, because
 * REL-002 requires the intent and the business change it describes to commit or roll back
 * together. There is deliberately no overload that writes outside a transaction.
 *
 * The relay's claim, publish-confirm and failure operations are **not** on this interface.
 * They belong to the worker, they are cross-tenant infrastructure operations, and putting
 * them here would offer the API a way to mutate publication state.
 */
export interface OutboxMessageRepository {
  append(
    scope: TransactionScope,
    input: AppendOutboxMessageInput,
  ): Promise<OutboxMessageRecord>;
}

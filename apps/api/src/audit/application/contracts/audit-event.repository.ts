import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import type {
  AuditAggregateType,
  AuditEventPayload,
  AuditEventType,
} from "./audit-event";

export const AUDIT_EVENT_REPOSITORY = Symbol("AUDIT_EVENT_REPOSITORY");

export interface AppendAuditEventInput {
  readonly organizationId: string;
  /** The acting principal, taken from `TrustedPrincipal` and never from a payload. */
  readonly actorId: string;
  readonly eventType: AuditEventType;
  readonly aggregateType: AuditAggregateType;
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly payload: AuditEventPayload;
}

export interface AuditEventRecord {
  readonly id: string;
  readonly eventType: AuditEventType;
  readonly aggregateType: AuditAggregateType;
  readonly aggregateId: string;
  readonly sequence: number;
  readonly occurredAt: Date;
}

/**
 * AUD-003. There is one method, and it appends. No update, no delete, no "correct an event":
 * an interface that cannot express a mutation is a stronger guarantee than a rule that says
 * not to write one, and PostgreSQL refuses both operations anyway (see the migration's
 * `audit_events_append_only` trigger).
 *
 * `append` takes a `TransactionScope` rather than opening its own transaction, because
 * AUD-004 requires the event and the business change it describes to commit or roll back
 * together. There is deliberately no overload that writes outside a transaction.
 */
export interface AuditEventRepository {
  append(
    scope: TransactionScope,
    input: AppendAuditEventInput,
  ): Promise<AuditEventRecord>;
}

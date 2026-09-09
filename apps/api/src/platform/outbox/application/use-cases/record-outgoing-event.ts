import { Inject, Injectable } from "@nestjs/common";
import {
  currentCorrelationId,
  newCorrelationId,
} from "../../../correlation/correlation-context";
import type { TransactionScope } from "../../../persistence/transaction-scope";
import type { TrustedPrincipal } from "../../../tenancy/trusted-principal";
import {
  OUTBOX_MESSAGE_REPOSITORY,
  type OutboxMessageRecord,
  type OutboxMessageRepository,
} from "../contracts/outbox-message.repository";
import {
  OUTGOING_EVENT_SCHEMA_VERSION,
  type OutgoingAggregateType,
  type OutgoingEventPayload,
  type OutgoingEventType,
} from "../contracts/outgoing-event";

export interface RecordOutgoingEventInput {
  readonly eventType: OutgoingEventType;
  readonly aggregateType: OutgoingAggregateType;
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly payload: OutgoingEventPayload;
}

/**
 * `platform`'s published way to say "this committed fact has to leave the system"
 * (ADR-001: `platform` owns the outbox; ADR-003: the intent commits with the change).
 *
 * A business module calls this with the `TransactionScope` it already holds. It gets back an
 * identity and nothing else — no channel, no broker, no delivery status. Whether the message
 * has been published is not a fact the transaction that produced it can know, and offering a
 * caller something that looks like one would be a lie.
 *
 * Organization and correlation are *derived*, not accepted:
 *
 * - the organization comes from the `TrustedPrincipal`, so an emitting module cannot attribute
 *   an outgoing fact to another tenant even by mistake (MT-003);
 * - the correlation identifier comes from the request-bound context, so the message the worker
 *   publishes later is attributable to the request that caused it (NFR-008).
 */
@Injectable()
export class RecordOutgoingEvent {
  constructor(
    @Inject(OUTBOX_MESSAGE_REPOSITORY)
    private readonly outboxMessages: OutboxMessageRepository,
  ) {}

  execute(
    scope: TransactionScope,
    principal: TrustedPrincipal,
    input: RecordOutgoingEventInput,
  ): Promise<OutboxMessageRecord> {
    return this.outboxMessages.append(scope, {
      organizationId: principal.organizationId,
      eventType: input.eventType,
      schemaVersion: OUTGOING_EVENT_SCHEMA_VERSION,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      // A fact emitted outside any request still gets a traceable identifier rather than a
      // null column: the alternative is an unattributable message, which is worse than one
      // whose trail starts here.
      correlationId: currentCorrelationId() ?? newCorrelationId(),
      occurredAt: input.occurredAt,
      payload: input.payload,
    });
  }
}

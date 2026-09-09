import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import {
  AUDIT_EVENT_REPOSITORY,
  type AppendAuditEventInput,
  type AuditEventRecord,
  type AuditEventRepository,
} from "../contracts/audit-event.repository";
import type {
  AuditAggregateType,
  AuditEventPayload,
  AuditEventType,
} from "../contracts/audit-event";

export interface RecordAuditEventInput {
  readonly eventType: AuditEventType;
  readonly aggregateType: AuditAggregateType;
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly payload: AuditEventPayload;
}

/**
 * The `audit` module's published write path (ADR-001 rule 7: other modules emit audit facts
 * and none may read, alter or delete them).
 *
 * The organization and the actor are taken from the `TrustedPrincipal` and are not part of
 * the caller's input, so an emitting module cannot attribute an event to another tenant or
 * another user even by mistake (MT-003).
 */
@Injectable()
export class RecordAuditEvent {
  constructor(
    @Inject(AUDIT_EVENT_REPOSITORY)
    private readonly auditEvents: AuditEventRepository,
  ) {}

  execute(
    scope: TransactionScope,
    principal: TrustedPrincipal,
    input: RecordAuditEventInput,
  ): Promise<AuditEventRecord> {
    const appended: AppendAuditEventInput = {
      organizationId: principal.organizationId,
      actorId: principal.userId,
      eventType: input.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      occurredAt: input.occurredAt,
      payload: input.payload,
    };

    return this.auditEvents.append(scope, appended);
  }
}

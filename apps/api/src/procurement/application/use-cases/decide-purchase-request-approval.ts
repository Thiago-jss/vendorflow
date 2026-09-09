import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from "../../../platform/persistence/transaction-scope";
import { GetCurrentOrganizationContext } from "../../../identity-access/application/use-cases/get-current-organization-context";
import { ApprovalStepNotActionableError } from "../../../approval/application/contracts/approval.errors";
import {
  assertMayDecideApprovalStep,
  assertNotSelfApproval,
} from "../../../approval/application/support/approval-authorization";
import { normalizeApprovalDecisionReason } from "../../../approval/application/support/approval-decision";
import type { ApprovalDecision } from "../../../approval/application/support/approval-step-state";
import { DecideActionableApprovalStep } from "../../../approval/application/use-cases/decide-actionable-approval-step";
import { GetApprovalFlowForRequest } from "../../../approval/application/use-cases/get-approval-flow-for-request";
import { RecordAuditEvent } from "../../../audit/application/use-cases/record-audit-event";
import { RecordOutgoingEvent } from "../../../platform/outbox/application/use-cases/record-outgoing-event";
import {
  PurchaseRequestConcurrentlyModifiedError,
  PurchaseRequestNotFoundError,
  PurchaseRequestTransitionNotAllowedError,
} from "../contracts/purchase-request.errors";
import {
  PURCHASE_REQUEST_REPOSITORY,
  type PurchaseRequestRepository,
} from "../contracts/purchase-request.repository";
import type { PurchaseRequestView } from "../contracts/purchase-request-view";
import {
  DECIDABLE_APPROVAL_STEP_ROLE,
  purchaseRequestStatusAfterApprovalDecision,
} from "../support/purchase-request-approval";
import { approvalStepDecidedPayload } from "../support/purchase-request-audit";
import { purchaseRequestApprovalDecidedEventPayload } from "../support/purchase-request-events";
import {
  APPROVAL_DECIDABLE_STATUSES,
  isApprovalTransitionAllowed,
} from "../support/purchase-request-status";

export interface PurchaseRequestApprovalDecisionInput {
  readonly decision: ApprovalDecision;
  readonly reason?: string;
}

/**
 * FR-031, FR-032 and FR-036: a Manager decides the step their department's request is waiting
 * on, and the decision is final (BR-006).
 *
 * The checks run in the order that leaks least, and each one answers a different question:
 *
 * 1. **Capability** (403). Does this principal hold MANAGER at all? Refused before any read,
 *    so an unauthorized caller learns nothing and costs nothing. ADMIN is not a bypass
 *    (AUTHZ-007), and BUYER and FINANCE do not decide a Manager step (AUTHZ-006).
 * 2. **Responsibility** (404). The request is read by tenant *and* by the manager's own
 *    department, so an unknown identifier, another tenant's and another department's are one
 *    answer (AUTHZ-004, MT-004). The boundary is the request's persisted `departmentId`
 *    (BR-042) — never the requester's current profile, which may have moved since.
 * 3. **Segregation of duties** (403). BR-005: the requester never decides their own request,
 *    whatever roles they hold. Refused before the transaction opens, so nothing is written.
 * 4. **Reason** (422). FR-031's ten-character minimum for a rejection.
 * 5. **State** (409). A pre-check for a useful message only; the writes below are what
 *    actually guarantee it.
 *
 * Then one transaction does the whole change: the step's conditional decision, the request's
 * conditional transition, and the audit event. Any of them failing throws, which rolls all of
 * them back — there is no path that commits a decided step without its request transition, or
 * either without its audit event (REL-001, AUD-004).
 *
 * Two managers deciding at once therefore produce exactly one decision, one transition, one
 * audit event and one outgoing intent: the second `UPDATE` re-checks `state = ACTIONABLE`
 * under the row lock the first one took, matches nothing, and takes its whole transaction
 * down with it (REL-005).
 *
 * The outgoing fact is recorded in that same transaction and is an intent, not a publication
 * (REL-002). No broker is contacted here, so a decision commits whether or not RabbitMQ is
 * reachable (REL-007).
 */
@Injectable()
export class DecidePurchaseRequestApproval {
  constructor(
    @Inject(PURCHASE_REQUEST_REPOSITORY)
    private readonly purchaseRequests: PurchaseRequestRepository,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    // identity-access owns the User table (ADR-001); the decider's own department is read
    // through its published interface rather than by querying users from here.
    private readonly getCurrentOrganizationContext: GetCurrentOrganizationContext,
    private readonly decideActionableApprovalStep: DecideActionableApprovalStep,
    private readonly getApprovalFlowForRequest: GetApprovalFlowForRequest,
    private readonly recordAuditEvent: RecordAuditEvent,
    private readonly recordOutgoingEvent: RecordOutgoingEvent,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    purchaseRequestId: string,
    input: PurchaseRequestApprovalDecisionInput,
  ): Promise<PurchaseRequestView> {
    assertMayDecideApprovalStep(principal, DECIDABLE_APPROVAL_STEP_ROLE);

    const context = await this.getCurrentOrganizationContext.execute(principal);
    const departmentId = context.membership.department.id;
    const existing = await this.purchaseRequests.findDepartmentRequest({
      organizationId: principal.organizationId,
      departmentId,
      purchaseRequestId,
    });

    if (existing === null) {
      throw new PurchaseRequestNotFoundError();
    }

    assertNotSelfApproval(principal, existing.requesterId);

    const decisionReason = normalizeApprovalDecisionReason(
      input.decision,
      input.reason,
    );
    const toStatus = purchaseRequestStatusAfterApprovalDecision(input.decision);

    if (!isApprovalTransitionAllowed(existing.status, toStatus)) {
      throw new PurchaseRequestTransitionNotAllowedError(
        existing.status,
        "decided",
      );
    }

    const decidedAt = new Date();
    const request = await this.transactionRunner.run(async (scope) => {
      const decided = await this.decideActionableApprovalStep.execute(scope, {
        organizationId: principal.organizationId,
        purchaseRequestId,
        role: DECIDABLE_APPROVAL_STEP_ROLE,
        decision: input.decision,
        decisionReason,
        decidedById: principal.userId,
        decidedAt,
      });

      if (decided === null) {
        throw new ApprovalStepNotActionableError();
      }

      const transitioned = await this.purchaseRequests.applyApprovalDecision(
        scope,
        {
          organizationId: principal.organizationId,
          // Restated inside the write: the department is a predicate, not only a pre-check.
          departmentId,
          purchaseRequestId,
          fromStatuses: APPROVAL_DECIDABLE_STATUSES,
          toStatus,
        },
      );

      if (transitioned === null) {
        throw new PurchaseRequestConcurrentlyModifiedError();
      }

      await this.recordAuditEvent.execute(scope, principal, {
        eventType:
          input.decision === "APPROVED"
            ? "APPROVAL_STEP_APPROVED"
            : "APPROVAL_STEP_REJECTED",
        aggregateType: "PURCHASE_REQUEST",
        aggregateId: transitioned.id,
        occurredAt: decidedAt,
        payload: approvalStepDecidedPayload({
          step: decided.step,
          approvalFlowState: decided.flowState,
          resultingStatus: transitioned.status,
        }),
      });

      await this.recordOutgoingEvent.execute(scope, principal, {
        eventType: "PURCHASE_REQUEST_APPROVAL_DECIDED",
        aggregateType: "PURCHASE_REQUEST",
        aggregateId: transitioned.id,
        occurredAt: decidedAt,
        // Deliberately without the decision reason the audit payload above carries: free text
        // a manager wrote about a colleague's request stays in tenant-scoped storage.
        payload: purchaseRequestApprovalDecidedEventPayload({
          step: decided.step,
          approvalFlowState: decided.flowState,
          resultingStatus: transitioned.status,
          requesterId: transitioned.requesterId,
          decidedById: principal.userId,
        }),
      });

      return transitioned;
    });

    return {
      request,
      approvalFlow: await this.getApprovalFlowForRequest.execute({
        organizationId: principal.organizationId,
        purchaseRequestId: request.id,
      }),
    };
  }
}

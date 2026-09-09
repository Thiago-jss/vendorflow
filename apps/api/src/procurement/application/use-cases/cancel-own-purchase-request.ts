import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from "../../../platform/persistence/transaction-scope";
import { GetApprovalFlowForRequest } from "../../../approval/application/use-cases/get-approval-flow-for-request";
import { VoidApprovalFlowForRequest } from "../../../approval/application/use-cases/void-approval-flow-for-request";
import { RecordAuditEvent } from "../../../audit/application/use-cases/record-audit-event";
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
import { purchaseRequestCancelledPayload } from "../support/purchase-request-audit";
import {
  REQUESTER_CANCELLABLE_STATUSES,
  isRequesterTransitionAllowed,
} from "../support/purchase-request-status";

/**
 * FR-025 and BR-013. The requester cancels their own request while it is still ahead of
 * ORDERED. DRAFT, SUBMITTED and IN_QUOTATION are the states reachable in this phase, so those
 * are the only ones the rule is written against.
 *
 * Cancelling makes the approval ladder unactionable rather than removing it: a flow that had
 * not finished becomes `VOIDED`, every undecided step with it, and every decision already
 * recorded stays exactly as recorded (AUD-003). A flow that had already finished is left
 * alone — cancelling a request does not un-approve what got it here.
 *
 * All three writes — the transition, the voiding and the audit event — are one transaction.
 */
@Injectable()
export class CancelOwnPurchaseRequest {
  constructor(
    @Inject(PURCHASE_REQUEST_REPOSITORY)
    private readonly purchaseRequests: PurchaseRequestRepository,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    private readonly voidApprovalFlowForRequest: VoidApprovalFlowForRequest,
    private readonly getApprovalFlowForRequest: GetApprovalFlowForRequest,
    private readonly recordAuditEvent: RecordAuditEvent,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    purchaseRequestId: string,
  ): Promise<PurchaseRequestView> {
    const existing = await this.purchaseRequests.findOwnRequest({
      organizationId: principal.organizationId,
      requesterId: principal.userId,
      purchaseRequestId,
    });

    if (existing === null) {
      throw new PurchaseRequestNotFoundError();
    }

    if (!isRequesterTransitionAllowed(existing.status, "CANCELLED")) {
      throw new PurchaseRequestTransitionNotAllowedError(
        existing.status,
        "cancelled",
      );
    }

    const cancelledAt = new Date();
    const request = await this.transactionRunner.run(async (scope) => {
      const cancelled = await this.purchaseRequests.cancelOwnRequest(scope, {
        organizationId: principal.organizationId,
        requesterId: principal.userId,
        purchaseRequestId,
        cancelledAt,
        cancellableStatuses: REQUESTER_CANCELLABLE_STATUSES,
      });

      if (cancelled === null) {
        throw new PurchaseRequestConcurrentlyModifiedError();
      }

      const voidedApprovalStepCount =
        await this.voidApprovalFlowForRequest.execute(scope, {
          organizationId: principal.organizationId,
          purchaseRequestId: cancelled.id,
        });

      await this.recordAuditEvent.execute(scope, principal, {
        eventType: "PURCHASE_REQUEST_CANCELLED",
        aggregateType: "PURCHASE_REQUEST",
        aggregateId: cancelled.id,
        occurredAt: cancelledAt,
        payload: purchaseRequestCancelledPayload({
          previousStatus: existing.status,
          voidedApprovalStepCount,
        }),
      });

      return cancelled;
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

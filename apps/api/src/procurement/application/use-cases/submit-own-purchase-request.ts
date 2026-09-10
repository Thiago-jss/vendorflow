import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import type { IdempotencyOutcome } from "../../../platform/idempotency/application/contracts/idempotent-operation";
import { ExecuteIdempotently } from "../../../platform/idempotency/application/use-cases/execute-idempotently";
import { RecordOutgoingEvent } from "../../../platform/outbox/application/use-cases/record-outgoing-event";
import { GetApprovalFlowForRequest } from "../../../approval/application/use-cases/get-approval-flow-for-request";
import { MaterializeApprovalFlow } from "../../../approval/application/use-cases/materialize-approval-flow";
import { RecordAuditEvent } from "../../../audit/application/use-cases/record-audit-event";
import {
  PurchaseRequestConcurrentlyModifiedError,
  PurchaseRequestNotFoundError,
  PurchaseRequestTransitionNotAllowedError,
  PurchaseRequestValidationError,
} from "../contracts/purchase-request.errors";
import {
  PURCHASE_REQUEST_REPOSITORY,
  type PurchaseRequestRepository,
} from "../contracts/purchase-request.repository";
import type { PurchaseRequestView } from "../contracts/purchase-request-view";
import { purchaseRequestSubmittedPayload } from "../support/purchase-request-audit";
import { purchaseRequestSubmittedEventPayload } from "../support/purchase-request-events";
import {
  SUBMITTABLE_STATUSES,
  isRequesterTransitionAllowed,
} from "../support/purchase-request-status";
import { ReadPurchaseRequestSupplements } from "./read-purchase-request-supplements";

/**
 * FR-023 and FR-024, which are one fact and not two: `DRAFT → SUBMITTED`, the BR-001 approval
 * ladder the estimated total requires, and the audit event that records it all commit
 * together or not at all (REL-001, AUD-004).
 *
 * The order inside the transaction matters. The conditional transition runs first, so a
 * request that was submitted or cancelled between the read above and this write produces no
 * flow and no audit event — the compare-and-swap is what decides, and everything after it is
 * conditional on having won.
 *
 * The ladder is materialized from the estimated total the transition itself returned, which
 * is the value PostgreSQL holds, not the one the caller read a moment earlier.
 *
 * The outgoing fact joins the same transaction (REL-002). It is a durable *intent*, not a
 * publication: nothing here opens a channel, waits on a confirm or knows a broker exists, so
 * RabbitMQ being down cannot decide whether a submission commits (REL-007). A submission that
 * loses the compare-and-swap above leaves no intent, because the throw takes the whole
 * transaction with it.
 *
 * REL-004 wraps all of it, and wraps it *first*. A retried submission carrying the same
 * Idempotency-Key replays the first one's answer without transitioning anything, without
 * materializing a second ladder, without a second audit event and without a second outgoing
 * intent. That is why the state check lives inside the transaction rather than in front of it:
 * a retry necessarily arrives at a request that is no longer a DRAFT, so a pre-check would
 * answer 409 to exactly the case the key exists to make safe.
 *
 * The reservation commits in the very same transaction, so a submission that rolls back — for
 * any reason, including a 404 — leaves no record for a later retry to replay.
 */
@Injectable()
export class SubmitOwnPurchaseRequest {
  constructor(
    @Inject(PURCHASE_REQUEST_REPOSITORY)
    private readonly purchaseRequests: PurchaseRequestRepository,
    private readonly materializeApprovalFlow: MaterializeApprovalFlow,
    private readonly getApprovalFlowForRequest: GetApprovalFlowForRequest,
    private readonly readPurchaseRequestSupplements: ReadPurchaseRequestSupplements,
    private readonly recordAuditEvent: RecordAuditEvent,
    private readonly recordOutgoingEvent: RecordOutgoingEvent,
    private readonly executeIdempotently: ExecuteIdempotently,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    purchaseRequestId: string,
    /** REL-004. The raw header value, hashed immediately and never stored or logged. */
    idempotencyKey: string | undefined,
  ): Promise<PurchaseRequestView> {
    // REL-004 wraps the *whole* operation, including the state pre-check. Checking "is this
    // still a DRAFT?" before consulting the key would turn every legitimate retry into a 409,
    // which is precisely the duplicate-suppression an idempotency key exists to avoid.
    return this.executeIdempotently.execute(
      principal,
      {
        operation: "PURCHASE_REQUEST_SUBMISSION",
        idempotencyKey,
        // The request identifier is the whole intent: a submission has no body, and what it
        // submits is whatever the draft holds at the moment it commits.
        fingerprintParts: [purchaseRequestId],
      },
      {
        run: (scope) => this.submit(principal, scope, purchaseRequestId),
        // The same ownership-scoped read the original call passed, and nothing else.
        replay: () => this.readOwnRequest(principal, purchaseRequestId),
      },
    );
  }

  private async submit(
    principal: TrustedPrincipal,
    scope: TransactionScope,
    purchaseRequestId: string,
  ): Promise<{
    readonly value: PurchaseRequestView;
    readonly outcome: IdempotencyOutcome;
  }> {
    const existing = await this.purchaseRequests.findOwnRequest({
      organizationId: principal.organizationId,
      requesterId: principal.userId,
      purchaseRequestId,
    });

    if (existing === null) {
      // Unknown, another requester's, and another tenant's all end here (MT-004). Thrown from
      // inside the transaction, so a probe leaves no idempotency record behind either.
      throw new PurchaseRequestNotFoundError();
    }

    if (!isRequesterTransitionAllowed(existing.status, "SUBMITTED")) {
      throw new PurchaseRequestTransitionNotAllowedError(
        existing.status,
        "submitted",
      );
    }

    // BR-012. A draft can only reach this state through write paths that refuse an empty item
    // list, so this is a belt-and-braces check on the invariant that makes the stored total
    // meaningful rather than a duplicate of payload validation.
    if (existing.items.length === 0) {
      throw new PurchaseRequestValidationError(
        "A purchase request requires at least one item",
      );
    }

    const submittedAt = new Date();
    const request = await this.purchaseRequests.submitOwnRequest(scope, {
      organizationId: principal.organizationId,
      requesterId: principal.userId,
      purchaseRequestId,
      submittedAt,
      submittableStatuses: SUBMITTABLE_STATUSES,
    });

    if (request === null) {
      // Thrown rather than returned, so the transaction rolls back and no half-written
      // submission — and no idempotency record — survives the race it lost.
      throw new PurchaseRequestConcurrentlyModifiedError();
    }

    const approvalFlow = await this.materializeApprovalFlow.execute(scope, {
      organizationId: principal.organizationId,
      purchaseRequestId: request.id,
      evaluatedAmountCents: request.estimatedTotalCents,
    });

    await this.recordAuditEvent.execute(scope, principal, {
      eventType: "PURCHASE_REQUEST_SUBMITTED",
      aggregateType: "PURCHASE_REQUEST",
      aggregateId: request.id,
      occurredAt: submittedAt,
      payload: purchaseRequestSubmittedPayload({
        estimatedTotalCents: request.estimatedTotalCents,
        approvalFlowId: approvalFlow.id,
        approvalStepCount: approvalFlow.steps.length,
      }),
    });

    await this.recordOutgoingEvent.execute(scope, principal, {
      eventType: "PURCHASE_REQUEST_SUBMITTED",
      aggregateType: "PURCHASE_REQUEST",
      aggregateId: request.id,
      occurredAt: submittedAt,
      payload: purchaseRequestSubmittedEventPayload({
        estimatedTotalCents: request.estimatedTotalCents,
        requesterId: request.requesterId,
        departmentId: request.departmentId,
        approvalFlowId: approvalFlow.id,
        approvalStepCount: approvalFlow.steps.length,
      }),
    });

    return {
      value: {
        request,
        approvalFlow,
        // A request that has just been submitted has neither a selected quote nor an order.
        supplements: { selectedQuote: null, purchaseOrder: null },
      },
      outcome: {
        purchaseRequestId: request.id,
        status: request.status,
        approvalFlowId: approvalFlow.id,
      },
    };
  }

  /**
   * REL-004's replay. The same ownership-scoped read the original call passed, so a retry sees
   * exactly what the first request could — and writes nothing.
   */
  private async readOwnRequest(
    principal: TrustedPrincipal,
    purchaseRequestId: string,
  ): Promise<PurchaseRequestView> {
    const request = await this.purchaseRequests.findOwnRequest({
      organizationId: principal.organizationId,
      requesterId: principal.userId,
      purchaseRequestId,
    });

    if (request === null) {
      throw new PurchaseRequestNotFoundError();
    }

    const [approvalFlow, supplements] = await Promise.all([
      this.getApprovalFlowForRequest.execute({
        organizationId: principal.organizationId,
        purchaseRequestId: request.id,
      }),
      this.readPurchaseRequestSupplements.execute(
        principal.organizationId,
        request,
      ),
    ]);

    return { request, approvalFlow, supplements };
  }
}

import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import {
  PurchaseRequestConcurrentlyModifiedError,
  PurchaseRequestNotFoundError,
  PurchaseRequestTransitionNotAllowedError,
  PurchaseRequestValidationError,
} from "../contracts/purchase-request.errors";
import {
  PURCHASE_REQUEST_REPOSITORY,
  type PurchaseRequestRecord,
  type PurchaseRequestRepository,
} from "../contracts/purchase-request.repository";
import {
  SUBMITTABLE_STATUSES,
  isRequesterTransitionAllowed,
} from "../support/purchase-request-status";

/**
 * FR-023: DRAFT → SUBMITTED, by the requester and no one else.
 *
 * FR-024 also asks submission to materialize an Approval Flow. ApprovalFlow does not exist
 * yet and is the subject of its own phase, so this use case persists the transition and
 * nothing more. It deliberately emits no event, writes no placeholder flow and creates no
 * synthetic step: a fake approval structure would be harder to remove than to add, and the
 * next phase needs the real one.
 */
@Injectable()
export class SubmitOwnPurchaseRequest {
  constructor(
    @Inject(PURCHASE_REQUEST_REPOSITORY)
    private readonly purchaseRequests: PurchaseRequestRepository,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    purchaseRequestId: string,
  ): Promise<PurchaseRequestRecord> {
    const existing = await this.purchaseRequests.findOwnRequest({
      organizationId: principal.organizationId,
      requesterId: principal.userId,
      purchaseRequestId,
    });

    if (existing === null) {
      throw new PurchaseRequestNotFoundError();
    }

    if (!isRequesterTransitionAllowed(existing.status, "SUBMITTED")) {
      throw new PurchaseRequestTransitionNotAllowedError(
        existing.status,
        "submitted",
      );
    }

    // BR-012. A draft can only reach this state through the write paths above, which refuse
    // an empty item list, so this is a belt-and-braces check on the invariant that makes the
    // stored total meaningful rather than a duplicate of payload validation.
    if (existing.items.length === 0) {
      throw new PurchaseRequestValidationError(
        "A purchase request requires at least one item",
      );
    }

    const submitted = await this.purchaseRequests.submitOwnRequest({
      organizationId: principal.organizationId,
      requesterId: principal.userId,
      purchaseRequestId,
      submittedAt: new Date(),
      submittableStatuses: SUBMITTABLE_STATUSES,
    });

    if (submitted === null) {
      throw new PurchaseRequestConcurrentlyModifiedError();
    }

    return submitted;
  }
}

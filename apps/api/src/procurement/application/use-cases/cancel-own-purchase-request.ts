import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import {
  PurchaseRequestConcurrentlyModifiedError,
  PurchaseRequestNotFoundError,
  PurchaseRequestTransitionNotAllowedError,
} from "../contracts/purchase-request.errors";
import {
  PURCHASE_REQUEST_REPOSITORY,
  type PurchaseRequestRecord,
  type PurchaseRequestRepository,
} from "../contracts/purchase-request.repository";
import {
  REQUESTER_CANCELLABLE_STATUSES,
  isRequesterTransitionAllowed,
} from "../support/purchase-request-status";

/**
 * FR-025 and BR-013. The requester cancels their own request while it is still ahead of
 * ORDERED. Of the states BR-011 lists, only DRAFT and SUBMITTED are reachable in this
 * phase, so those are the only ones the rule is written against.
 */
@Injectable()
export class CancelOwnPurchaseRequest {
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

    if (!isRequesterTransitionAllowed(existing.status, "CANCELLED")) {
      throw new PurchaseRequestTransitionNotAllowedError(
        existing.status,
        "cancelled",
      );
    }

    const cancelled = await this.purchaseRequests.cancelOwnRequest({
      organizationId: principal.organizationId,
      requesterId: principal.userId,
      purchaseRequestId,
      cancelledAt: new Date(),
      cancellableStatuses: REQUESTER_CANCELLABLE_STATUSES,
    });

    if (cancelled === null) {
      throw new PurchaseRequestConcurrentlyModifiedError();
    }

    return cancelled;
  }
}

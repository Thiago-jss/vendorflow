import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import { PurchaseRequestNotFoundError } from "../contracts/purchase-request.errors";
import {
  PURCHASE_REQUEST_REPOSITORY,
  type PurchaseRequestRecord,
  type PurchaseRequestRepository,
} from "../contracts/purchase-request.repository";

/**
 * FR-026, for the part of it that exists in this phase: the requester's own request and its
 * current state. There is no pending approval step and no step history yet, and inventing
 * empty ones would be a contract the next phase has to break.
 */
@Injectable()
export class GetOwnPurchaseRequest {
  constructor(
    @Inject(PURCHASE_REQUEST_REPOSITORY)
    private readonly purchaseRequests: PurchaseRequestRepository,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    purchaseRequestId: string,
  ): Promise<PurchaseRequestRecord> {
    const request = await this.purchaseRequests.findOwnRequest({
      organizationId: principal.organizationId,
      requesterId: principal.userId,
      purchaseRequestId,
    });

    if (request === null) {
      // Unknown, another requester's, and another tenant's all end here (MT-004).
      throw new PurchaseRequestNotFoundError();
    }

    return request;
  }
}

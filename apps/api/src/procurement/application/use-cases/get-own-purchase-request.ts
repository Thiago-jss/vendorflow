import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import { GetApprovalFlowForRequest } from "../../../approval/application/use-cases/get-approval-flow-for-request";
import { PurchaseRequestNotFoundError } from "../contracts/purchase-request.errors";
import {
  PURCHASE_REQUEST_REPOSITORY,
  type PurchaseRequestRepository,
} from "../contracts/purchase-request.repository";
import type { PurchaseRequestView } from "../contracts/purchase-request-view";

/**
 * FR-026: the requester's own request, its current state, the step it is waiting on and the
 * full ordered history of the steps that were required of it.
 *
 * The approval read happens only after the ownership-scoped read has succeeded. It is
 * tenant-scoped in its own right, but it knows nothing about ownership, so running it first
 * would make it the thing standing between a caller and a request — and it is not built to be
 * that.
 */
@Injectable()
export class GetOwnPurchaseRequest {
  constructor(
    @Inject(PURCHASE_REQUEST_REPOSITORY)
    private readonly purchaseRequests: PurchaseRequestRepository,
    private readonly getApprovalFlowForRequest: GetApprovalFlowForRequest,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    purchaseRequestId: string,
  ): Promise<PurchaseRequestView> {
    const request = await this.purchaseRequests.findOwnRequest({
      organizationId: principal.organizationId,
      requesterId: principal.userId,
      purchaseRequestId,
    });

    if (request === null) {
      // Unknown, another requester's, and another tenant's all end here (MT-004).
      throw new PurchaseRequestNotFoundError();
    }

    return {
      request,
      approvalFlow: await this.getApprovalFlowForRequest.execute({
        organizationId: principal.organizationId,
        purchaseRequestId: request.id,
      }),
    };
  }
}

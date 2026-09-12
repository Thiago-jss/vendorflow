import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import {
  PurchaseRequestActionNotAuthorizedError,
  PurchaseRequestNotFoundError,
} from "../contracts/purchase-request.errors";
import {
  PURCHASE_REQUEST_REPOSITORY,
  type PurchaseRequestRepository,
  type QuotationWorkPurchaseRequestRecord,
} from "../contracts/purchase-request.repository";
import { QUOTABLE_STATUSES } from "../support/purchase-request-status";

/**
 * FR-040/FR-041. One request from the Buyer's quotation queue, with the item lines a quote must
 * price one for one.
 *
 * The queue is a summary and the quote comparison may still be empty, so without this read the
 * first quote would have no way to learn the request's item identifiers. It is not the
 * requester's read of their own request, and it is not a quotation authority: registering a
 * quote still proves quotability under the request's row lock on its own.
 *
 * The capability is checked before the read, so a principal without BUYER never causes a query
 * (AUTHZ-003). The boundary is the organization (AUTHZ-004), and the permitted states are in the
 * predicate with it: an unknown identifier, another tenant's, and a request no longer awaiting
 * quotation are one answer (MT-004). ADMIN is not a bypass (AUTHZ-007).
 *
 * BR-005 is deliberately not applied, for the same reason as in the queue: pricing a request one
 * raised is not deciding it.
 */
@Injectable()
export class GetQuotationWorkPurchaseRequest {
  constructor(
    @Inject(PURCHASE_REQUEST_REPOSITORY)
    private readonly purchaseRequests: PurchaseRequestRepository,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    purchaseRequestId: string,
  ): Promise<QuotationWorkPurchaseRequestRecord> {
    if (!principal.roles.includes("BUYER")) {
      throw new PurchaseRequestActionNotAuthorizedError("run quotation for");
    }

    const request = await this.purchaseRequests.findQuotationWorkRequest({
      organizationId: principal.organizationId,
      purchaseRequestId,
      statuses: QUOTABLE_STATUSES,
    });

    if (request === null) {
      throw new PurchaseRequestNotFoundError();
    }

    return request;
  }
}

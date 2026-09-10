import { Inject, Injectable } from "@nestjs/common";
import { PurchaseRequestNotFoundError } from "../contracts/purchase-request.errors";
import {
  PURCHASE_REQUEST_REPOSITORY,
  type OrganizationPurchaseRequestCriteria,
  type PurchaseRequestRecord,
  type PurchaseRequestRepository,
} from "../contracts/purchase-request.repository";

/**
 * AUTHZ-004. `procurement`'s published tenant-scoped read of one request.
 *
 * It exists for the organization-scoped actors — a Buyer comparing quotes, a Finance user
 * reading what they are about to approve — and for the modules that need a request's items to
 * do their own work. It carries no capability check of its own: whether the caller may perform
 * the operation they are performing is the calling use case's question, and answering it here
 * as well would spread one rule across two modules.
 *
 * An unknown identifier and another organization's are one answer (MT-004).
 */
@Injectable()
export class GetOrganizationPurchaseRequest {
  constructor(
    @Inject(PURCHASE_REQUEST_REPOSITORY)
    private readonly purchaseRequests: PurchaseRequestRepository,
  ) {}

  async execute(
    criteria: OrganizationPurchaseRequestCriteria,
  ): Promise<PurchaseRequestRecord> {
    const request =
      await this.purchaseRequests.findOrganizationRequest(criteria);

    if (request === null) {
      throw new PurchaseRequestNotFoundError();
    }

    return request;
  }
}


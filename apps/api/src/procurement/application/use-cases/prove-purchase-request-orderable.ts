import { Inject, Injectable } from "@nestjs/common";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import { PurchaseRequestNotFoundError } from "../contracts/purchase-request.errors";
import {
  PURCHASE_REQUEST_REPOSITORY,
  type OrganizationPurchaseRequestCriteria,
  type PurchaseRequestRecord,
  type PurchaseRequestRepository,
} from "../contracts/purchase-request.repository";
import { ORDERABLE_STATUSES } from "../support/purchase-request-status";

/**
 * FR-050. `procurement`'s published answer to "is this request approved, and will it stay
 * approved for the rest of my transaction?".
 *
 * The same shape and the same reason as its quotation counterpart: the request's row lock is
 * taken first, so the purchase order, its snapshot lines, its allocated number, its audit
 * event and its outgoing intent are all conditional on the request still being APPROVED — and
 * a cancellation racing the issuance loses cleanly instead of leaving an order behind.
 *
 * It also returns the request's items, which is what `purchase-order` snapshots from: the
 * description, unit of measure, quantity and position of each line come from here, and only
 * the prices come from the selected quote (FR-051).
 */
@Injectable()
export class ProvePurchaseRequestOrderable {
  constructor(
    @Inject(PURCHASE_REQUEST_REPOSITORY)
    private readonly purchaseRequests: PurchaseRequestRepository,
  ) {}

  async execute(
    scope: TransactionScope,
    criteria: OrganizationPurchaseRequestCriteria,
  ): Promise<PurchaseRequestRecord> {
    const request = await this.purchaseRequests.lockRequestInStatuses(scope, {
      ...criteria,
      requiredStatuses: ORDERABLE_STATUSES,
    });

    if (request === null) {
      throw new PurchaseRequestNotFoundError();
    }

    return request;
  }
}

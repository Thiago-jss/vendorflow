import { Inject, Injectable } from "@nestjs/common";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import { PurchaseRequestConcurrentlyModifiedError } from "../contracts/purchase-request.errors";
import {
  PURCHASE_REQUEST_REPOSITORY,
  type OrganizationPurchaseRequestCriteria,
  type PurchaseRequestRecord,
  type PurchaseRequestRepository,
} from "../contracts/purchase-request.repository";

/**
 * FR-052. `procurement`'s published edge into ORDERED, which is terminal (BR-011).
 *
 * `purchase-order` calls it inside the issuance transaction. There is no status parameter:
 * there is exactly one edge, and offering a choice would be offering a way to write a status
 * that no rule produced.
 */
@Injectable()
export class ApplyOrderIssuedTransition {
  constructor(
    @Inject(PURCHASE_REQUEST_REPOSITORY)
    private readonly purchaseRequests: PurchaseRequestRepository,
  ) {}

  async execute(
    scope: TransactionScope,
    criteria: OrganizationPurchaseRequestCriteria,
  ): Promise<PurchaseRequestRecord> {
    const transitioned = await this.purchaseRequests.applyOrderIssued(
      scope,
      criteria,
    );

    if (transitioned === null) {
      throw new PurchaseRequestConcurrentlyModifiedError();
    }

    return transitioned;
  }
}

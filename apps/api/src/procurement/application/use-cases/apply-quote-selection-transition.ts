import { Inject, Injectable } from "@nestjs/common";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import { PurchaseRequestConcurrentlyModifiedError } from "../contracts/purchase-request.errors";
import {
  PURCHASE_REQUEST_REPOSITORY,
  type OrganizationPurchaseRequestCriteria,
  type PurchaseRequestRecord,
  type PurchaseRequestRepository,
} from "../contracts/purchase-request.repository";
import type { PurchaseRequestStatus } from "../support/purchase-request-status";

/**
 * FR-045. `procurement`'s published edge out of IN_QUOTATION.
 *
 * The target is `APPROVED` when BR-003's re-evaluation left nothing to approve and
 * `IN_FINAL_APPROVAL` otherwise — a fact the approval ladder produces, not one a client sends.
 * `quotation` supplies it because `quotation` ran the re-evaluation; it does not choose it,
 * and `isQuoteSelectionTransitionAllowed` refuses anything that is not one of those two.
 *
 * The conditional write restates IN_QUOTATION as its source state, so a request cancelled
 * between the lock and here — impossible while the lock is held, and cheap to keep true
 * anyway — writes nothing and takes the whole selection down with it.
 */
@Injectable()
export class ApplyQuoteSelectionTransition {
  constructor(
    @Inject(PURCHASE_REQUEST_REPOSITORY)
    private readonly purchaseRequests: PurchaseRequestRepository,
  ) {}

  async execute(
    scope: TransactionScope,
    input: OrganizationPurchaseRequestCriteria & {
      readonly toStatus: Extract<
        PurchaseRequestStatus,
        "IN_FINAL_APPROVAL" | "APPROVED"
      >;
    },
  ): Promise<PurchaseRequestRecord> {
    const transitioned = await this.purchaseRequests.applyQuoteSelection(
      scope,
      input,
    );

    if (transitioned === null) {
      throw new PurchaseRequestConcurrentlyModifiedError();
    }

    return transitioned;
  }
}

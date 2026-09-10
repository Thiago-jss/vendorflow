import { Inject, Injectable } from "@nestjs/common";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import { PurchaseRequestNotFoundError } from "../contracts/purchase-request.errors";
import {
  PURCHASE_REQUEST_REPOSITORY,
  type OrganizationPurchaseRequestCriteria,
  type PurchaseRequestRecord,
  type PurchaseRequestRepository,
} from "../contracts/purchase-request.repository";
import { QUOTABLE_STATUSES } from "../support/purchase-request-status";

/**
 * BR-020. `procurement`'s published answer to "is this request still in quotation, and will it
 * stay that way for the rest of my transaction?".
 *
 * This is the operation that makes quote registration safe against a concurrent cancellation,
 * and the reason it is worth its own name. Reading the status and then inserting a quote is a
 * race: FR-025 lets a requester cancel from IN_QUOTATION, and a quote inserted a moment later
 * would leave an ACTIVE offer standing against a request nobody can act on. So the status is
 * proven **under the request's row lock**, and every row the caller writes afterwards is
 * conditional on having taken it.
 *
 * The lock order this establishes — request first, then quote or approval flow, then derived
 * rows — is the same order every other operation in this system takes, which is what keeps two
 * concurrent transitions from deadlocking on each other.
 *
 * `quotation` calls this instead of reading `purchase_requests`, which is how it prices a
 * request's items without ever touching procurement's tables (ADR-001 rule 2).
 */
@Injectable()
export class ProvePurchaseRequestQuotable {
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
      requiredStatuses: QUOTABLE_STATUSES,
    });

    if (request === null) {
      // Unknown, another tenant's, and "no longer in quotation" are one answer here on
      // purpose: the caller has its own tenant-scoped read for the first two, and this
      // operation exists to be the last word rather than to classify (MT-004).
      throw new PurchaseRequestNotFoundError();
    }

    return request;
  }
}

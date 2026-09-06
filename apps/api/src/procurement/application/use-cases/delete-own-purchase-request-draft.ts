import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import {
  PurchaseRequestNotFoundError,
  PurchaseRequestTransitionNotAllowedError,
} from "../contracts/purchase-request.errors";
import {
  PURCHASE_REQUEST_REPOSITORY,
  type PurchaseRequestRepository,
} from "../contracts/purchase-request.repository";
import { isEditableByRequester } from "../support/purchase-request-status";

/**
 * FR-022, the "deleted" half.
 *
 * A hard delete is correct here and only here: a DRAFT has never been submitted, so nothing
 * in the system references it — no approval flow, no quote, no order — and its items are
 * part of the same aggregate, removed by the CASCADE the migration declares. There is no
 * soft-delete flag, because no requirement asks to read a deleted draft back and a
 * speculative one would have to be honoured by every later query.
 *
 * When AuditEvent arrives, deleting a draft becomes an auditable fact; that is a change to
 * this use case, not a reason to pre-build a tombstone now.
 */
@Injectable()
export class DeleteOwnPurchaseRequestDraft {
  constructor(
    @Inject(PURCHASE_REQUEST_REPOSITORY)
    private readonly purchaseRequests: PurchaseRequestRepository,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    purchaseRequestId: string,
  ): Promise<void> {
    const criteria = {
      organizationId: principal.organizationId,
      requesterId: principal.userId,
      purchaseRequestId,
    };
    const existing = await this.purchaseRequests.findOwnRequest(criteria);

    if (existing === null) {
      throw new PurchaseRequestNotFoundError();
    }

    if (!isEditableByRequester(existing.status)) {
      throw new PurchaseRequestTransitionNotAllowedError(
        existing.status,
        "deleted",
      );
    }

    // The delete predicate re-states DRAFT, so a request submitted between the read and the
    // write is not removed. Losing the race is indistinguishable from never having found
    // the draft, which is the same answer the caller would have received a moment earlier.
    if (!(await this.purchaseRequests.deleteOwnDraft(criteria))) {
      throw new PurchaseRequestNotFoundError();
    }
  }
}

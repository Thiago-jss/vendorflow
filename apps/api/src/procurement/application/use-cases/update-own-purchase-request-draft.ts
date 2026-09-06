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
  normalizePurchaseRequestDraft,
  type PurchaseRequestDraftInput,
} from "../support/purchase-request-draft";
import { isEditableByRequester } from "../support/purchase-request-status";

/**
 * FR-022/FR-023. Replaces the whole editable content of a DRAFT — justification, needed-by
 * date and the complete item list — and recomputes the estimated total.
 *
 * Replacement rather than a partial patch: an item list is the thing being stated, and a
 * per-field patch would need a client-driven identity for lines that have no meaning outside
 * this request. The status is not part of the payload; a state change is a named command.
 */
@Injectable()
export class UpdateOwnPurchaseRequestDraft {
  constructor(
    @Inject(PURCHASE_REQUEST_REPOSITORY)
    private readonly purchaseRequests: PurchaseRequestRepository,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    purchaseRequestId: string,
    input: PurchaseRequestDraftInput,
  ): Promise<PurchaseRequestRecord> {
    const draft = normalizePurchaseRequestDraft(input);
    const existing = await this.purchaseRequests.findOwnRequest({
      organizationId: principal.organizationId,
      requesterId: principal.userId,
      purchaseRequestId,
    });

    if (existing === null) {
      throw new PurchaseRequestNotFoundError();
    }

    // FR-023: after submission the request is immutable to its requester. This produces the
    // useful error; the conditional write below is what actually guarantees it.
    if (!isEditableByRequester(existing.status)) {
      throw new PurchaseRequestTransitionNotAllowedError(
        existing.status,
        "edited",
      );
    }

    const updated = await this.purchaseRequests.replaceOwnDraft({
      organizationId: principal.organizationId,
      requesterId: principal.userId,
      purchaseRequestId,
      justification: draft.justification,
      neededBy: draft.neededBy,
      estimatedTotalCents: draft.estimatedTotalCents,
      items: draft.items,
    });

    if (updated === null) {
      throw new PurchaseRequestConcurrentlyModifiedError();
    }

    return updated;
  }
}

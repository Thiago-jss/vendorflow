import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import { GetCurrentOrganizationContext } from "../../../identity-access/application/use-cases/get-current-organization-context";
import {
  PURCHASE_REQUEST_REPOSITORY,
  type PurchaseRequestRecord,
  type PurchaseRequestRepository,
} from "../contracts/purchase-request.repository";
import { assertMayCreatePurchaseRequest } from "../support/purchase-request-authorization";
import {
  normalizePurchaseRequestDraft,
  type PurchaseRequestDraftInput,
} from "../support/purchase-request-draft";

/**
 * FR-020. Creates a request in DRAFT owned by the calling principal.
 *
 * FR-020 grants this to an Employee, so the capability is checked before anything else runs:
 * authenticating is not the same as being allowed to raise a request (AUTHZ-003). The check
 * lives here rather than only in a guard so it protects the use case for any caller, not
 * only for one that arrived through this module's controller.
 *
 * Nothing the client sends is authority: the organization and the requester come from the
 * `TrustedPrincipal` (MT-003), the department is read from persisted identity (BR-042), the
 * status is the schema default, and the estimated total is computed from the items (BR-032).
 * The command input therefore has no field for any of them.
 */
@Injectable()
export class CreatePurchaseRequestDraft {
  constructor(
    @Inject(PURCHASE_REQUEST_REPOSITORY)
    private readonly purchaseRequests: PurchaseRequestRepository,
    // identity-access owns the User table (ADR-001); the requester's department is read
    // through its published interface rather than by querying users from here.
    private readonly getCurrentOrganizationContext: GetCurrentOrganizationContext,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    input: PurchaseRequestDraftInput,
  ): Promise<PurchaseRequestRecord> {
    // Refused before the payload is parsed and before any read: an unauthorized caller
    // learns nothing about their input and costs nothing to reject.
    assertMayCreatePurchaseRequest(principal);

    const draft = normalizePurchaseRequestDraft(input);
    const context = await this.getCurrentOrganizationContext.execute(principal);

    return this.purchaseRequests.createDraft({
      organizationId: principal.organizationId,
      requesterId: principal.userId,
      // BR-042: a snapshot taken now. A later move of this user does not reassign it.
      departmentId: context.membership.department.id,
      justification: draft.justification,
      neededBy: draft.neededBy,
      estimatedTotalCents: draft.estimatedTotalCents,
      items: draft.items,
    });
  }
}

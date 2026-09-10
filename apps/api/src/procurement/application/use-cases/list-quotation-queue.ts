import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import { PurchaseRequestActionNotAuthorizedError } from "../contracts/purchase-request.errors";
import {
  PURCHASE_REQUEST_REPOSITORY,
  type PurchaseRequestListCursor,
  type PurchaseRequestPage,
  type PurchaseRequestRepository,
} from "../contracts/purchase-request.repository";
import { QUOTABLE_STATUSES } from "../support/purchase-request-status";

/** NFR-004. Bounded here so no caller can ask for an unbounded collection. */
export const DEFAULT_QUOTATION_QUEUE_PAGE_SIZE = 20;
export const MAXIMUM_QUOTATION_QUEUE_PAGE_SIZE = 100;

export interface ListQuotationQueueRequest {
  readonly limit?: number;
  readonly after: PurchaseRequestListCursor | null;
}

/**
 * FR-040's Buyer queue: the requests a Manager has approved into quotation and which are
 * therefore waiting for quotes.
 *
 * The capability is checked before the read, so a principal without BUYER never causes a
 * query (AUTHZ-003). The boundary is the organization (AUTHZ-004): a Buyer runs quotation for
 * the whole tenant, not for one Department, so — unlike the Manager queue — there is no
 * department predicate to add.
 *
 * BR-005 is deliberately **not** applied here. Self-approval is what BR-005 forbids;
 * registering quotes for a request one happens to have raised is not a decision on that
 * request, and excluding those rows would silently hide work from the person responsible for
 * doing it. The rule reappears where it belongs — a Buyer who raised a request still cannot
 * decide its Purchasing step.
 */
@Injectable()
export class ListQuotationQueue {
  constructor(
    @Inject(PURCHASE_REQUEST_REPOSITORY)
    private readonly purchaseRequests: PurchaseRequestRepository,
  ) {}

  execute(
    principal: TrustedPrincipal,
    request: ListQuotationQueueRequest,
  ): Promise<PurchaseRequestPage> {
    if (!principal.roles.includes("BUYER")) {
      throw new PurchaseRequestActionNotAuthorizedError("run quotation for");
    }

    return this.purchaseRequests.listOrganizationRequests({
      organizationId: principal.organizationId,
      statuses: QUOTABLE_STATUSES,
      limit: request.limit ?? DEFAULT_QUOTATION_QUEUE_PAGE_SIZE,
      after: request.after,
    });
  }
}

import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import {
  PURCHASE_REQUEST_REPOSITORY,
  type PurchaseRequestListCursor,
  type PurchaseRequestPage,
  type PurchaseRequestRepository,
} from "../contracts/purchase-request.repository";

export const DEFAULT_PURCHASE_REQUEST_PAGE_SIZE = 20;
export const MAXIMUM_PURCHASE_REQUEST_PAGE_SIZE = 100;

export interface ListOwnPurchaseRequestsInput {
  readonly limit?: number;
  readonly after?: PurchaseRequestListCursor | null;
}

/**
 * NFR-004. The page size is bounded here rather than trusted from the query string, so the
 * endpoint cannot be turned into an unbounded collection by asking nicely.
 */
@Injectable()
export class ListOwnPurchaseRequests {
  constructor(
    @Inject(PURCHASE_REQUEST_REPOSITORY)
    private readonly purchaseRequests: PurchaseRequestRepository,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    input: ListOwnPurchaseRequestsInput = {},
  ): Promise<PurchaseRequestPage> {
    const requested = input.limit ?? DEFAULT_PURCHASE_REQUEST_PAGE_SIZE;

    return this.purchaseRequests.listOwnRequests({
      organizationId: principal.organizationId,
      requesterId: principal.userId,
      limit: Math.min(
        Math.max(requested, 1),
        MAXIMUM_PURCHASE_REQUEST_PAGE_SIZE,
      ),
      after: input.after ?? null,
    });
  }
}

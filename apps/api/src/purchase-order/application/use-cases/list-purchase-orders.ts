import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import {
  PURCHASE_ORDER_REPOSITORY,
  type ListPurchaseOrdersCriteria,
  type PurchaseOrderListCursor,
  type PurchaseOrderPage,
  type PurchaseOrderRepository,
  type PurchaseOrderStatus,
} from "../contracts/purchase-order.repository";
import { assertMayAdministerPurchaseOrders } from "../support/purchase-order-authorization";

/** NFR-004. Bounded here so no caller can ask for an unbounded collection. */
export const DEFAULT_PURCHASE_ORDER_PAGE_SIZE = 20;
export const MAXIMUM_PURCHASE_ORDER_PAGE_SIZE = 100;

export interface ListPurchaseOrdersRequest {
  readonly limit?: number;
  readonly status: PurchaseOrderStatus | null;
  readonly after: PurchaseOrderListCursor | null;
}

/**
 * FR-054's list half. The organization's purchase orders, newest first, keyset-paginated.
 *
 * Buyer and Administrator both act at organization scope here (AUTHZ-004), so the tenant
 * predicate is what bounds the query — and the cursor is compared against an already
 * tenant-scoped predicate, so a forged one can only move the caller around inside their own
 * organization's rows.
 */
@Injectable()
export class ListPurchaseOrders {
  constructor(
    @Inject(PURCHASE_ORDER_REPOSITORY)
    private readonly purchaseOrders: PurchaseOrderRepository,
  ) {}

  execute(
    principal: TrustedPrincipal,
    request: ListPurchaseOrdersRequest,
  ): Promise<PurchaseOrderPage> {
    assertMayAdministerPurchaseOrders(principal, "read");

    const criteria: ListPurchaseOrdersCriteria = {
      organizationId: principal.organizationId,
      status: request.status,
      limit: Math.min(
        Math.max(request.limit ?? DEFAULT_PURCHASE_ORDER_PAGE_SIZE, 1),
        MAXIMUM_PURCHASE_ORDER_PAGE_SIZE,
      ),
      after: request.after,
    };

    return this.purchaseOrders.list(criteria);
  }
}

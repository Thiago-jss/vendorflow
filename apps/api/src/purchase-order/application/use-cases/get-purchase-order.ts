import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import { PurchaseOrderNotFoundError } from "../contracts/purchase-order.errors";
import {
  PURCHASE_ORDER_REPOSITORY,
  type PurchaseOrderRecord,
  type PurchaseOrderRepository,
} from "../contracts/purchase-order.repository";
import { assertMayAdministerPurchaseOrders } from "../support/purchase-order-authorization";

/**
 * FR-054's read half. One purchase order of the caller's organization.
 *
 * The capability is asserted before the read, so a principal without it never causes a lookup
 * and cannot learn from response timing whether an identifier exists. The read carries the
 * tenant in its predicate, so an unknown identifier and another organization's are one answer
 * (MT-004).
 */
@Injectable()
export class GetPurchaseOrder {
  constructor(
    @Inject(PURCHASE_ORDER_REPOSITORY)
    private readonly purchaseOrders: PurchaseOrderRepository,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    purchaseOrderId: string,
  ): Promise<PurchaseOrderRecord> {
    assertMayAdministerPurchaseOrders(principal, "read");

    const order = await this.purchaseOrders.find({
      organizationId: principal.organizationId,
      purchaseOrderId,
    });

    if (order === null) {
      throw new PurchaseOrderNotFoundError();
    }

    return order;
  }
}

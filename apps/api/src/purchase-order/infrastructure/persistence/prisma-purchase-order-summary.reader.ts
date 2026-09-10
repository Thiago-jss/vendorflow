import { Injectable } from "@nestjs/common";
import { DatabaseService } from "@vendorflow/database";
import type {
  PurchaseOrderSummary,
  PurchaseOrderSummaryReader,
  TenantRequestCriteria,
} from "../../../procurement/application/contracts/purchase-request-supplements";

/**
 * FR-026's ordering half, on the inverted port `procurement` declares.
 *
 * `procurement` may not import this module (ADR-001 rule 2, and a cycle otherwise), so it
 * declares the shape it wants and this adapter satisfies it. The read is tenant-scoped and
 * deliberately narrow: the order's identity, its number, its state, one exact amount and two
 * instants. The supplier's snapshotted legal name and fiscal identifier are **not** here — a
 * requester reading their own request needs to know an order exists and what it cost, not to
 * receive a copy of a supplier's fiscal data on a route that was not asking for it.
 */
@Injectable()
export class PrismaPurchaseOrderSummaryReader
  implements PurchaseOrderSummaryReader
{
  constructor(private readonly database: DatabaseService) {}

  async findForRequest(
    criteria: TenantRequestCriteria,
  ): Promise<PurchaseOrderSummary | null> {
    const order = await this.database.purchaseOrder.findUnique({
      where: {
        organizationId_purchaseRequestId: {
          organizationId: criteria.organizationId,
          purchaseRequestId: criteria.purchaseRequestId,
        },
      },
      select: {
        id: true,
        number: true,
        status: true,
        totalCents: true,
        issuedAt: true,
        cancelledAt: true,
      },
    });

    if (order === null) {
      return null;
    }

    return {
      purchaseOrderId: order.id,
      number: order.number,
      status: order.status === "CANCELLED" ? "CANCELLED" : "ISSUED",
      totalCents: order.totalCents,
      issuedAt: order.issuedAt,
      cancelledAt: order.cancelledAt,
    };
  }
}

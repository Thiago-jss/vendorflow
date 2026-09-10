import { Injectable } from "@nestjs/common";
import { DatabaseService } from "@vendorflow/database";
import type {
  SelectedQuoteSummary,
  SelectedQuoteSummaryReader,
  TenantRequestCriteria,
} from "../../../procurement/application/contracts/purchase-request-supplements";

/**
 * FR-026's quotation half, on the inverted port `procurement` declares.
 *
 * `procurement` may not import this module (ADR-001 rule 2, and a cycle otherwise), so it
 * declares the shape it wants and this adapter satisfies it. The read is tenant-scoped and
 * deliberately narrow: identifiers, one exact amount, two dates and a lead time. The selection
 * rationale is **not** here — it is auditable text about a supplier, not part of a requester's
 * view of their own request.
 */
@Injectable()
export class PrismaSelectedQuoteSummaryReader
  implements SelectedQuoteSummaryReader
{
  constructor(private readonly database: DatabaseService) {}

  async findForRequest(
    criteria: TenantRequestCriteria,
  ): Promise<SelectedQuoteSummary | null> {
    const quote = await this.database.supplierQuote.findFirst({
      where: {
        organizationId: criteria.organizationId,
        purchaseRequestId: criteria.purchaseRequestId,
        status: "SELECTED",
      },
      select: {
        id: true,
        supplierId: true,
        totalCents: true,
        validUntil: true,
        deliveryLeadTimeDays: true,
        selectedAt: true,
      },
    });

    if (quote === null || quote.selectedAt === null) {
      return null;
    }

    return {
      supplierQuoteId: quote.id,
      supplierId: quote.supplierId,
      totalCents: quote.totalCents,
      validUntil: quote.validUntil,
      deliveryLeadTimeDays: quote.deliveryLeadTimeDays,
      selectedAt: quote.selectedAt,
    };
  }
}

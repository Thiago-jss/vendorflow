import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  NO_PURCHASE_REQUEST_SUPPLEMENTS,
  PURCHASE_ORDER_SUMMARY_READER,
  SELECTED_QUOTE_SUMMARY_READER,
  mayHaveSupplements,
  type PurchaseOrderSummaryReader,
  type PurchaseRequestSupplements,
  type SelectedQuoteSummaryReader,
} from "../contracts/purchase-request-supplements";
import type { PurchaseRequestRecord } from "../contracts/purchase-request.repository";

/**
 * FR-026. Adds the selected quote and the purchase order to a request read, when they exist.
 *
 * Both readers are optional injections. A request read therefore degrades to "no supplements"
 * rather than failing when a module is not registered, which is what keeps the request routes
 * a property of `procurement` alone.
 *
 * The status gate is not an optimization: a DRAFT, a SUBMITTED request and one still in
 * quotation cannot have either, so asking is pointless — and both reads are tenant-scoped
 * anyway, so a wrong answer is not reachable, only a wasted query.
 */
@Injectable()
export class ReadPurchaseRequestSupplements {
  constructor(
    @Optional()
    @Inject(SELECTED_QUOTE_SUMMARY_READER)
    private readonly selectedQuotes: SelectedQuoteSummaryReader | null = null,
    @Optional()
    @Inject(PURCHASE_ORDER_SUMMARY_READER)
    private readonly purchaseOrders: PurchaseOrderSummaryReader | null = null,
  ) {}

  async execute(
    organizationId: string,
    request: PurchaseRequestRecord,
  ): Promise<PurchaseRequestSupplements> {
    if (!mayHaveSupplements(request.status)) {
      return NO_PURCHASE_REQUEST_SUPPLEMENTS;
    }

    const criteria = { organizationId, purchaseRequestId: request.id };
    const [selectedQuote, purchaseOrder] = await Promise.all([
      this.selectedQuotes?.findForRequest(criteria) ?? null,
      this.purchaseOrders?.findForRequest(criteria) ?? null,
    ]);

    return { selectedQuote, purchaseOrder };
  }
}

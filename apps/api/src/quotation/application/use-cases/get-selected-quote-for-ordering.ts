import { Inject, Injectable } from "@nestjs/common";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import { SupplierQuoteNotFoundError } from "../contracts/quotation.errors";
import {
  SUPPLIER_QUOTE_REPOSITORY,
  type SupplierQuoteRecord,
  type SupplierQuoteRepository,
  type TenantRequestQuoteCriteria,
} from "../contracts/supplier-quote.repository";

/**
 * FR-051. `quotation`'s published answer to "which quote won this request, and at what prices?".
 *
 * It exists so `purchase-order` can build its snapshot without ever reading `supplier_quotes`
 * (ADR-001 rule 2), and it takes the caller's `TransactionScope` so the prices it returns are
 * the prices the issuance transaction commits against.
 *
 * A request with no selected quote raises not-found rather than returning `null`. FR-050 only
 * lets an order be issued from an approved request, and an approved request always has a
 * selected quote — so the absence is a broken invariant, not an ordinary outcome to branch on.
 */
@Injectable()
export class GetSelectedQuoteForOrdering {
  constructor(
    @Inject(SUPPLIER_QUOTE_REPOSITORY)
    private readonly supplierQuotes: SupplierQuoteRepository,
  ) {}

  async execute(
    scope: TransactionScope,
    criteria: TenantRequestQuoteCriteria,
  ): Promise<SupplierQuoteRecord> {
    const quote = await this.supplierQuotes.findSelectedForRequest(
      scope,
      criteria,
    );

    if (quote === null) {
      throw new SupplierQuoteNotFoundError();
    }

    return quote;
  }
}

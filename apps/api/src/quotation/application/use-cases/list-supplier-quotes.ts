import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import { GetOrganizationPurchaseRequest } from "../../../procurement/application/use-cases/get-organization-purchase-request";
import {
  SUPPLIER_QUOTE_REPOSITORY,
  type SupplierQuoteListCursor,
  type SupplierQuotePage,
  type SupplierQuoteRepository,
} from "../contracts/supplier-quote.repository";
import { assertMayRunQuotation } from "../support/quote-authorization";

/** NFR-004. Bounded here so no caller can ask for an unbounded collection. */
export const DEFAULT_SUPPLIER_QUOTE_PAGE_SIZE = 20;
export const MAXIMUM_SUPPLIER_QUOTE_PAGE_SIZE = 100;

export interface ListSupplierQuotesRequest {
  readonly limit?: number;
  readonly after: SupplierQuoteListCursor | null;
}

/**
 * FR-043. The quotes of one purchase request, side by side, cheapest first.
 *
 * The comparison is the whole point of the route, so it is ordered in the database by
 * `total_cents` ascending — an index exists for exactly that — rather than sorted in memory
 * after an unordered read. The quote identifier is the second ordering key, which is what
 * makes two suppliers at the same total a stable order instead of a physical one.
 *
 * NFR-004 is answered by bounding the *page*, not the business: a request may collect as many
 * quotes as a buyer can gather, and the route hands them back a bounded page at a time with a
 * keyset cursor. Capping the number of suppliers to avoid paginating would be answering a
 * performance requirement with a product rule.
 *
 * Withdrawn quotes are included (FR-046): a comparison that silently omits the offer a buyer
 * took back is a comparison that cannot explain itself later. They carry their status, and
 * selection refuses them.
 *
 * The request is read first, through `procurement`'s published organization-scoped read. That
 * is what turns an unknown, a cross-tenant and a wrong-state identifier into one 404 before any
 * quote row is touched (MT-004) — including when a cursor is supplied, so a cursor can never be
 * used to probe another tenant's request.
 */
@Injectable()
export class ListSupplierQuotes {
  constructor(
    @Inject(SUPPLIER_QUOTE_REPOSITORY)
    private readonly supplierQuotes: SupplierQuoteRepository,
    private readonly getOrganizationPurchaseRequest: GetOrganizationPurchaseRequest,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    purchaseRequestId: string,
    request: ListSupplierQuotesRequest,
  ): Promise<SupplierQuotePage> {
    assertMayRunQuotation(principal, "compare");

    await this.getOrganizationPurchaseRequest.execute({
      organizationId: principal.organizationId,
      purchaseRequestId,
    });

    return this.supplierQuotes.listForRequest({
      organizationId: principal.organizationId,
      purchaseRequestId,
      // The HTTP boundary already refuses a limit outside the range with a 400; this restates
      // the bound for any caller that has no HTTP boundary, so the collection is bounded by
      // the use case rather than by the adapter in front of it.
      limit: Math.min(
        Math.max(request.limit ?? DEFAULT_SUPPLIER_QUOTE_PAGE_SIZE, 1),
        MAXIMUM_SUPPLIER_QUOTE_PAGE_SIZE,
      ),
      after: request.after,
    });
  }
}

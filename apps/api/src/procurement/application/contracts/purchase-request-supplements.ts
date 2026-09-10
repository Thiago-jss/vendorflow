import type { PurchaseRequestStatus } from "../support/purchase-request-status";

/**
 * FR-026, extended additively once quotation and ordering exist.
 *
 * A requester reading their own request wants to know which quote won and whether an order was
 * issued. Both facts belong to other modules — `quotation` owns SupplierQuote and
 * `purchase-order` owns PurchaseOrder — and ADR-001 forbids `procurement` from importing
 * either. Importing them here would also invert the dependency the rest of the system depends
 * on: `quotation` and `purchase-order` call *into* procurement, and a cycle between them would
 * have to be papered over with `forwardRef`.
 *
 * So the dependency is inverted instead. `procurement` declares the two narrow shapes it wants
 * and the tokens they arrive under; the owning modules implement them and register the
 * provider. Neither of these is a plugin registry or an extension point: there are exactly two
 * ports, each with exactly one implementation, each describing one concrete fact. A third
 * would be a third named port, not a list.
 *
 * Both are injected `@Optional()`, so `procurement` boots and serves every route it owns even
 * when neither module is present — which is what the modular monolith's module boundaries are
 * supposed to buy.
 */
export const SELECTED_QUOTE_SUMMARY_READER = Symbol(
  "SELECTED_QUOTE_SUMMARY_READER",
);

export const PURCHASE_ORDER_SUMMARY_READER = Symbol(
  "PURCHASE_ORDER_SUMMARY_READER",
);

export interface TenantRequestCriteria {
  readonly organizationId: string;
  readonly purchaseRequestId: string;
}

/**
 * BR-032. Every amount is exact centavos as a `bigint`, and reaches the wire as a digit
 * string, for the same reason every other amount does.
 */
export interface SelectedQuoteSummary {
  readonly supplierQuoteId: string;
  readonly supplierId: string;
  readonly totalCents: bigint;
  readonly validUntil: Date;
  readonly deliveryLeadTimeDays: number;
  readonly selectedAt: Date;
}

export interface SelectedQuoteSummaryReader {
  findForRequest(
    criteria: TenantRequestCriteria,
  ): Promise<SelectedQuoteSummary | null>;
}

export interface PurchaseOrderSummary {
  readonly purchaseOrderId: string;
  readonly number: string;
  readonly status: "ISSUED" | "CANCELLED";
  readonly totalCents: bigint;
  readonly issuedAt: Date;
  readonly cancelledAt: Date | null;
}

export interface PurchaseOrderSummaryReader {
  findForRequest(
    criteria: TenantRequestCriteria,
  ): Promise<PurchaseOrderSummary | null>;
}

/**
 * FR-026. What a request read carries beyond the request and its approval ladder.
 *
 * Both members are `null` until the corresponding thing exists, which is how "no quote has
 * been selected" stays distinguishable from "a quote was selected and here it is" without
 * inspecting the request's status.
 */
export interface PurchaseRequestSupplements {
  readonly selectedQuote: SelectedQuoteSummary | null;
  readonly purchaseOrder: PurchaseOrderSummary | null;
}

/** Nothing to add: the request is a DRAFT, or neither module is registered. */
export const NO_PURCHASE_REQUEST_SUPPLEMENTS: PurchaseRequestSupplements = {
  selectedQuote: null,
  purchaseOrder: null,
};

/** The lifecycle points at which either supplement can exist at all. */
export function mayHaveSupplements(status: PurchaseRequestStatus): boolean {
  return (
    status === "IN_FINAL_APPROVAL" ||
    status === "APPROVED" ||
    status === "ORDERED" ||
    status === "REJECTED" ||
    status === "CANCELLED"
  );
}

import { formatCents } from "../../../platform/numeric/centavos";

/**
 * AUD-002's typed payload for the two purchase order facts this phase audits.
 *
 * The supplier appears as an **identifier only**. The order row itself snapshots the supplier's
 * legal name and fiscal identifier because FR-051 requires the document to record who it was
 * issued to; copying either into the append-only trail would duplicate fiscal data into a store
 * that is never deleted, for no fact the identifier does not already carry (SEC-009, AUD-003).
 *
 * The purchase order **number** is here, and it is not sensitive: it is the identifier a person
 * will use to talk about this order, and an audit trail that cannot name what it audits is not
 * much of a trail.
 *
 * The cancellation reason is kept for the same reason a selection rationale is: FR-054 makes it
 * the explanation of the decision, and it never leaves tenant-scoped storage.
 *
 * These are type aliases rather than interfaces on purpose: a type alias of an object literal
 * carries an implicit index signature, so the compiler proves each payload is JSON-safe.
 */
export type PurchaseOrderIssuedAuditPayload = {
  readonly number: string;
  readonly purchaseRequestId: string;
  readonly supplierQuoteId: string;
  readonly supplierId: string;
  readonly itemCount: number;
  readonly itemsTotalCents: string;
  readonly freightCents: string;
  readonly discountCents: string;
  readonly totalCents: string;
  readonly deliveryLeadTimeDays: number;
};

export type PurchaseOrderCancelledAuditPayload = {
  readonly number: string;
  readonly purchaseRequestId: string;
  readonly totalCents: string;
  readonly cancellationReason: string;
};

export function purchaseOrderIssuedPayload(input: {
  readonly number: string;
  readonly purchaseRequestId: string;
  readonly supplierQuoteId: string;
  readonly supplierId: string;
  readonly itemCount: number;
  readonly itemsTotalCents: bigint;
  readonly freightCents: bigint;
  readonly discountCents: bigint;
  readonly totalCents: bigint;
  readonly deliveryLeadTimeDays: number;
}): PurchaseOrderIssuedAuditPayload {
  return {
    number: input.number,
    purchaseRequestId: input.purchaseRequestId,
    supplierQuoteId: input.supplierQuoteId,
    supplierId: input.supplierId,
    itemCount: input.itemCount,
    itemsTotalCents: formatCents(input.itemsTotalCents),
    freightCents: formatCents(input.freightCents),
    discountCents: formatCents(input.discountCents),
    totalCents: formatCents(input.totalCents),
    deliveryLeadTimeDays: input.deliveryLeadTimeDays,
  };
}

export function purchaseOrderCancelledPayload(input: {
  readonly number: string;
  readonly purchaseRequestId: string;
  readonly totalCents: bigint;
  readonly cancellationReason: string;
}): PurchaseOrderCancelledAuditPayload {
  return {
    number: input.number,
    purchaseRequestId: input.purchaseRequestId,
    totalCents: formatCents(input.totalCents),
    cancellationReason: input.cancellationReason,
  };
}

import { formatCents } from "../../../platform/numeric/centavos";

/**
 * The outgoing fact a purchase order issuance emits (ADR-003, FR-062).
 *
 * FR-062 requires the requester to be notified when their order is issued, which is what this
 * message is for. It is deliberately narrower than the audit payload next door:
 *
 * - **No supplier legal name and no fiscal identifier.** Both are on the order row, where they
 *   belong; neither goes on a queue. A consumer that needs either reads PostgreSQL under a
 *   tenant-scoped query.
 * - **No cancellation reason and no selection rationale.** Neither exists at issuance, and
 *   neither would be published if it did.
 * - **Identifiers, one number and amounts as digit strings** (BR-031).
 *
 * There is deliberately **no cancellation event**. FR-062 names next-actor, approval, rejection
 * and order-issued notifications; it does not name cancellation, and no consumer in this system
 * subscribes to one. Emitting a message nobody receives, to satisfy a symmetry nobody asked
 * for, would be inventing a requirement — and every unread message is a retry ladder, a
 * dead-letter queue and an operational surface that has to be justified by a reader.
 *
 * This is a type alias rather than an interface on purpose: a type alias of an object literal
 * carries an implicit index signature, so the compiler proves the payload satisfies
 * `OutgoingEventPayload`.
 */
export type PurchaseOrderIssuedEventPayload = {
  readonly status: string;
  readonly number: string;
  readonly purchaseRequestId: string;
  readonly supplierQuoteId: string;
  readonly supplierId: string;
  readonly totalCents: string;
  readonly deliveryLeadTimeDays: number;
  readonly requesterId: string;
  readonly issuedById: string;
};

export function purchaseOrderIssuedEventPayload(input: {
  readonly number: string;
  readonly purchaseRequestId: string;
  readonly supplierQuoteId: string;
  readonly supplierId: string;
  readonly totalCents: bigint;
  readonly deliveryLeadTimeDays: number;
  readonly requesterId: string;
  readonly issuedById: string;
}): PurchaseOrderIssuedEventPayload {
  return {
    status: "ISSUED",
    number: input.number,
    purchaseRequestId: input.purchaseRequestId,
    supplierQuoteId: input.supplierQuoteId,
    supplierId: input.supplierId,
    totalCents: formatCents(input.totalCents),
    deliveryLeadTimeDays: input.deliveryLeadTimeDays,
    requesterId: input.requesterId,
    issuedById: input.issuedById,
  };
}

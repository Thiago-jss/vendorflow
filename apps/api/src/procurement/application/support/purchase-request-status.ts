/**
 * BR-010. Every state the purchase request lifecycle defines. The list is complete even
 * though this phase can only reach three of them, because a state the domain knows about
 * but the schema does not is a migration waiting to happen.
 */
export const purchaseRequestStatuses = [
  "DRAFT",
  "SUBMITTED",
  "IN_QUOTATION",
  "IN_FINAL_APPROVAL",
  "APPROVED",
  "ORDERED",
  "REJECTED",
  "CANCELLED",
] as const;

export type PurchaseRequestStatus = (typeof purchaseRequestStatuses)[number];

/**
 * BR-011, restricted to what this phase implements.
 *
 * The full rule set also allows SUBMITTED → IN_QUOTATION | REJECTED and everything past it,
 * but those transitions belong to actors and aggregates that do not exist yet (approval,
 * quotation, ordering). Declaring them here would mean writing a state machine nothing can
 * drive and no test can prove, so each phase adds its own edges. Anything absent from this
 * table is refused (AUTHZ-003, AUTHZ-005).
 */
const REQUESTER_TRANSITIONS: Readonly<
  Record<string, readonly PurchaseRequestStatus[]>
> = {
  SUBMITTED: ["DRAFT"],
  CANCELLED: ["DRAFT", "SUBMITTED"],
};

/** The only state in which a requester may change a request's content (FR-022, FR-023). */
export const EDITABLE_BY_REQUESTER_STATUSES: readonly PurchaseRequestStatus[] = [
  "DRAFT",
];

/** FR-023. */
export const SUBMITTABLE_STATUSES: readonly PurchaseRequestStatus[] =
  REQUESTER_TRANSITIONS.SUBMITTED ?? [];

/**
 * FR-025 and BR-013 allow cancellation from every state before ORDERED. Only DRAFT and
 * SUBMITTED are reachable in this phase, so those are the only states the rule can be
 * written against without inventing behaviour for unreachable ones.
 */
export const REQUESTER_CANCELLABLE_STATUSES: readonly PurchaseRequestStatus[] =
  REQUESTER_TRANSITIONS.CANCELLED ?? [];

/** BR-013: cancellation is refused once a purchase order exists. */
export const NON_CANCELLABLE_STATUSES: readonly PurchaseRequestStatus[] = [
  "ORDERED",
];

export function isRequesterTransitionAllowed(
  from: PurchaseRequestStatus,
  to: PurchaseRequestStatus,
): boolean {
  return (REQUESTER_TRANSITIONS[to] ?? []).includes(from);
}

export function isEditableByRequester(status: PurchaseRequestStatus): boolean {
  return EDITABLE_BY_REQUESTER_STATUSES.includes(status);
}

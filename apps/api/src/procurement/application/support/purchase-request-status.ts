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
 * BR-011, restricted to what this phase implements, and split by *who drives the edge*.
 *
 * A requester submits and cancels. Nothing else in this table is theirs to do: the approval
 * edges below are driven by a decision maker acting on an approval step, and the quotation
 * and ordering edges belong to actors and aggregates that do not exist yet. Declaring an edge
 * nothing can drive would be a state machine no test can prove, so each phase adds its own.
 * Anything absent from both tables is refused (AUTHZ-003, AUTHZ-005).
 */
const REQUESTER_TRANSITIONS: Readonly<
  Record<string, readonly PurchaseRequestStatus[]>
> = {
  SUBMITTED: ["DRAFT"],
  // FR-025/BR-013: every state before ORDERED. IN_QUOTATION joins the list in this phase
  // because a Manager approval can now put a request there — the rule did not change, the
  // set of reachable states did.
  CANCELLED: ["DRAFT", "SUBMITTED", "IN_QUOTATION"],
};

/**
 * FR-032. The edges a decision on the Manager approval step drives, and the only two the
 * approval half of the state machine implements in this phase. The Purchasing and Finance
 * steps decide nothing about the request's state until a quote is selected (BR-002).
 */
const APPROVAL_TRANSITIONS: Readonly<
  Record<string, readonly PurchaseRequestStatus[]>
> = {
  IN_QUOTATION: ["SUBMITTED"],
  REJECTED: ["SUBMITTED"],
};

/** The only state in which a requester may change a request's content (FR-022, FR-023). */
export const EDITABLE_BY_REQUESTER_STATUSES: readonly PurchaseRequestStatus[] = [
  "DRAFT",
];

/** FR-023. */
export const SUBMITTABLE_STATUSES: readonly PurchaseRequestStatus[] =
  REQUESTER_TRANSITIONS.SUBMITTED ?? [];

/**
 * FR-025 and BR-013 allow cancellation from every state before ORDERED. DRAFT, SUBMITTED and
 * IN_QUOTATION are the states reachable in this phase, so those are the only ones the rule
 * can be written against without inventing behaviour for unreachable ones.
 */
export const REQUESTER_CANCELLABLE_STATUSES: readonly PurchaseRequestStatus[] =
  REQUESTER_TRANSITIONS.CANCELLED ?? [];

/**
 * FR-030/AUTHZ-005. The only state in which a Manager approval step may be decided. It is
 * re-stated inside the conditional write, so it is a predicate and not only a pre-check.
 */
export const APPROVAL_DECIDABLE_STATUSES: readonly PurchaseRequestStatus[] =
  APPROVAL_TRANSITIONS.IN_QUOTATION ?? [];

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

export function isApprovalTransitionAllowed(
  from: PurchaseRequestStatus,
  to: PurchaseRequestStatus,
): boolean {
  return (APPROVAL_TRANSITIONS[to] ?? []).includes(from);
}

export function isEditableByRequester(status: PurchaseRequestStatus): boolean {
  return EDITABLE_BY_REQUESTER_STATUSES.includes(status);
}

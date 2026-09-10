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
 * BR-011, split by *who drives the edge*.
 *
 * A requester submits and cancels. The approval edges are driven by a decision maker acting on
 * the step the flow is waiting on; the quotation edge is driven by a Buyer selecting a quote;
 * the ordering edge is driven by a Buyer issuing a purchase order. Splitting the table this
 * way is what keeps "who may cause this" and "which states permit it" from collapsing into one
 * list that nothing can check. Anything absent from all four tables is refused (AUTHZ-003,
 * AUTHZ-005).
 *
 * `procurement` owns every one of these edges. Quotation and ordering live in other modules
 * and reach them through published operations, never by writing a status themselves.
 */
const REQUESTER_TRANSITIONS: Readonly<
  Record<string, readonly PurchaseRequestStatus[]>
> = {
  SUBMITTED: ["DRAFT"],
  // FR-025/BR-013: every state before ORDERED. IN_FINAL_APPROVAL and APPROVED join the list
  // in this phase because quote selection can now put a request there — the rule did not
  // change, the set of reachable states did.
  CANCELLED: [
    "DRAFT",
    "SUBMITTED",
    "IN_QUOTATION",
    "IN_FINAL_APPROVAL",
    "APPROVED",
  ],
};

/**
 * FR-032/FR-034. The edges an approval decision drives.
 *
 * A Manager decision acts on a SUBMITTED request and either opens quotation or ends the
 * request. A Purchasing or Finance decision acts on a request in IN_FINAL_APPROVAL — the state
 * a quote selection put it in — and either finishes the ladder or ends the request. An
 * approval that leaves a further rung standing drives no edge at all: the request stays in
 * IN_FINAL_APPROVAL, which is why `null` is a legitimate target below.
 */
const APPROVAL_TRANSITIONS: Readonly<
  Record<string, readonly PurchaseRequestStatus[]>
> = {
  IN_QUOTATION: ["SUBMITTED"],
  APPROVED: ["IN_FINAL_APPROVAL"],
  REJECTED: ["SUBMITTED", "IN_FINAL_APPROVAL"],
};

/**
 * FR-045. The edges a quote selection drives. Which of the two is taken is decided by BR-003's
 * re-evaluation — APPROVED when nothing remains to approve, IN_FINAL_APPROVAL otherwise — and
 * never by the client.
 */
const QUOTE_SELECTION_TRANSITIONS: Readonly<
  Record<string, readonly PurchaseRequestStatus[]>
> = {
  IN_FINAL_APPROVAL: ["IN_QUOTATION"],
  APPROVED: ["IN_QUOTATION"],
};

/** FR-052. Issuing a purchase order is the only edge into ORDERED, and it is terminal. */
const ORDERING_TRANSITIONS: Readonly<
  Record<string, readonly PurchaseRequestStatus[]>
> = {
  ORDERED: ["APPROVED"],
};

/** The only state in which a requester may change a request's content (FR-022, FR-023). */
export const EDITABLE_BY_REQUESTER_STATUSES: readonly PurchaseRequestStatus[] = [
  "DRAFT",
];

/** FR-023. */
export const SUBMITTABLE_STATUSES: readonly PurchaseRequestStatus[] =
  REQUESTER_TRANSITIONS.SUBMITTED ?? [];

/**
 * FR-025 and BR-013 allow cancellation from every state before ORDERED, and every one of them
 * is now reachable.
 */
export const REQUESTER_CANCELLABLE_STATUSES: readonly PurchaseRequestStatus[] =
  REQUESTER_TRANSITIONS.CANCELLED ?? [];

/**
 * FR-030/AUTHZ-005. The only state in which a Manager approval step may be decided. It is
 * re-stated inside the conditional write, so it is a predicate and not only a pre-check.
 */
export const MANAGER_DECIDABLE_STATUSES: readonly PurchaseRequestStatus[] =
  APPROVAL_TRANSITIONS.IN_QUOTATION ?? [];

/**
 * FR-034/AUTHZ-005. The only state in which a Purchasing or Finance step may be decided. A
 * request reaches it by having a quote selected, so those steps cannot be decided before the
 * amount they approve exists (BR-002).
 */
export const POST_QUOTATION_DECIDABLE_STATUSES: readonly PurchaseRequestStatus[] =
  ["IN_FINAL_APPROVAL"];

/** BR-020. Quotes are registered and selected only while the request is in quotation. */
export const QUOTABLE_STATUSES: readonly PurchaseRequestStatus[] = [
  "IN_QUOTATION",
];

/** FR-050. A purchase order is issued only from an approved request. */
export const ORDERABLE_STATUSES: readonly PurchaseRequestStatus[] =
  ORDERING_TRANSITIONS.ORDERED ?? [];

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

export function isQuoteSelectionTransitionAllowed(
  from: PurchaseRequestStatus,
  to: PurchaseRequestStatus,
): boolean {
  return (QUOTE_SELECTION_TRANSITIONS[to] ?? []).includes(from);
}

export function isOrderingTransitionAllowed(
  from: PurchaseRequestStatus,
  to: PurchaseRequestStatus,
): boolean {
  return (ORDERING_TRANSITIONS[to] ?? []).includes(from);
}

export function isEditableByRequester(status: PurchaseRequestStatus): boolean {
  return EDITABLE_BY_REQUESTER_STATUSES.includes(status);
}

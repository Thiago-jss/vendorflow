/**
 * AUD-001, restricted to the actions this phase can actually produce. The list grows when the
 * action that emits an event exists, not in anticipation of one.
 */
export const auditEventTypes = [
  "PURCHASE_REQUEST_SUBMITTED",
  "PURCHASE_REQUEST_CANCELLED",
  "APPROVAL_STEP_APPROVED",
  "APPROVAL_STEP_REJECTED",
  "SUPPLIER_CREATED",
  "SUPPLIER_DEACTIVATED",
  "SUPPLIER_QUOTE_REGISTERED",
  "SUPPLIER_QUOTE_WITHDRAWN",
  "SUPPLIER_QUOTE_SELECTED",
  /**
   * BR-003, emitted only when the re-evaluation actually changed the ladder. "The rule was
   * consulted" is not an audited action; "two steps were voided and Finance was appended" is.
   */
  "APPROVAL_FLOW_REEVALUATED",
  "PURCHASE_ORDER_ISSUED",
  "PURCHASE_ORDER_CANCELLED",
] as const;

export type AuditEventType = (typeof auditEventTypes)[number];

/**
 * The aggregate an event is filed under, and the filing is a decision rather than a
 * classification.
 *
 * Quote registration, withdrawal, selection and the approval re-evaluation are all filed under
 * the **PurchaseRequest**, even though the first three are facts about a quote. That is what
 * makes AUD-005 true: the decisions that led to one purchase are reconstructable in a single
 * ordered read of one aggregate, rather than scattered across a request, three quotes and a
 * flow that a reader would have to join by hand.
 *
 * A Supplier's own lifecycle is filed under the Supplier, because it is not a fact about any
 * one request. A Purchase Order is filed under itself, because it outlives the request's
 * workflow: FR-054 lets it be cancelled long after the request reached ORDERED, and an order's
 * own history is what an operator will be asked about.
 */
export const auditAggregateTypes = [
  "PURCHASE_REQUEST",
  "SUPPLIER",
  "PURCHASE_ORDER",
] as const;

export type AuditAggregateType = (typeof auditAggregateTypes)[number];

/**
 * What may appear in a payload. Deliberately scalar-only and deliberately without `number`
 * for amounts: every monetary value crosses this boundary as a digit string, because a JSON
 * number is an IEEE-754 double to every reader of the audit trail (BR-031). The emitting
 * module declares the concrete shape of its own payloads; this is the floor they satisfy.
 */
export type AuditEventPayloadValue = string | number | boolean | null;

export type AuditEventPayload = Readonly<
  Record<string, AuditEventPayloadValue>
>;

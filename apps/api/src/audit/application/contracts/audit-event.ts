/**
 * AUD-001, restricted to the actions this phase can actually produce. The list grows when the
 * action that emits an event exists, not in anticipation of one.
 */
export const auditEventTypes = [
  "PURCHASE_REQUEST_SUBMITTED",
  "PURCHASE_REQUEST_CANCELLED",
  "APPROVAL_STEP_APPROVED",
  "APPROVAL_STEP_REJECTED",
] as const;

export type AuditEventType = (typeof auditEventTypes)[number];

/**
 * The aggregate an event is filed under. All four events of this phase are facts about one
 * PurchaseRequest — the decision events name the request and carry the step's identity in
 * their payload — which is what makes the decisions on a request reconstructable in one
 * ordered read (AUD-005).
 */
export const auditAggregateTypes = ["PURCHASE_REQUEST"] as const;

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

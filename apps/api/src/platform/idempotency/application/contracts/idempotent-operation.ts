/**
 * REL-004 names four client-initiated operations that create durable artifacts: submission,
 * approval decision, quote selection and purchase order issuance. This list is exactly those
 * four and it is deliberately closed.
 *
 * There is no generic "make any request idempotent" facility here. An idempotency record is
 * a promise that a retry produces no second effect, and that promise can only be kept where
 * the effect is a single transaction whose semantic outcome can be described in a few
 * scalars. A value is added when such an operation exists, not in anticipation of one.
 */
export const idempotentOperations = [
  "PURCHASE_REQUEST_SUBMISSION",
  "APPROVAL_DECISION",
  "QUOTE_SELECTION",
  "PURCHASE_ORDER_ISSUANCE",
] as const;

export type IdempotentOperation = (typeof idempotentOperations)[number];

/**
 * What may be persisted as a replayable outcome. Scalars only, and the same rule money obeys
 * everywhere else: an amount is a digit string, never a JSON number (BR-031).
 *
 * What may **never** appear here, whatever its type: the raw Idempotency-Key, an
 * Authorization header, a cookie, a token, a password, a request body, a rejection or
 * selection rationale, a cancellation reason, a supplier's fiscal identifier, a legal or
 * trade name, an email address or a phone number. The outcome exists to identify *what
 * happened*, so a replay can re-read it through the same authorized path the first caller
 * used — not to cache a response.
 */
export type IdempotencyOutcomeValue = string | number | boolean | null;

export type IdempotencyOutcome = Readonly<
  Record<string, IdempotencyOutcomeValue>
>;

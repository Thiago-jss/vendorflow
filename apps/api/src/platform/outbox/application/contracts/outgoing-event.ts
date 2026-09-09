/**
 * The outgoing facts this phase emits, and the rules their payloads obey.
 *
 * The list is closed and it grows the way `AuditEventType` grows: a value is added when the
 * transition that emits it exists. There is no generic event bus and no universal schema
 * here, because neither has a caller (ADR-003).
 */
export const outgoingEventTypes = [
  "PURCHASE_REQUEST_SUBMITTED",
  "PURCHASE_REQUEST_APPROVAL_DECIDED",
] as const;

export type OutgoingEventType = (typeof outgoingEventTypes)[number];

export const outgoingAggregateTypes = ["PURCHASE_REQUEST"] as const;

export type OutgoingAggregateType = (typeof outgoingAggregateTypes)[number];

/**
 * Version of the envelope shape, carried on every message so a consumer can refuse what it
 * does not understand instead of guessing. It changes when the envelope changes, not when a
 * payload gains a field.
 */
export const OUTGOING_EVENT_SCHEMA_VERSION = 1;

/**
 * What may appear in a payload. Scalar-only, and deliberately without `number` for money:
 * every monetary value crosses this boundary as a digit string, because a JSON number is an
 * IEEE-754 double to every reader of the message (BR-031). This is the same floor
 * `AuditEventPayload` sets, for the same reason.
 *
 * What may **not** appear, whatever its type: access tokens, refresh tokens, passwords,
 * cookies, request bodies, justifications, approval reasons, names and email addresses. A
 * consumer that needs any of those reads PostgreSQL under a tenant-scoped query; it does not
 * receive them over a queue.
 */
export type OutgoingEventPayloadValue = string | number | boolean | null;

export type OutgoingEventPayload = Readonly<
  Record<string, OutgoingEventPayloadValue>
>;

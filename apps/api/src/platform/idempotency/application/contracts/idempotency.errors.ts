/**
 * The header was absent, or present but not a usable token. Both are answered as a controlled
 * 400: the request is malformed, and no business logic runs.
 *
 * The message states the rule and never echoes the submitted value — an Idempotency-Key is a
 * client-chosen token that may well be reused elsewhere, so it belongs in no error string and
 * in no log line (SEC-009).
 */
export class IdempotencyKeyInvalidError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "IdempotencyKeyInvalidError";
  }
}

/**
 * REL-004, failing closed. The same actor presented the same key for the same operation, but
 * the request means something different this time — a different quote, a different decision,
 * a different request identifier.
 *
 * Replaying the first answer would tell the caller that something happened which did not, and
 * executing the second would defeat the key. So neither happens: it is a conflict, and the
 * caller must choose a new key for a new intent.
 */
export class IdempotencyKeyConflictError extends Error {
  constructor() {
    super(
      "This idempotency key was already used for a different request. Use a new key for a new request.",
    );
    this.name = "IdempotencyKeyConflictError";
  }
}

/**
 * Two calls carrying the same key raced, and this one lost the reservation. Raised at the
 * persistence boundary from the unique-constraint violation, so a driver error code never
 * reaches a caller or a 500 (ADR-002).
 *
 * It is internal to the idempotency capability: `ExecuteIdempotently` catches it, re-reads the
 * winner's committed record and replays it. It only escapes if the winner's transaction rolled
 * back after all, which leaves nothing to replay and is a genuine retryable conflict.
 */
export class IdempotencyReservationConflictError extends Error {
  constructor() {
    super("A concurrent request with the same idempotency key is in progress");
    this.name = "IdempotencyReservationConflictError";
  }
}

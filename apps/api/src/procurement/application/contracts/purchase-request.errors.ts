import type { PurchaseRequestStatus } from "../support/purchase-request-status";

/**
 * Missing and foreign identifiers raise exactly this, and nothing distinguishes them
 * (MT-004). No field carries the reason, so no caller can accidentally leak one.
 */
export class PurchaseRequestNotFoundError extends Error {
  constructor() {
    super("Purchase request was not found");
    this.name = "PurchaseRequestNotFoundError";
  }
}

/**
 * AUTHZ-003. The principal authenticated, but their current roles do not grant this
 * capability. Distinct from `PurchaseRequestNotFoundError`, which answers a question about a
 * specific row: this one is about the action itself and names no resource, so refusing it
 * cannot confirm that anything exists.
 */
export class PurchaseRequestActionNotAuthorizedError extends Error {
  constructor(readonly attemptedAction: string) {
    super(`This principal may not ${attemptedAction} a purchase request`);
    this.name = "PurchaseRequestActionNotAuthorizedError";
  }
}

/**
 * A domain invariant the request payload violated: no items, a quantity out of range, a
 * needed-by value that is not a calendar date. The message names the rule, never the
 * offending content — justifications and item descriptions are business data that must not
 * travel through error strings or logs (SEC-009).
 */
export class PurchaseRequestValidationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PurchaseRequestValidationError";
  }
}

/**
 * AUTHZ-005: the actor may perform this action, but the request's current state does not
 * permit it. Reporting the current status is safe — the caller already owns the request,
 * having passed the tenant- and requester-scoped read.
 */
export class PurchaseRequestTransitionNotAllowedError extends Error {
  constructor(
    readonly currentStatus: PurchaseRequestStatus,
    readonly attemptedAction: string,
  ) {
    super(
      `A purchase request in ${currentStatus} cannot be ${attemptedAction}`,
    );
    this.name = "PurchaseRequestTransitionNotAllowedError";
  }
}

/**
 * The conditional write matched no row although the read that preceded it did: another
 * request changed the state in between. The caller may retry against the new state.
 */
export class PurchaseRequestConcurrentlyModifiedError extends Error {
  constructor() {
    super("The purchase request changed while this operation was running");
    this.name = "PurchaseRequestConcurrentlyModifiedError";
  }
}

/** A pagination cursor that this API did not issue, or that no longer decodes. */
export class InvalidPaginationCursorError extends Error {
  constructor() {
    super("The pagination cursor is not valid");
    this.name = "InvalidPaginationCursorError";
  }
}

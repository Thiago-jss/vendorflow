/**
 * Missing and foreign identifiers raise exactly this, and nothing distinguishes them
 * (MT-004). No field carries the reason, so no caller can accidentally leak one.
 */
export class PurchaseOrderNotFoundError extends Error {
  constructor() {
    super("Purchase order was not found");
    this.name = "PurchaseOrderNotFoundError";
  }
}

/**
 * AUTHZ-003. The principal authenticated, but their roles do not grant this capability. It
 * names an action and never a resource, so refusing it confirms nothing about what exists.
 */
export class PurchaseOrderActionNotAuthorizedError extends Error {
  constructor(readonly attemptedAction: string) {
    super(`This principal may not ${attemptedAction} a purchase order`);
    this.name = "PurchaseOrderActionNotAuthorizedError";
  }
}

/** A domain rule refused a well-formed payload, such as a cancellation reason that is too short. */
export class PurchaseOrderValidationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PurchaseOrderValidationError";
  }
}

/**
 * FR-050. This request already has a purchase order. Enforced by a unique constraint on
 * `(organization_id, purchase_request_id)`, so two concurrent issuances produce one order and
 * one controlled conflict rather than two orders.
 */
export class PurchaseOrderAlreadyIssuedError extends Error {
  constructor() {
    super("This purchase request already has a purchase order");
    this.name = "PurchaseOrderAlreadyIssuedError";
  }
}

/**
 * FR-054. Cancellation is terminal, so an already-cancelled order cannot be cancelled again.
 * Deliberately not a 404 — the caller can see the order through its own route.
 */
export class PurchaseOrderNotCancellableError extends Error {
  constructor() {
    super("This purchase order has already been cancelled");
    this.name = "PurchaseOrderNotCancellableError";
  }
}

/** The conditional write matched no row: another operation changed the order underneath. */
export class PurchaseOrderConcurrentlyModifiedError extends Error {
  constructor() {
    super("The purchase order changed while this operation was running");
    this.name = "PurchaseOrderConcurrentlyModifiedError";
  }
}

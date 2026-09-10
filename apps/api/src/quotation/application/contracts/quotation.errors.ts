/**
 * Missing and foreign identifiers raise exactly this, and nothing distinguishes them
 * (MT-004). No field carries the reason, so no caller can accidentally leak one.
 */
export class SupplierQuoteNotFoundError extends Error {
  constructor() {
    super("Supplier quote was not found");
    this.name = "SupplierQuoteNotFoundError";
  }
}

/**
 * AUTHZ-003. The principal authenticated, but their roles do not grant this capability. It
 * names an action and never a resource, so refusing it confirms nothing about what exists.
 */
export class QuotationActionNotAuthorizedError extends Error {
  constructor(readonly attemptedAction: string) {
    super(`This principal may not ${attemptedAction} a supplier quote`);
    this.name = "QuotationActionNotAuthorizedError";
  }
}

/**
 * A domain rule refused a well-formed payload: a negative freight, a discount larger than the
 * goods, a line list that does not cover the request, a total that will not fit the column.
 * The message names the rule and never echoes an amount a supplier quoted (SEC-009).
 */
export class SupplierQuoteValidationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SupplierQuoteValidationError";
  }
}

/**
 * BR-022. This supplier already has an ACTIVE quote on this request. Registering a replacement
 * requires withdrawing the previous one first, which is a decision the Buyer makes rather than
 * one this system makes for them by silently superseding an offer.
 */
export class SupplierQuoteAlreadyActiveError extends Error {
  constructor() {
    super(
      "This supplier already has an active quote on this request. Withdraw it before registering another.",
    );
    this.name = "SupplierQuoteAlreadyActiveError";
  }
}

/**
 * AUTHZ-005. The quote exists and its own state forbids the action: a withdrawn quote cannot
 * be selected, a selected quote cannot be withdrawn (FR-046, BR-024). Deliberately not a 404 —
 * the caller can already see the quote through the list route, so hiding the reason would make
 * the refusal unexplainable.
 */
export class SupplierQuoteNotActionableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SupplierQuoteNotActionableError";
  }
}

/** BR-023. The quote's validity date has passed, so it may no longer be selected. */
export class SupplierQuoteExpiredError extends Error {
  constructor() {
    super("This quote is past its validity date and cannot be selected");
    this.name = "SupplierQuoteExpiredError";
  }
}

/**
 * BR-024. Another quote on this request was selected first, or the request left IN_QUOTATION
 * while this selection was running. The conditional write matched no row; nothing was written.
 */
export class SupplierQuoteConcurrentlyModifiedError extends Error {
  constructor() {
    super("The quotation changed while this operation was running");
    this.name = "SupplierQuoteConcurrentlyModifiedError";
  }
}

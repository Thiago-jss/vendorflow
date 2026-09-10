/**
 * Missing and foreign identifiers raise exactly this, and nothing distinguishes them
 * (MT-004). No field carries the reason, so no caller can accidentally leak one.
 */
export class SupplierNotFoundError extends Error {
  constructor() {
    super("Supplier was not found");
    this.name = "SupplierNotFoundError";
  }
}

/**
 * AUTHZ-003. The principal authenticated, but their roles do not grant this capability. It
 * names an action and never a resource, so refusing it confirms nothing about what exists.
 */
export class SupplierActionNotAuthorizedError extends Error {
  constructor(readonly attemptedAction: string) {
    super(`This principal may not ${attemptedAction} a supplier`);
    this.name = "SupplierActionNotAuthorizedError";
  }
}

/**
 * A domain rule refused a well-formed payload: an invalid CNPJ, an identifier with nothing
 * comparable in it. The message names the rule and never echoes the fiscal identifier, the
 * legal name or any contact detail (SEC-009).
 */
export class SupplierValidationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SupplierValidationError";
  }
}

/**
 * FR-013/MT-006. Another supplier of this organization already carries this identifier in its
 * normalized form. The message states the rule without repeating the value.
 */
export class SupplierTaxIdentifierAlreadyRegisteredError extends Error {
  constructor() {
    super("A supplier with this tax identifier is already registered");
    this.name = "SupplierTaxIdentifierAlreadyRegisteredError";
  }
}

/**
 * FR-012/FR-040. The supplier exists and is inactive, so it may not receive a newly registered
 * quote. Deliberately not a 404: the caller can see the supplier through the supplier routes,
 * so hiding the reason would only make the refusal unexplainable.
 */
export class SupplierInactiveError extends Error {
  constructor() {
    super("An inactive supplier cannot receive a new quote");
    this.name = "SupplierInactiveError";
  }
}

/** FR-012. Deactivating an already-inactive supplier changes nothing and says so. */
export class SupplierAlreadyInactiveError extends Error {
  constructor() {
    super("The supplier is already inactive");
    this.name = "SupplierAlreadyInactiveError";
  }
}

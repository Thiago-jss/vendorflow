import type { SupplierTaxIdentifierType } from "./tax-identifier";

/**
 * AUD-002's typed payload for the two Supplier facts this phase audits.
 *
 * **No fiscal identifier, no legal name, no trade name, no email address, no phone number.**
 * The audited fact is "this actor registered a supplier" and "this actor deactivated one";
 * the supplier's own data is reachable by its identifier under a tenant-scoped, authorized
 * read, and copying it into the trail would duplicate personal and fiscal data into a store
 * whose whole purpose is that it is never deleted (SEC-009, AUD-003).
 *
 * The *type* of identifier is kept, because "registered as a validated CNPJ" and "registered
 * as an unvalidated other identifier" are different decisions and the trail should say which
 * one was made.
 *
 * These are type aliases rather than interfaces on purpose: a type alias of an object literal
 * carries an implicit index signature, so the compiler proves each payload is JSON-safe.
 */
export type SupplierCreatedAuditPayload = {
  readonly taxIdentifierType: SupplierTaxIdentifierType;
  readonly isActive: boolean;
};

export type SupplierDeactivatedAuditPayload = {
  readonly isActive: boolean;
  /** How many quotes already reference this supplier, so the trail explains the consequence. */
  readonly registeredQuoteCount: number;
};

export function supplierCreatedPayload(input: {
  readonly taxIdentifierType: SupplierTaxIdentifierType;
}): SupplierCreatedAuditPayload {
  return { taxIdentifierType: input.taxIdentifierType, isActive: true };
}

export function supplierDeactivatedPayload(input: {
  readonly registeredQuoteCount: number;
}): SupplierDeactivatedAuditPayload {
  return { isActive: false, registeredQuoteCount: input.registeredQuoteCount };
}

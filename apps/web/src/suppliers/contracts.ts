/**
 * The supplier wire contract, as the browser reads and writes it.
 *
 * `taxIdentifier` stays a string exactly as the server returns it: normalization, check-digit
 * validation and uniqueness are all server-owned (FR-010–FR-013). Nothing here recomputes
 * `isActive`, `deactivatedAt` or an identifier — those are the API's to say.
 */
export const supplierTaxIdentifierTypes = ["CNPJ", "OTHER"] as const;

export type SupplierTaxIdentifierType = (typeof supplierTaxIdentifierTypes)[number];

export interface Supplier {
  readonly id: string;
  readonly legalName: string;
  readonly tradeName: string;
  readonly taxIdentifierType: SupplierTaxIdentifierType;
  readonly taxIdentifier: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
  readonly isActive: boolean;
  readonly deactivatedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SupplierPage {
  readonly items: readonly Supplier[];
  /** Opaque keyset cursor. Null on the last page, and there is no total count. */
  readonly nextCursor: string | null;
}

/** The closed world `RegisterSupplierDto` declares. Sending anything else is a 400. */
export interface SupplierRegistrationInput {
  readonly legalName: string;
  readonly tradeName: string;
  readonly taxIdentifierType: SupplierTaxIdentifierType;
  readonly taxIdentifier: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
}

/** `isActive` omitted lists both; the browser never invents a third value for "all". */
export type SupplierActiveFilter = "all" | "active" | "inactive";

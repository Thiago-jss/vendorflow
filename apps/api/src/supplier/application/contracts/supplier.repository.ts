import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import type { SupplierTaxIdentifierType } from "../support/tax-identifier";

export const SUPPLIER_REPOSITORY = Symbol("SUPPLIER_REPOSITORY");

export interface SupplierRecord {
  readonly id: string;
  readonly legalName: string;
  readonly tradeName: string;
  readonly taxIdentifierType: SupplierTaxIdentifierType;
  readonly taxIdentifier: string;
  readonly taxIdentifierNormalized: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
  readonly isActive: boolean;
  readonly deactivatedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * FR-051's snapshot source: the legal identity a purchase order is issued against, and
 * nothing else. Trade name, email and phone are deliberately absent — an order is a legal
 * document, not a copy of the address book.
 */
export interface SupplierSnapshot {
  readonly id: string;
  readonly legalName: string;
  readonly taxIdentifier: string;
  readonly taxIdentifierType: SupplierTaxIdentifierType;
}

export interface TenantSupplierCriteria {
  readonly organizationId: string;
  readonly supplierId: string;
}

export interface CreateSupplierInput {
  readonly organizationId: string;
  readonly legalName: string;
  readonly tradeName: string;
  readonly taxIdentifierType: SupplierTaxIdentifierType;
  readonly taxIdentifier: string;
  readonly taxIdentifierNormalized: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
}

export interface DeactivateSupplierInput extends TenantSupplierCriteria {
  readonly deactivatedAt: Date;
}

/** Keyset position in the supplier list, ordered newest first. */
export interface SupplierListCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface ListSuppliersCriteria {
  readonly organizationId: string;
  /** `null` lists both states; a value narrows to active or inactive suppliers. */
  readonly isActive: boolean | null;
  readonly limit: number;
  readonly after: SupplierListCursor | null;
}

export interface SupplierPage {
  readonly items: readonly SupplierRecord[];
  readonly nextCursor: SupplierListCursor | null;
}

/**
 * Persistence for the Supplier registry.
 *
 * Every method is scoped by construction (ADR-002): there is no read by identifier alone and
 * no optional `organizationId`, so a caller cannot express an unscoped query even by mistake.
 *
 * `create` raises `SupplierTaxIdentifierAlreadyRegisteredError` rather than a driver error
 * when the per-tenant uniqueness of the normalized identifier is violated: that collision is
 * an expected business outcome, and a race that a pre-check missed must answer the same way
 * the pre-check would have (FR-013).
 *
 * `deactivate` returns `null` when its conditional write matched no already-active row. That
 * is the concurrency authority: the state is re-checked inside the UPDATE, never before it.
 *
 * The scope-bound reads exist because a purchase order's snapshot and a quote's supplier
 * check must observe the same transaction as the change they are part of.
 */
export interface SupplierRepository {
  create(
    scope: TransactionScope,
    input: CreateSupplierInput,
  ): Promise<SupplierRecord>;

  find(criteria: TenantSupplierCriteria): Promise<SupplierRecord | null>;

  list(criteria: ListSuppliersCriteria): Promise<SupplierPage>;

  /** FR-040. The supplier as seen inside a transaction, so activity cannot change underneath. */
  findInTransaction(
    scope: TransactionScope,
    criteria: TenantSupplierCriteria,
  ): Promise<SupplierRecord | null>;

  findSnapshot(
    scope: TransactionScope,
    criteria: TenantSupplierCriteria,
  ): Promise<SupplierSnapshot | null>;

  deactivate(
    scope: TransactionScope,
    input: DeactivateSupplierInput,
  ): Promise<SupplierRecord | null>;

  /** FR-012. How much history already points here, for the audit payload. */
  countQuotes(
    scope: TransactionScope,
    criteria: TenantSupplierCriteria,
  ): Promise<number>;
}

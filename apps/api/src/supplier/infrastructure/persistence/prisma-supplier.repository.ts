import { Injectable } from "@nestjs/common";
import { DatabaseService, Prisma } from "@vendorflow/database";
import { transactionClient } from "../../../platform/persistence/prisma-transaction-runner";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import { SupplierTaxIdentifierAlreadyRegisteredError } from "../../application/contracts/supplier.errors";
import type {
  CreateSupplierInput,
  DeactivateSupplierInput,
  ListSuppliersCriteria,
  SupplierPage,
  SupplierRecord,
  SupplierRepository,
  SupplierSnapshot,
  TenantSupplierCriteria,
} from "../../application/contracts/supplier.repository";
import {
  supplierTaxIdentifierTypes,
  type SupplierTaxIdentifierType,
} from "../../application/support/tax-identifier";

/** Prisma's code for a unique-constraint violation. */
const UNIQUE_VIOLATION = "P2002";

const SUPPLIER_SELECTION = {
  id: true,
  legalName: true,
  tradeName: true,
  taxIdentifierType: true,
  taxIdentifier: true,
  taxIdentifierNormalized: true,
  contactEmail: true,
  contactPhone: true,
  isActive: true,
  deactivatedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SupplierSelect;

type SupplierRow = Prisma.SupplierGetPayload<{
  select: typeof SUPPLIER_SELECTION;
}>;

@Injectable()
export class PrismaSupplierRepository implements SupplierRepository {
  constructor(private readonly database: DatabaseService) {}

  async create(
    scope: TransactionScope,
    input: CreateSupplierInput,
  ): Promise<SupplierRecord> {
    const transaction = transactionClient(scope);

    try {
      const created = await transaction.supplier.create({
        data: {
          organizationId: input.organizationId,
          legalName: input.legalName,
          tradeName: input.tradeName,
          taxIdentifierType: input.taxIdentifierType,
          taxIdentifier: input.taxIdentifier,
          taxIdentifierNormalized: input.taxIdentifierNormalized,
          contactEmail: input.contactEmail,
          contactPhone: input.contactPhone,
        },
        select: SUPPLIER_SELECTION,
      });

      return toRecord(created);
    } catch (error: unknown) {
      // FR-013's per-tenant uniqueness, decided by PostgreSQL. Translated into the business
      // error a pre-check would have produced, so a race answers exactly as a sequential
      // duplicate does and no driver detail reaches the caller (ADR-002).
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_VIOLATION
      ) {
        throw new SupplierTaxIdentifierAlreadyRegisteredError();
      }

      throw error;
    }
  }

  async find(
    criteria: TenantSupplierCriteria,
  ): Promise<SupplierRecord | null> {
    const supplier = await this.database.supplier.findUnique({
      where: {
        organizationId_id: {
          organizationId: criteria.organizationId,
          id: criteria.supplierId,
        },
      },
      select: SUPPLIER_SELECTION,
    });

    return supplier === null ? null : toRecord(supplier);
  }

  async findInTransaction(
    scope: TransactionScope,
    criteria: TenantSupplierCriteria,
  ): Promise<SupplierRecord | null> {
    const supplier = await transactionClient(scope).supplier.findUnique({
      where: {
        organizationId_id: {
          organizationId: criteria.organizationId,
          id: criteria.supplierId,
        },
      },
      select: SUPPLIER_SELECTION,
    });

    return supplier === null ? null : toRecord(supplier);
  }

  async findSnapshot(
    scope: TransactionScope,
    criteria: TenantSupplierCriteria,
  ): Promise<SupplierSnapshot | null> {
    const supplier = await transactionClient(scope).supplier.findUnique({
      where: {
        organizationId_id: {
          organizationId: criteria.organizationId,
          id: criteria.supplierId,
        },
      },
      // Exactly the three snapshot columns. A `select` narrower than the record shape is the
      // cheapest way to make "a purchase order does not carry contact data" structural.
      select: {
        id: true,
        legalName: true,
        taxIdentifier: true,
        taxIdentifierType: true,
      },
    });

    if (supplier === null) {
      return null;
    }

    return {
      id: supplier.id,
      legalName: supplier.legalName,
      taxIdentifier: supplier.taxIdentifier,
      taxIdentifierType: toTaxIdentifierType(supplier.taxIdentifierType),
    };
  }

  async list(criteria: ListSuppliersCriteria): Promise<SupplierPage> {
    const after = criteria.after;
    // Keyset, not offset: (created_at DESC, id DESC) is a total order backed by the
    // tenant-leading index, so a page cannot shift or repeat when a supplier is registered.
    const rows = await this.database.supplier.findMany({
      where: {
        organizationId: criteria.organizationId,
        ...(criteria.isActive === null ? {} : { isActive: criteria.isActive }),
        ...(after === null
          ? {}
          : {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: criteria.limit + 1,
      select: SUPPLIER_SELECTION,
    });
    const page = rows.slice(0, criteria.limit).map((row) => toRecord(row));
    const last = page.at(-1);

    return {
      items: page,
      nextCursor:
        rows.length > criteria.limit && last !== undefined
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  }

  async deactivate(
    scope: TransactionScope,
    input: DeactivateSupplierInput,
  ): Promise<SupplierRecord | null> {
    const transaction = transactionClient(scope);
    // `is_active` is in the WHERE clause rather than checked beforehand, so two concurrent
    // deactivations cannot both observe an active supplier and both succeed (REL-005).
    const updated = await transaction.supplier.updateMany({
      where: {
        id: input.supplierId,
        organizationId: input.organizationId,
        isActive: true,
      },
      data: { isActive: false, deactivatedAt: input.deactivatedAt },
    });

    if (updated.count !== 1) {
      return null;
    }

    const supplier = await transaction.supplier.findUnique({
      where: {
        organizationId_id: {
          organizationId: input.organizationId,
          id: input.supplierId,
        },
      },
      select: SUPPLIER_SELECTION,
    });

    return supplier === null ? null : toRecord(supplier);
  }

  countQuotes(
    scope: TransactionScope,
    criteria: TenantSupplierCriteria,
  ): Promise<number> {
    return transactionClient(scope).supplierQuote.count({
      where: {
        organizationId: criteria.organizationId,
        supplierId: criteria.supplierId,
      },
    });
  }
}

function toRecord(row: SupplierRow): SupplierRecord {
  return {
    id: row.id,
    legalName: row.legalName,
    tradeName: row.tradeName,
    taxIdentifierType: toTaxIdentifierType(row.taxIdentifierType),
    taxIdentifier: row.taxIdentifier,
    taxIdentifierNormalized: row.taxIdentifierNormalized,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    isActive: row.isActive,
    deactivatedAt: row.deactivatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Persistence returns the PostgreSQL enum as a string. Narrowing it here, in one place, means
 * a value added to the database but not to the application contract fails loudly instead of
 * reaching the domain as an unrecognized identifier type.
 */
function toTaxIdentifierType(value: string): SupplierTaxIdentifierType {
  const type = supplierTaxIdentifierTypes.find(
    (candidate) => candidate === value,
  );

  if (type === undefined) {
    throw new Error("Persistence returned an unsupported tax identifier type");
  }

  return type;
}

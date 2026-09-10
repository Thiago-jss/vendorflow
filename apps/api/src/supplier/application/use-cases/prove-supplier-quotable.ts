import { Inject, Injectable } from "@nestjs/common";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import {
  SupplierInactiveError,
  SupplierNotFoundError,
} from "../contracts/supplier.errors";
import {
  SUPPLIER_REPOSITORY,
  type SupplierRecord,
  type SupplierRepository,
  type TenantSupplierCriteria,
} from "../contracts/supplier.repository";

/**
 * FR-040. The `supplier` module's published answer to "may a quote be registered against this
 * supplier, right now, inside this transaction?".
 *
 * It exists so `quotation` never queries the suppliers table (ADR-001 rule 2) and never has to
 * restate the activity rule. The read is tenant-scoped and takes the caller's
 * `TransactionScope`, so the answer cannot go stale between the check and the insert that
 * depends on it.
 *
 * An unknown identifier and another organization's raise the same not-found error (MT-004).
 * An inactive supplier raises a distinct error, because the caller can already see the
 * supplier through the supplier routes and hiding the reason would make the refusal
 * unexplainable.
 */
@Injectable()
export class ProveSupplierQuotable {
  constructor(
    @Inject(SUPPLIER_REPOSITORY)
    private readonly suppliers: SupplierRepository,
  ) {}

  async execute(
    scope: TransactionScope,
    criteria: TenantSupplierCriteria,
  ): Promise<SupplierRecord> {
    const supplier = await this.suppliers.findInTransaction(scope, criteria);

    if (supplier === null) {
      throw new SupplierNotFoundError();
    }

    if (!supplier.isActive) {
      throw new SupplierInactiveError();
    }

    return supplier;
  }
}

import { Inject, Injectable } from "@nestjs/common";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import { SupplierNotFoundError } from "../contracts/supplier.errors";
import {
  SUPPLIER_REPOSITORY,
  type SupplierRepository,
  type SupplierSnapshot,
  type TenantSupplierCriteria,
} from "../contracts/supplier.repository";

/**
 * FR-051. The `supplier` module's published answer to "what legal identity is this purchase
 * order being issued against?".
 *
 * It returns the legal name, the fiscal identifier and its type, and nothing else. Trade name,
 * contact email and contact phone are not part of a purchase order: copying them would spread
 * personal contact data into a permanent document that has no use for it (SEC-009).
 *
 * Deliberately **not** filtered by activity. FR-012 blocks new *quotes* against an inactive
 * supplier; a purchase order issued from a quote registered while the supplier was active is
 * exactly the history FR-012 says must survive.
 */
@Injectable()
export class GetSupplierSnapshot {
  constructor(
    @Inject(SUPPLIER_REPOSITORY)
    private readonly suppliers: SupplierRepository,
  ) {}

  async execute(
    scope: TransactionScope,
    criteria: TenantSupplierCriteria,
  ): Promise<SupplierSnapshot> {
    const snapshot = await this.suppliers.findSnapshot(scope, criteria);

    if (snapshot === null) {
      throw new SupplierNotFoundError();
    }

    return snapshot;
  }
}

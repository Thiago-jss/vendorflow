import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import { SupplierNotFoundError } from "../contracts/supplier.errors";
import {
  SUPPLIER_REPOSITORY,
  type SupplierRecord,
  type SupplierRepository,
} from "../contracts/supplier.repository";
import { assertMayMaintainSuppliers } from "../support/supplier-authorization";

/**
 * FR-010. One supplier of the caller's organization.
 *
 * The capability is asserted before the read, so a principal without it never causes a
 * lookup and cannot learn from response timing whether an identifier exists. The read itself
 * carries the tenant in its predicate, so an unknown identifier and another organization's
 * are one answer (MT-004).
 */
@Injectable()
export class GetSupplier {
  constructor(
    @Inject(SUPPLIER_REPOSITORY)
    private readonly suppliers: SupplierRepository,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    supplierId: string,
  ): Promise<SupplierRecord> {
    assertMayMaintainSuppliers(principal, "read");

    const supplier = await this.suppliers.find({
      organizationId: principal.organizationId,
      supplierId,
    });

    if (supplier === null) {
      throw new SupplierNotFoundError();
    }

    return supplier;
  }
}

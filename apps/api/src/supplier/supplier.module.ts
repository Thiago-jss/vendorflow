import { Module } from "@nestjs/common";
import { DatabaseModule } from "@vendorflow/database";
import { AuditModule } from "../audit/audit.module";
import { TransactionModule } from "../platform/persistence/transaction.module";
import { TenantContextModule } from "../platform/tenancy/tenant-context.module";
import { SUPPLIER_REPOSITORY } from "./application/contracts/supplier.repository";
import { DeactivateSupplier } from "./application/use-cases/deactivate-supplier";
import { GetSupplier } from "./application/use-cases/get-supplier";
import { GetSupplierSnapshot } from "./application/use-cases/get-supplier-snapshot";
import { ListSuppliers } from "./application/use-cases/list-suppliers";
import { ProveSupplierQuotable } from "./application/use-cases/prove-supplier-quotable";
import { RegisterSupplier } from "./application/use-cases/register-supplier";
import { SuppliersController } from "./infrastructure/http/controllers/suppliers.controller";
import { PrismaSupplierRepository } from "./infrastructure/persistence/prisma-supplier.repository";

/**
 * Owns the Supplier registry, as ADR-001 partitions the system.
 *
 * Two of its operations exist for other modules rather than for a route:
 * `ProveSupplierQuotable` answers `quotation`'s "may this supplier receive a new quote, inside
 * this transaction?", and `GetSupplierSnapshot` answers `purchase-order`'s "what legal
 * identity is this order issued against?". Both are published operations, which is how those
 * modules read supplier data without ever touching the suppliers table (ADR-001 rule 2).
 *
 * This module imports nothing from `quotation` or `purchase-order` and knows nothing about
 * either: a supplier's lifecycle does not depend on what has been quoted or ordered from it.
 */
@Module({
  imports: [DatabaseModule, TenantContextModule, TransactionModule, AuditModule],
  controllers: [SuppliersController],
  providers: [
    PrismaSupplierRepository,
    { provide: SUPPLIER_REPOSITORY, useExisting: PrismaSupplierRepository },
    RegisterSupplier,
    ListSuppliers,
    GetSupplier,
    DeactivateSupplier,
    ProveSupplierQuotable,
    GetSupplierSnapshot,
  ],
  exports: [ProveSupplierQuotable, GetSupplierSnapshot],
})
export class SupplierModule {}

import { Inject, Injectable } from "@nestjs/common";
import { RecordAuditEvent } from "../../../audit/application/use-cases/record-audit-event";
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from "../../../platform/persistence/transaction-scope";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import {
  SupplierAlreadyInactiveError,
  SupplierNotFoundError,
} from "../contracts/supplier.errors";
import {
  SUPPLIER_REPOSITORY,
  type SupplierRecord,
  type SupplierRepository,
} from "../contracts/supplier.repository";
import { assertMayMaintainSuppliers } from "../support/supplier-authorization";
import { supplierDeactivatedPayload } from "../support/supplier-audit";

/**
 * FR-012. A Supplier is deactivated, never deleted.
 *
 * Historical quotes and purchase orders keep pointing here — every relationship to a supplier
 * is `ON DELETE RESTRICT`, so the database refuses the alternative outright. What deactivation
 * changes is exactly one thing: no *new* quote may be registered against this supplier
 * (FR-040). A quote registered while the supplier was active stays selectable afterwards,
 * because withdrawing a live commercial offer because a record was archived would be a rule
 * nobody asked for.
 *
 * Deactivation is deliberately **not** an idempotent-key operation: REL-004 names four
 * operations and this is not one of them. It does not need to be — the conditional write below
 * is naturally at-most-once, and a retry of a completed deactivation is a stated conflict
 * rather than a duplicated effect.
 */
@Injectable()
export class DeactivateSupplier {
  constructor(
    @Inject(SUPPLIER_REPOSITORY)
    private readonly suppliers: SupplierRepository,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    private readonly recordAuditEvent: RecordAuditEvent,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    supplierId: string,
  ): Promise<SupplierRecord> {
    assertMayMaintainSuppliers(principal, "deactivate");

    const criteria = {
      organizationId: principal.organizationId,
      supplierId,
    };
    const existing = await this.suppliers.find(criteria);

    if (existing === null) {
      throw new SupplierNotFoundError();
    }

    if (!existing.isActive) {
      throw new SupplierAlreadyInactiveError();
    }

    const deactivatedAt = new Date();

    return this.transactionRunner.run(async (scope) => {
      const deactivated = await this.suppliers.deactivate(scope, {
        ...criteria,
        deactivatedAt,
      });

      if (deactivated === null) {
        // The conditional write re-checked `is_active` and matched nothing: another
        // deactivation won the race. Thrown, so nothing else in this transaction survives.
        throw new SupplierAlreadyInactiveError();
      }

      await this.recordAuditEvent.execute(scope, principal, {
        eventType: "SUPPLIER_DEACTIVATED",
        aggregateType: "SUPPLIER",
        aggregateId: deactivated.id,
        occurredAt: deactivatedAt,
        payload: supplierDeactivatedPayload({
          registeredQuoteCount: await this.suppliers.countQuotes(
            scope,
            criteria,
          ),
        }),
      });

      return deactivated;
    });
  }
}

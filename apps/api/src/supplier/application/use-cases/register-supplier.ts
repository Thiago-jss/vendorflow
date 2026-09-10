import { Inject, Injectable } from "@nestjs/common";
import { RecordAuditEvent } from "../../../audit/application/use-cases/record-audit-event";
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from "../../../platform/persistence/transaction-scope";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import { SupplierValidationError } from "../contracts/supplier.errors";
import {
  SUPPLIER_REPOSITORY,
  type SupplierRecord,
  type SupplierRepository,
} from "../contracts/supplier.repository";
import { assertMayMaintainSuppliers } from "../support/supplier-authorization";
import { supplierCreatedPayload } from "../support/supplier-audit";
import {
  normalizeTaxIdentifier,
  type SupplierTaxIdentifierType,
  type TaxIdentifierNormalizationFailure,
} from "../support/tax-identifier";

export interface RegisterSupplierInput {
  readonly legalName: string;
  readonly tradeName: string;
  readonly taxIdentifierType: SupplierTaxIdentifierType;
  readonly taxIdentifier: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
}

/**
 * FR-010/FR-011/FR-013. Registers a Supplier owned by the caller's organization.
 *
 * The capability is checked before anything is read or written (AUTHZ-003), and the tenant is
 * the principal's, never the payload's (MT-003).
 *
 * Fiscal identity is normalized and — for a CNPJ — check-digit validated here, in application
 * logic, so an invalid identifier is a stated domain refusal (422) rather than a constraint
 * violation surfacing as a 500. FR-013's per-tenant uniqueness is still decided by PostgreSQL:
 * a pre-check that a concurrent registration could race is simply not written, and the unique
 * constraint's violation is translated into the same business error a pre-check would have
 * produced.
 *
 * The insert and its audit event share one transaction (AUD-004): a supplier that exists with
 * no record of who created it is not an acceptable degradation.
 */
@Injectable()
export class RegisterSupplier {
  constructor(
    @Inject(SUPPLIER_REPOSITORY)
    private readonly suppliers: SupplierRepository,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    private readonly recordAuditEvent: RecordAuditEvent,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    input: RegisterSupplierInput,
  ): Promise<SupplierRecord> {
    assertMayMaintainSuppliers(principal, "register");

    const normalized = normalizeTaxIdentifier(
      input.taxIdentifierType,
      input.taxIdentifier,
    );

    if (!normalized.ok) {
      throw new SupplierValidationError(
        taxIdentifierFailureMessage(normalized.reason),
      );
    }

    const createdAt = new Date();

    return this.transactionRunner.run(async (scope) => {
      const supplier = await this.suppliers.create(scope, {
        organizationId: principal.organizationId,
        legalName: input.legalName.trim(),
        tradeName: input.tradeName.trim(),
        taxIdentifierType: input.taxIdentifierType,
        taxIdentifier: normalized.value.taxIdentifier,
        taxIdentifierNormalized: normalized.value.taxIdentifierNormalized,
        contactEmail: input.contactEmail.trim(),
        contactPhone: input.contactPhone.trim(),
      });

      await this.recordAuditEvent.execute(scope, principal, {
        eventType: "SUPPLIER_CREATED",
        aggregateType: "SUPPLIER",
        aggregateId: supplier.id,
        occurredAt: createdAt,
        payload: supplierCreatedPayload({
          taxIdentifierType: supplier.taxIdentifierType,
        }),
      });

      return supplier;
    });
  }
}

/** Names the rule, never the value the caller submitted (SEC-009). */
function taxIdentifierFailureMessage(
  reason: TaxIdentifierNormalizationFailure,
): string {
  switch (reason) {
    case "blank":
      return "A tax identifier is required";
    case "too-long":
      return "The tax identifier is longer than this system stores";
    case "cnpj-malformed":
      return "A CNPJ must be 14 digits, optionally punctuated";
    case "cnpj-check-digits":
      return "The CNPJ check digits are not valid";
    case "no-comparable-characters":
      return "The tax identifier contains no comparable characters";
  }
}

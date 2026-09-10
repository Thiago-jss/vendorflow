import { Inject, Injectable } from "@nestjs/common";
import { RecordAuditEvent } from "../../../audit/application/use-cases/record-audit-event";
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from "../../../platform/persistence/transaction-scope";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import { ProvePurchaseRequestQuotable } from "../../../procurement/application/use-cases/prove-purchase-request-quotable";
import {
  SupplierQuoteConcurrentlyModifiedError,
  SupplierQuoteNotActionableError,
  SupplierQuoteNotFoundError,
} from "../contracts/quotation.errors";
import {
  SUPPLIER_QUOTE_REPOSITORY,
  type SupplierQuoteRecord,
  type SupplierQuoteRepository,
} from "../contracts/supplier-quote.repository";
import { assertMayRunQuotation } from "../support/quote-authorization";
import { supplierQuoteWithdrawnPayload } from "../support/quote-audit";

/**
 * FR-046. A Buyer takes back an offer that has not been selected.
 *
 * The quote is not deleted. It stays visible in the comparison with its status, because a
 * comparison that silently drops what was withdrawn cannot explain the decision that followed
 * it (AUD-003).
 *
 * BR-024 in the other direction: a **selected** quote cannot be withdrawn. Undoing a selection
 * would leave a request in IN_FINAL_APPROVAL with nothing selected, and an approval ladder
 * measuring an amount that no longer exists. The conditional write restates `status = ACTIVE`,
 * so a withdrawal racing a selection loses cleanly rather than producing that state.
 *
 * The request's lock is taken first, in the same order every other operation here takes it,
 * which is what keeps a withdrawal and a selection from deadlocking on one another.
 *
 * No outgoing event: FR-062 names no notification for a withdrawn quote.
 */
@Injectable()
export class WithdrawSupplierQuote {
  constructor(
    @Inject(SUPPLIER_QUOTE_REPOSITORY)
    private readonly supplierQuotes: SupplierQuoteRepository,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    private readonly provePurchaseRequestQuotable: ProvePurchaseRequestQuotable,
    private readonly recordAuditEvent: RecordAuditEvent,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    purchaseRequestId: string,
    supplierQuoteId: string,
  ): Promise<SupplierQuoteRecord> {
    assertMayRunQuotation(principal, "withdraw");

    const withdrawnAt = new Date();
    const criteria = {
      organizationId: principal.organizationId,
      purchaseRequestId,
      supplierQuoteId,
    };

    return this.transactionRunner.run(async (scope) => {
      await this.provePurchaseRequestQuotable.execute(scope, {
        organizationId: principal.organizationId,
        purchaseRequestId,
      });

      const existing = await this.supplierQuotes.findInTransaction(
        scope,
        criteria,
      );

      if (existing === null) {
        // Unknown, another tenant's and another request's quote are one answer (MT-004).
        throw new SupplierQuoteNotFoundError();
      }

      if (existing.status === "SELECTED") {
        throw new SupplierQuoteNotActionableError(
          "A selected quote cannot be withdrawn",
        );
      }

      if (existing.status === "WITHDRAWN") {
        throw new SupplierQuoteNotActionableError(
          "This quote has already been withdrawn",
        );
      }

      const withdrawn = await this.supplierQuotes.withdraw(scope, {
        ...criteria,
        withdrawnAt,
      });

      if (withdrawn === null) {
        // The conditional write re-checked `status = ACTIVE` and matched nothing: a selection
        // or another withdrawal won the race. Thrown, so nothing here survives.
        throw new SupplierQuoteConcurrentlyModifiedError();
      }

      await this.recordAuditEvent.execute(scope, principal, {
        eventType: "SUPPLIER_QUOTE_WITHDRAWN",
        aggregateType: "PURCHASE_REQUEST",
        aggregateId: purchaseRequestId,
        occurredAt: withdrawnAt,
        payload: supplierQuoteWithdrawnPayload({
          supplierQuoteId: withdrawn.id,
          supplierId: withdrawn.supplierId,
          totalCents: withdrawn.totalCents,
        }),
      });

      return withdrawn;
    });
  }
}

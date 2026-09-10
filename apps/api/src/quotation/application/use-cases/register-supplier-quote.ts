import { Inject, Injectable } from "@nestjs/common";
import { RecordAuditEvent } from "../../../audit/application/use-cases/record-audit-event";
import { formatCalendarDate } from "../../../platform/calendar/calendar-date";
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from "../../../platform/persistence/transaction-scope";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import type { PurchaseRequestItemRecord } from "../../../procurement/application/contracts/purchase-request.repository";
import { ProvePurchaseRequestQuotable } from "../../../procurement/application/use-cases/prove-purchase-request-quotable";
import { ProveSupplierQuotable } from "../../../supplier/application/use-cases/prove-supplier-quotable";
import { SupplierQuoteValidationError } from "../contracts/quotation.errors";
import {
  SUPPLIER_QUOTE_REPOSITORY,
  type RegisterSupplierQuoteLine,
  type SupplierQuoteRecord,
  type SupplierQuoteRepository,
} from "../contracts/supplier-quote.repository";
import { supplierQuoteRegisteredPayload } from "../support/quote-audit";
import { assertMayRunQuotation } from "../support/quote-authorization";
import {
  calculateQuoteTotals,
  type QuoteTotalsFailure,
} from "../support/quote-money";

/** What a client may say about one line: which line, and what the supplier charges for it. */
export interface RegisterSupplierQuoteLineInput {
  readonly purchaseRequestItemId: string;
  readonly unitPriceCents: bigint;
}

export interface RegisterSupplierQuoteInput {
  readonly supplierId: string;
  readonly freightCents: bigint;
  readonly discountCents: bigint;
  readonly validUntil: Date;
  readonly deliveryLeadTimeDays: number;
  readonly lines: readonly RegisterSupplierQuoteLineInput[];
}

/**
 * FR-040 – FR-042 and BR-020 – BR-022. A Buyer records what one supplier charges for one
 * request.
 *
 * **Quantity is not client input.** A quote prices what was asked for; it does not restate it.
 * Each line's quantity is read from the persisted PurchaseRequestItem, so a supplier cannot be
 * recorded as having quoted 10 units of something the requester asked 100 of, and a client
 * cannot change the effective size of a request by quoting it. The only two things a client
 * supplies per line are which line it is and what the unit price is — and the first is checked
 * against the request's own lines rather than trusted.
 *
 * **No total is ever accepted** (BR-032). Line totals, the goods subtotal and the quote total
 * are computed here in exact integer arithmetic and are the only values written.
 *
 * The order inside the transaction is the whole safety argument:
 *
 * 1. `ProvePurchaseRequestQuotable` takes the request's row lock and proves it is still
 *    IN_QUOTATION. FR-025 lets a requester cancel from that state, so without this an ACTIVE
 *    quote could be inserted against a request that had just been cancelled — a live
 *    commercial offer nobody can act on. That is not a benign race.
 * 2. `ProveSupplierQuotable` proves the supplier is this tenant's and is still active
 *    (FR-012/FR-040), inside the same transaction, so activity cannot change underneath.
 * 3. The quote and its lines are inserted. BR-022's partial unique index decides whether a
 *    second live offer from the same supplier is allowed; BR-021's deferred constraint trigger
 *    decides, at COMMIT, whether the lines cover the request exactly.
 * 4. The audit event joins the same transaction (AUD-004).
 *
 * No outgoing event is emitted. FR-062 asks for notifications on the next actor, on approval,
 * on rejection and on order issuance; registering a quote is none of those, and inventing a
 * message with no consumer would be inventing a requirement.
 */
@Injectable()
export class RegisterSupplierQuote {
  constructor(
    @Inject(SUPPLIER_QUOTE_REPOSITORY)
    private readonly supplierQuotes: SupplierQuoteRepository,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    private readonly provePurchaseRequestQuotable: ProvePurchaseRequestQuotable,
    private readonly proveSupplierQuotable: ProveSupplierQuotable,
    private readonly recordAuditEvent: RecordAuditEvent,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    purchaseRequestId: string,
    input: RegisterSupplierQuoteInput,
  ): Promise<SupplierQuoteRecord> {
    assertMayRunQuotation(principal, "register");

    const registeredAt = new Date();

    return this.transactionRunner.run(async (scope) => {
      const request = await this.provePurchaseRequestQuotable.execute(scope, {
        organizationId: principal.organizationId,
        purchaseRequestId,
      });

      await this.proveSupplierQuotable.execute(scope, {
        organizationId: principal.organizationId,
        supplierId: input.supplierId,
      });

      const lines = this.buildLines(request.items, input.lines);
      const totals = calculateQuoteTotals({
        lines,
        freightCents: input.freightCents,
        discountCents: input.discountCents,
      });

      if (!totals.ok) {
        throw new SupplierQuoteValidationError(totalsFailureMessage(totals.reason));
      }

      const quote = await this.supplierQuotes.register(scope, {
        organizationId: principal.organizationId,
        purchaseRequestId,
        supplierId: input.supplierId,
        registeredById: principal.userId,
        freightCents: input.freightCents,
        discountCents: input.discountCents,
        itemsTotalCents: totals.value.itemsTotalCents,
        totalCents: totals.value.totalCents,
        validUntil: input.validUntil,
        deliveryLeadTimeDays: input.deliveryLeadTimeDays,
        lines: lines.map(
          (line, index): RegisterSupplierQuoteLine => ({
            purchaseRequestItemId: line.purchaseRequestItemId,
            position: line.position,
            quantityScaled: line.quantityScaled,
            unitPriceCents: line.unitPriceCents,
            lineTotalCents: totals.value.lineTotalsCents[index] ?? 0n,
          }),
        ),
      });

      await this.recordAuditEvent.execute(scope, principal, {
        eventType: "SUPPLIER_QUOTE_REGISTERED",
        aggregateType: "PURCHASE_REQUEST",
        aggregateId: purchaseRequestId,
        occurredAt: registeredAt,
        payload: supplierQuoteRegisteredPayload({
          supplierQuoteId: quote.id,
          supplierId: quote.supplierId,
          itemCount: quote.itemCount,
          itemsTotalCents: quote.itemsTotalCents,
          freightCents: quote.freightCents,
          discountCents: quote.discountCents,
          totalCents: quote.totalCents,
          deliveryLeadTimeDays: quote.deliveryLeadTimeDays,
          validUntil: formatCalendarDate(quote.validUntil),
        }),
      });

      return quote;
    });
  }

  /**
   * BR-021 in the application, where a good error message lives. The database proves the same
   * thing again at COMMIT through a deferred constraint trigger and a composite foreign key,
   * because this check alone can be raced by a concurrent draft edit and a message is not a
   * guarantee.
   *
   * The lines come back in the request's own position order, so a client cannot influence how
   * the quote's lines are numbered by reordering its array.
   */
  private buildLines(
    requestItems: readonly PurchaseRequestItemRecord[],
    submitted: readonly RegisterSupplierQuoteLineInput[],
  ): readonly (RegisterSupplierQuoteLine & { readonly position: number })[] {
    const pricesByItemId = new Map<string, bigint>();

    for (const line of submitted) {
      if (pricesByItemId.has(line.purchaseRequestItemId)) {
        throw new SupplierQuoteValidationError(
          "A quote may price each request item only once",
        );
      }

      pricesByItemId.set(line.purchaseRequestItemId, line.unitPriceCents);
    }

    const requestItemIds = new Set(requestItems.map((item) => item.id));

    for (const itemId of pricesByItemId.keys()) {
      // A line identifier from another request — or from another tenant — is refused as "not
      // an item of this request" rather than looked up, so nothing about it is disclosed.
      if (!requestItemIds.has(itemId)) {
        throw new SupplierQuoteValidationError(
          "A quote line does not belong to this purchase request",
        );
      }
    }

    if (pricesByItemId.size !== requestItems.length) {
      throw new SupplierQuoteValidationError(
        "A quote must price every item of the purchase request",
      );
    }

    return requestItems.map((item) => ({
      purchaseRequestItemId: item.id,
      position: item.position,
      // BR-025. From the persisted request line, never from the payload.
      quantityScaled: item.quantityScaled,
      unitPriceCents: pricesByItemId.get(item.id) ?? 0n,
      lineTotalCents: 0n,
    }));
  }
}

/** Names the rule, never an amount a supplier quoted (SEC-009). */
function totalsFailureMessage(reason: QuoteTotalsFailure): string {
  switch (reason) {
    case "negative-freight":
      return "Freight may not be negative";
    case "negative-discount":
      return "A discount may not be negative";
    case "discount-exceeds-total":
      return "A discount may not exceed the quoted goods plus freight";
    case "not-storable":
      return "The quote total is larger than this system stores exactly";
  }
}

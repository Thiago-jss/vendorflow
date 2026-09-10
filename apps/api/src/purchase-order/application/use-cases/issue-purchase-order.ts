import { Inject, Injectable } from "@nestjs/common";
import { RecordAuditEvent } from "../../../audit/application/use-cases/record-audit-event";
import type { IdempotencyOutcome } from "../../../platform/idempotency/application/contracts/idempotent-operation";
import { ExecuteIdempotently } from "../../../platform/idempotency/application/use-cases/execute-idempotently";
import { RecordOutgoingEvent } from "../../../platform/outbox/application/use-cases/record-outgoing-event";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import { ApplyOrderIssuedTransition } from "../../../procurement/application/use-cases/apply-order-issued-transition";
import { ProvePurchaseRequestOrderable } from "../../../procurement/application/use-cases/prove-purchase-request-orderable";
import { GetSelectedQuoteForOrdering } from "../../../quotation/application/use-cases/get-selected-quote-for-ordering";
import { GetSupplierSnapshot } from "../../../supplier/application/use-cases/get-supplier-snapshot";
import { PurchaseOrderNotFoundError } from "../contracts/purchase-order.errors";
import {
  PURCHASE_ORDER_REPOSITORY,
  type IssuePurchaseOrderLine,
  type PurchaseOrderRecord,
  type PurchaseOrderRepository,
} from "../contracts/purchase-order.repository";
import { assertMayIssuePurchaseOrder } from "../support/purchase-order-authorization";
import { purchaseOrderIssuedPayload } from "../support/purchase-order-audit";
import { purchaseOrderIssuedEventPayload } from "../support/purchase-order-events";
import { formatPurchaseOrderNumber } from "../support/purchase-order-number";

export interface IssuePurchaseOrderRequest {
  readonly purchaseRequestId: string;
  /** REL-004. The raw header value, hashed immediately and never stored or logged. */
  readonly idempotencyKey: string | undefined;
}

/**
 * FR-050 – FR-053. A Buyer turns an approved request and its winning quote into an order.
 *
 * Everything below happens in **one** transaction, and the order is the safety argument:
 *
 * 1. `ProvePurchaseRequestOrderable` takes the request's row lock and proves it is APPROVED.
 *    Same lock order as every other operation here — request first — so a cancellation racing
 *    an issuance contends on that row rather than on the order table.
 * 2. The selected quote is read through `quotation`'s published operation, inside the same
 *    transaction, so the prices committed are the prices that were read.
 * 3. The supplier's legal identity is read through `supplier`'s, for the snapshot.
 * 4. The tenant's counter hands out the next number. It is allocated **here**, not before the
 *    transaction, which is what makes a rollback return the number with everything else: a
 *    failed issuance consumes nothing visible, and the next successful one gets the value this
 *    attempt would have had.
 * 5. The order and its snapshot lines are inserted, the request transitions APPROVED → ORDERED,
 *    the audit event is appended and the outgoing intent is committed (REL-001, AUD-004,
 *    REL-002).
 *
 * **The snapshot is a copy, not a set of references.** Description, unit of measure, quantity
 * and position come from the request line; unit price and line total from the quote line;
 * supplier legal name and fiscal identifier from the supplier. There is no foreign key from an
 * order line to either source, because a snapshot that a later edit can drag along is not a
 * snapshot (FR-051). Trade name, contact email, contact phone and the selection rationale are
 * deliberately not copied: an order records a legal identity and a price, not an address book
 * and not the reasoning behind a choice.
 *
 * That the order's supplier really is the quote's supplier is not left to this code. A
 * four-column composite foreign key over `(organization, quote, request, supplier)` makes the
 * alternative unrepresentable in PostgreSQL.
 *
 * REL-004 wraps the whole thing, so a retried issuance replays the first one's answer without a
 * second order, a second transition, a second audit event, a second outbox row or a second
 * allocated number.
 */
@Injectable()
export class IssuePurchaseOrder {
  constructor(
    @Inject(PURCHASE_ORDER_REPOSITORY)
    private readonly purchaseOrders: PurchaseOrderRepository,
    private readonly provePurchaseRequestOrderable: ProvePurchaseRequestOrderable,
    private readonly getSelectedQuoteForOrdering: GetSelectedQuoteForOrdering,
    private readonly getSupplierSnapshot: GetSupplierSnapshot,
    private readonly applyOrderIssuedTransition: ApplyOrderIssuedTransition,
    private readonly recordAuditEvent: RecordAuditEvent,
    private readonly recordOutgoingEvent: RecordOutgoingEvent,
    private readonly executeIdempotently: ExecuteIdempotently,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    request: IssuePurchaseOrderRequest,
  ): Promise<PurchaseOrderRecord> {
    assertMayIssuePurchaseOrder(principal);

    return this.executeIdempotently.execute(
      principal,
      {
        operation: "PURCHASE_ORDER_ISSUANCE",
        idempotencyKey: request.idempotencyKey,
        // The request is the whole intent: the quote, the prices and the supplier are all
        // determined by it, and none of them is client input.
        fingerprintParts: [request.purchaseRequestId],
      },
      {
        run: (scope) => this.issue(principal, scope, request.purchaseRequestId),
        replay: () =>
          this.readIssuedOrder(principal, request.purchaseRequestId),
      },
    );
  }

  private async issue(
    principal: TrustedPrincipal,
    scope: TransactionScope,
    purchaseRequestId: string,
  ): Promise<{
    readonly value: PurchaseOrderRecord;
    readonly outcome: IdempotencyOutcome;
  }> {
    const issuedAt = new Date();
    const organizationId = principal.organizationId;

    const request = await this.provePurchaseRequestOrderable.execute(scope, {
      organizationId,
      purchaseRequestId,
    });
    const quote = await this.getSelectedQuoteForOrdering.execute(scope, {
      organizationId,
      purchaseRequestId,
    });
    const supplier = await this.getSupplierSnapshot.execute(scope, {
      organizationId,
      supplierId: quote.supplierId,
    });

    const sequenceValue = await this.purchaseOrders.allocateNextNumber(
      scope,
      organizationId,
    );
    const order = await this.purchaseOrders.issue(scope, {
      organizationId,
      purchaseRequestId,
      supplierQuoteId: quote.id,
      supplierId: quote.supplierId,
      supplierLegalName: supplier.legalName,
      supplierTaxIdentifier: supplier.taxIdentifier,
      supplierTaxIdentifierType: supplier.taxIdentifierType,
      freightCents: quote.freightCents,
      discountCents: quote.discountCents,
      itemsTotalCents: quote.itemsTotalCents,
      totalCents: quote.totalCents,
      deliveryLeadTimeDays: quote.deliveryLeadTimeDays,
      issuedById: principal.userId,
      issuedAt,
      sequenceValue,
      number: formatPurchaseOrderNumber(sequenceValue),
      lines: this.buildSnapshotLines(request.items, quote.items),
    });

    const transitioned = await this.applyOrderIssuedTransition.execute(scope, {
      organizationId,
      purchaseRequestId,
    });

    await this.recordAuditEvent.execute(scope, principal, {
      eventType: "PURCHASE_ORDER_ISSUED",
      aggregateType: "PURCHASE_ORDER",
      aggregateId: order.id,
      occurredAt: issuedAt,
      payload: purchaseOrderIssuedPayload({
        number: order.number,
        purchaseRequestId: order.purchaseRequestId,
        supplierQuoteId: order.supplierQuoteId,
        supplierId: order.supplierId,
        itemCount: order.items.length,
        itemsTotalCents: order.itemsTotalCents,
        freightCents: order.freightCents,
        discountCents: order.discountCents,
        totalCents: order.totalCents,
        deliveryLeadTimeDays: order.deliveryLeadTimeDays,
      }),
    });

    await this.recordOutgoingEvent.execute(scope, principal, {
      eventType: "PURCHASE_ORDER_ISSUED",
      aggregateType: "PURCHASE_ORDER",
      aggregateId: order.id,
      occurredAt: issuedAt,
      // Without the supplier's legal name and fiscal identifier the order row carries: a
      // consumer that needs either reads PostgreSQL under a tenant-scoped query.
      payload: purchaseOrderIssuedEventPayload({
        number: order.number,
        purchaseRequestId: order.purchaseRequestId,
        supplierQuoteId: order.supplierQuoteId,
        supplierId: order.supplierId,
        totalCents: order.totalCents,
        deliveryLeadTimeDays: order.deliveryLeadTimeDays,
        requesterId: transitioned.requesterId,
        issuedById: principal.userId,
      }),
    });

    return {
      value: order,
      outcome: {
        purchaseOrderId: order.id,
        number: order.number,
        purchaseRequestId: order.purchaseRequestId,
        purchaseRequestStatus: transitioned.status,
      },
    };
  }

  /**
   * FR-051. The lines, assembled from two sources that are joined on the request item.
   *
   * The quote's coverage is exact by construction — BR-021 is enforced by a deferred constraint
   * trigger at COMMIT and by a composite foreign key on every line — so a missing price here
   * would mean the quote violated an invariant the database refuses. It is checked anyway,
   * because issuing an order with a silently zeroed line is the kind of failure that is
   * discovered by an invoice rather than by a test.
   */
  private buildSnapshotLines(
    requestItems: readonly {
      readonly id: string;
      readonly position: number;
      readonly description: string;
      readonly unitOfMeasure: string;
      readonly quantityScaled: bigint;
    }[],
    quoteItems: readonly {
      readonly purchaseRequestItemId: string;
      readonly unitPriceCents: bigint;
      readonly lineTotalCents: bigint;
    }[],
  ): readonly IssuePurchaseOrderLine[] {
    const pricesByItemId = new Map(
      quoteItems.map((item) => [item.purchaseRequestItemId, item]),
    );

    return requestItems.map((item) => {
      const priced = pricesByItemId.get(item.id);

      if (priced === undefined) {
        throw new Error(
          "The selected quote does not price every item of its purchase request",
        );
      }

      return {
        position: item.position,
        description: item.description,
        unitOfMeasure: item.unitOfMeasure,
        quantityScaled: item.quantityScaled,
        unitPriceCents: priced.unitPriceCents,
        lineTotalCents: priced.lineTotalCents,
      };
    });
  }

  /**
   * REL-004's replay. A tenant-scoped read of the order this request already has, and nothing
   * else: no second allocation, no second transition, no second audit event, no second outbox
   * row.
   */
  private async readIssuedOrder(
    principal: TrustedPrincipal,
    purchaseRequestId: string,
  ): Promise<PurchaseOrderRecord> {
    const order = await this.purchaseOrders.findForRequest({
      organizationId: principal.organizationId,
      purchaseRequestId,
    });

    if (order === null) {
      throw new PurchaseOrderNotFoundError();
    }

    return order;
  }
}

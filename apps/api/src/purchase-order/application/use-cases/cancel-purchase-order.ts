import { Inject, Injectable } from "@nestjs/common";
import { RecordAuditEvent } from "../../../audit/application/use-cases/record-audit-event";
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from "../../../platform/persistence/transaction-scope";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import {
  PurchaseOrderConcurrentlyModifiedError,
  PurchaseOrderNotCancellableError,
  PurchaseOrderNotFoundError,
} from "../contracts/purchase-order.errors";
import {
  PURCHASE_ORDER_REPOSITORY,
  type PurchaseOrderRecord,
  type PurchaseOrderRepository,
} from "../contracts/purchase-order.repository";
import { assertMayAdministerPurchaseOrders } from "../support/purchase-order-authorization";
import { purchaseOrderCancelledPayload } from "../support/purchase-order-audit";
import { normalizeCancellationReason } from "../support/purchase-order-cancellation";

/**
 * FR-054 and BR-013. A Buyer or an Administrator cancels an issued order, with a reason.
 *
 * Cancellation is **terminal and local**. It does not reopen the purchase request, does not
 * return it from ORDERED, and does not make the selected quote selectable again — BR-013 is
 * explicit that once a request is ORDERED it is the order that gets cancelled, not the request.
 * Nothing here touches `purchase_requests`, and the state machine declares no edge out of
 * ORDERED for anything to drive.
 *
 * **No outgoing event is written, and that is a decision rather than an omission.** FR-062
 * requires notifying the next actor, and notifying the requester on approval, on rejection and
 * on order issuance. Cancellation of an order is none of those, and no consumer in this system
 * subscribes to one. An event with no reader is not a feature: it is a retry ladder, a
 * dead-letter queue and an operational surface that nothing justifies. The audit event records
 * the fact, and a notification can be added the day a requirement asks for one.
 */
@Injectable()
export class CancelPurchaseOrder {
  constructor(
    @Inject(PURCHASE_ORDER_REPOSITORY)
    private readonly purchaseOrders: PurchaseOrderRepository,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    private readonly recordAuditEvent: RecordAuditEvent,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    purchaseOrderId: string,
    reason: string,
  ): Promise<PurchaseOrderRecord> {
    assertMayAdministerPurchaseOrders(principal, "cancel");

    const cancellationReason = normalizeCancellationReason(reason);
    const criteria = {
      organizationId: principal.organizationId,
      purchaseOrderId,
    };
    const existing = await this.purchaseOrders.find(criteria);

    if (existing === null) {
      throw new PurchaseOrderNotFoundError();
    }

    if (existing.status !== "ISSUED") {
      throw new PurchaseOrderNotCancellableError();
    }

    const cancelledAt = new Date();

    return this.transactionRunner.run(async (scope) => {
      const cancelled = await this.purchaseOrders.cancel(scope, {
        ...criteria,
        cancelledById: principal.userId,
        cancelledAt,
        cancellationReason,
      });

      if (cancelled === null) {
        // The conditional write re-checked `status = ISSUED` and matched nothing: another
        // cancellation won the race. Thrown, so the audit event does not survive either.
        throw new PurchaseOrderConcurrentlyModifiedError();
      }

      await this.recordAuditEvent.execute(scope, principal, {
        eventType: "PURCHASE_ORDER_CANCELLED",
        aggregateType: "PURCHASE_ORDER",
        aggregateId: cancelled.id,
        occurredAt: cancelledAt,
        payload: purchaseOrderCancelledPayload({
          number: cancelled.number,
          purchaseRequestId: cancelled.purchaseRequestId,
          totalCents: cancelled.totalCents,
          cancellationReason,
        }),
      });

      return cancelled;
    });
  }
}

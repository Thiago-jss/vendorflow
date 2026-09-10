import type { ScaledQuantity } from "../../../platform/numeric/scaled-quantity";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import type { SupplierTaxIdentifierType } from "../../../supplier/application/support/tax-identifier";

export const PURCHASE_ORDER_REPOSITORY = Symbol("PURCHASE_ORDER_REPOSITORY");

/** FR-054. Cancellation is terminal; there is no third state. */
export const purchaseOrderStatuses = ["ISSUED", "CANCELLED"] as const;

export type PurchaseOrderStatus = (typeof purchaseOrderStatuses)[number];

export interface PurchaseOrderItemRecord {
  readonly id: string;
  readonly position: number;
  readonly description: string;
  readonly unitOfMeasure: string;
  readonly quantityScaled: ScaledQuantity;
  readonly unitPriceCents: bigint;
  readonly lineTotalCents: bigint;
}

export interface PurchaseOrderRecord {
  readonly id: string;
  readonly purchaseRequestId: string;
  readonly supplierQuoteId: string;
  readonly supplierId: string;
  readonly number: string;
  readonly status: PurchaseOrderStatus;
  readonly supplierLegalName: string;
  readonly supplierTaxIdentifier: string;
  readonly supplierTaxIdentifierType: SupplierTaxIdentifierType;
  readonly freightCents: bigint;
  readonly discountCents: bigint;
  readonly itemsTotalCents: bigint;
  readonly totalCents: bigint;
  readonly deliveryLeadTimeDays: number;
  readonly issuedById: string;
  readonly issuedAt: Date;
  readonly cancelledById: string | null;
  readonly cancelledAt: Date | null;
  readonly cancellationReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly items: readonly PurchaseOrderItemRecord[];
}

export interface TenantPurchaseOrderCriteria {
  readonly organizationId: string;
  readonly purchaseOrderId: string;
}

/**
 * FR-051's snapshot line: description, unit of measure, quantity and position from the request
 * item; unit price and line total from the selected quote line. Nothing here is a reference —
 * every value is copied, because a snapshot a later edit can drag along is not a snapshot.
 */
export interface IssuePurchaseOrderLine {
  readonly position: number;
  readonly description: string;
  readonly unitOfMeasure: string;
  readonly quantityScaled: ScaledQuantity;
  readonly unitPriceCents: bigint;
  readonly lineTotalCents: bigint;
}

export interface IssuePurchaseOrderInput {
  readonly organizationId: string;
  readonly purchaseRequestId: string;
  readonly supplierQuoteId: string;
  readonly supplierId: string;
  readonly supplierLegalName: string;
  readonly supplierTaxIdentifier: string;
  readonly supplierTaxIdentifierType: SupplierTaxIdentifierType;
  readonly freightCents: bigint;
  readonly discountCents: bigint;
  readonly itemsTotalCents: bigint;
  readonly totalCents: bigint;
  readonly deliveryLeadTimeDays: number;
  readonly issuedById: string;
  readonly issuedAt: Date;
  readonly lines: readonly IssuePurchaseOrderLine[];
}

export interface CancelPurchaseOrderInput extends TenantPurchaseOrderCriteria {
  readonly cancelledById: string;
  readonly cancelledAt: Date;
  readonly cancellationReason: string;
}

/** Keyset position in the purchase order list, ordered newest first. */
export interface PurchaseOrderListCursor {
  readonly issuedAt: Date;
  readonly id: string;
}

export interface ListPurchaseOrdersCriteria {
  readonly organizationId: string;
  /** `null` lists both states. */
  readonly status: PurchaseOrderStatus | null;
  readonly limit: number;
  readonly after: PurchaseOrderListCursor | null;
}

export interface PurchaseOrderPage {
  readonly items: readonly PurchaseOrderRecord[];
  readonly nextCursor: PurchaseOrderListCursor | null;
}

/**
 * Persistence for the PurchaseOrder aggregate, including its tenant-owned number counter.
 *
 * Every method is scoped by construction (ADR-002): there is no read by order identifier alone
 * and no optional `organizationId`.
 *
 * `allocateNextNumber` is deliberately part of this interface rather than a separate
 * "sequence service". The allocation has to happen in the *same* transaction as the insert it
 * numbers — that is what makes a rolled-back issuance consume no visible number — and a
 * separate service would be an invitation to call it somewhere else.
 *
 * `issue` raises `PurchaseOrderAlreadyIssuedError` rather than a driver error when the unique
 * constraint on `(organization_id, purchase_request_id)` refuses a second order: FR-050 makes
 * that an expected business conflict, and a race that a pre-check missed answers the way the
 * pre-check would have.
 *
 * `cancel` returns `null` when its conditional write matched no `ISSUED` row. That is the
 * concurrency authority: the state is re-checked inside the UPDATE, never before it.
 */
export interface PurchaseOrderRepository {
  /**
   * FR-053. Takes the tenant's counter row, hands out the next value and advances it, all in
   * one statement inside the caller's transaction. The first allocation of an organization
   * returns 1.
   */
  allocateNextNumber(
    scope: TransactionScope,
    organizationId: string,
  ): Promise<bigint>;

  issue(
    scope: TransactionScope,
    input: IssuePurchaseOrderInput & { readonly sequenceValue: bigint; readonly number: string },
  ): Promise<PurchaseOrderRecord>;

  find(
    criteria: TenantPurchaseOrderCriteria,
  ): Promise<PurchaseOrderRecord | null>;

  findForRequest(criteria: {
    readonly organizationId: string;
    readonly purchaseRequestId: string;
  }): Promise<PurchaseOrderRecord | null>;

  list(criteria: ListPurchaseOrdersCriteria): Promise<PurchaseOrderPage>;

  cancel(
    scope: TransactionScope,
    input: CancelPurchaseOrderInput,
  ): Promise<PurchaseOrderRecord | null>;
}

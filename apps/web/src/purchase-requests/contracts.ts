/**
 * The purchase-request wire contract, as the browser reads it.
 *
 * Every monetary amount and every quantity is a **string**, exactly as the API sends it: a
 * JSON number is a binary double, and neither an exact decimal quantity nor a centavo total
 * above 2^53 survives one. Nothing in this feature converts one of these values with
 * `Number`, `parseFloat` or `toFixed`.
 *
 * Status, totals, item positions, the approval ladder and the two supplements are all
 * server-computed. The browser reads them; it never derives them.
 */
export const purchaseRequestStatuses = [
  "DRAFT",
  "SUBMITTED",
  "IN_QUOTATION",
  "IN_FINAL_APPROVAL",
  "APPROVED",
  "ORDERED",
  "REJECTED",
  "CANCELLED"
] as const;

export type PurchaseRequestStatus = (typeof purchaseRequestStatuses)[number];

export type ApprovalStepRole = "MANAGER" | "PURCHASING" | "FINANCE";

export type ApprovalStepState =
  | "PENDING"
  | "ACTIONABLE"
  | "APPROVED"
  | "REJECTED"
  | "VOIDED";

export type ApprovalFlowState = "ACTIVE" | "COMPLETED" | "REJECTED" | "VOIDED";

export interface ApprovalStep {
  readonly id: string;
  readonly sequence: number;
  readonly role: ApprovalStepRole;
  readonly state: ApprovalStepState;
  readonly evaluatedAmountCents: string;
  readonly decidedById: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
}

export interface ApprovalFlow {
  readonly id: string;
  readonly state: ApprovalFlowState;
  readonly pendingStep: ApprovalStep | null;
  readonly steps: readonly ApprovalStep[];
}

export interface SelectedQuoteSummary {
  readonly supplierQuoteId: string;
  readonly supplierId: string;
  readonly totalCents: string;
  readonly validUntil: string;
  readonly deliveryLeadTimeDays: number;
  readonly selectedAt: string;
}

export interface PurchaseOrderSummary {
  readonly purchaseOrderId: string;
  readonly number: string;
  readonly status: "ISSUED" | "CANCELLED";
  readonly totalCents: string;
  readonly issuedAt: string;
  readonly cancelledAt: string | null;
}

export interface PurchaseRequestItem {
  readonly id: string;
  readonly position: number;
  readonly description: string;
  readonly unitOfMeasure: string;
  readonly quantity: string;
  readonly estimatedUnitPriceCents: string;
  readonly estimatedLineTotalCents: string;
}

export interface PurchaseRequest {
  readonly id: string;
  readonly status: PurchaseRequestStatus;
  readonly requesterId: string;
  readonly departmentId: string;
  readonly justification: string;
  readonly neededBy: string;
  readonly estimatedTotalCents: string;
  readonly submittedAt: string | null;
  readonly cancelledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly items: readonly PurchaseRequestItem[];
  readonly approval: ApprovalFlow | null;
  readonly selectedQuote: SelectedQuoteSummary | null;
  readonly purchaseOrder: PurchaseOrderSummary | null;
}

export interface PurchaseRequestSummary {
  readonly id: string;
  readonly status: PurchaseRequestStatus;
  readonly neededBy: string;
  readonly estimatedTotalCents: string;
  readonly itemCount: number;
  readonly submittedAt: string | null;
  readonly cancelledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PurchaseRequestPage {
  readonly items: readonly PurchaseRequestSummary[];
  /** Opaque keyset cursor. Null on the last page, and there is no total count. */
  readonly nextCursor: string | null;
}

/** The editable content of a draft: exactly the fields `PurchaseRequestDraftDto` declares. */
export interface PurchaseRequestDraftInput {
  readonly justification: string;
  readonly neededBy: string;
  readonly items: readonly {
    readonly description: string;
    readonly unitOfMeasure: string;
    readonly quantity: string;
    readonly estimatedUnitPriceCents: string;
  }[];
}

import type { ApprovalStepRole } from "../../../approval/application/support/approval-policy";
import type { ApprovalFlowState } from "../../../approval/application/support/approval-step-state";
import { formatCents } from "../../../platform/numeric/centavos";
import type { PurchaseRequestStatus } from "../../../procurement/application/support/purchase-request-status";

/**
 * AUD-002's typed payload for the quotation facts this phase audits.
 *
 * Every amount is a **digit string**, not a JSON number, for the reason amounts are strings
 * everywhere else: a JSON number is an IEEE-754 double to every reader of the trail, and a
 * centavo value above 2^53 would come back wrong from the one record that is supposed to be
 * authoritative (BR-031).
 *
 * The supplier appears as an identifier and never as a name or a fiscal identifier. The trail
 * records *which* supplier and *how much*; who that supplier is, is a tenant-scoped read away
 * and does not belong duplicated in an append-only store (SEC-009, AUD-003).
 *
 * The selection rationale is the deliberate exception: FR-044 makes it the reason the decision
 * was taken, and a decision whose reason is not recorded is not auditable. It exists here, in
 * tenant-scoped PostgreSQL, and nowhere else — in particular not in the outbox payload next
 * door.
 *
 * These are type aliases rather than interfaces on purpose: a type alias of an object literal
 * carries an implicit index signature, so the compiler proves each payload is JSON-safe.
 */
export type SupplierQuoteRegisteredAuditPayload = {
  readonly supplierQuoteId: string;
  readonly supplierId: string;
  readonly itemCount: number;
  readonly itemsTotalCents: string;
  readonly freightCents: string;
  readonly discountCents: string;
  readonly totalCents: string;
  readonly deliveryLeadTimeDays: number;
  readonly validUntil: string;
};

export type SupplierQuoteWithdrawnAuditPayload = {
  readonly supplierQuoteId: string;
  readonly supplierId: string;
  readonly totalCents: string;
};

export type SupplierQuoteSelectedAuditPayload = {
  readonly supplierQuoteId: string;
  readonly supplierId: string;
  readonly totalCents: string;
  /** BR-002. What the estimate said, next to what was actually chosen. */
  readonly estimatedTotalCents: string;
  readonly selectionRationale: string;
  readonly resultingStatus: PurchaseRequestStatus;
};

export type ApprovalFlowReevaluatedAuditPayload = {
  readonly supplierQuoteId: string;
  readonly selectedTotalCents: string;
  readonly voidedStepCount: number;
  readonly repricedStepCount: number;
  readonly appendedStepRoles: string;
  readonly approvalFlowState: ApprovalFlowState;
  readonly actionableStepRole: string | null;
};

export function supplierQuoteRegisteredPayload(input: {
  readonly supplierQuoteId: string;
  readonly supplierId: string;
  readonly itemCount: number;
  readonly itemsTotalCents: bigint;
  readonly freightCents: bigint;
  readonly discountCents: bigint;
  readonly totalCents: bigint;
  readonly deliveryLeadTimeDays: number;
  readonly validUntil: string;
}): SupplierQuoteRegisteredAuditPayload {
  return {
    supplierQuoteId: input.supplierQuoteId,
    supplierId: input.supplierId,
    itemCount: input.itemCount,
    itemsTotalCents: formatCents(input.itemsTotalCents),
    freightCents: formatCents(input.freightCents),
    discountCents: formatCents(input.discountCents),
    totalCents: formatCents(input.totalCents),
    deliveryLeadTimeDays: input.deliveryLeadTimeDays,
    validUntil: input.validUntil,
  };
}

export function supplierQuoteWithdrawnPayload(input: {
  readonly supplierQuoteId: string;
  readonly supplierId: string;
  readonly totalCents: bigint;
}): SupplierQuoteWithdrawnAuditPayload {
  return {
    supplierQuoteId: input.supplierQuoteId,
    supplierId: input.supplierId,
    totalCents: formatCents(input.totalCents),
  };
}

export function supplierQuoteSelectedPayload(input: {
  readonly supplierQuoteId: string;
  readonly supplierId: string;
  readonly totalCents: bigint;
  readonly estimatedTotalCents: bigint;
  readonly selectionRationale: string;
  readonly resultingStatus: PurchaseRequestStatus;
}): SupplierQuoteSelectedAuditPayload {
  return {
    supplierQuoteId: input.supplierQuoteId,
    supplierId: input.supplierId,
    totalCents: formatCents(input.totalCents),
    estimatedTotalCents: formatCents(input.estimatedTotalCents),
    selectionRationale: input.selectionRationale,
    resultingStatus: input.resultingStatus,
  };
}

export function approvalFlowReevaluatedPayload(input: {
  readonly supplierQuoteId: string;
  readonly selectedTotalCents: bigint;
  readonly voidedStepCount: number;
  readonly repricedStepCount: number;
  readonly appendedStepRoles: readonly ApprovalStepRole[];
  readonly approvalFlowState: ApprovalFlowState;
  readonly actionableStepRole: ApprovalStepRole | null;
}): ApprovalFlowReevaluatedAuditPayload {
  return {
    supplierQuoteId: input.supplierQuoteId,
    selectedTotalCents: formatCents(input.selectedTotalCents),
    voidedStepCount: input.voidedStepCount,
    repricedStepCount: input.repricedStepCount,
    // A comma-separated list rather than an array, because the payload contract is a flat map
    // of scalars: nesting is what makes an audit payload unqueryable without a JSON path.
    appendedStepRoles: input.appendedStepRoles.join(","),
    approvalFlowState: input.approvalFlowState,
    actionableStepRole: input.actionableStepRole,
  };
}

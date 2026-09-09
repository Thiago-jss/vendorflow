import type { ApprovalStepRecord } from "../../../approval/application/contracts/approval-flow.repository";
import type {
  ApprovalFlowState,
  ApprovalStepState,
} from "../../../approval/application/support/approval-step-state";
import { formatCents } from "./purchase-request-money";
import type { PurchaseRequestStatus } from "./purchase-request-status";

/**
 * AUD-002's "typed payload describing the change", for the four transitions this phase
 * audits.
 *
 * Every amount here is a **digit string**, not a JSON number, for exactly the reason amounts
 * are strings on the wire: a JSON number is an IEEE-754 double to every reader of the trail,
 * and a centavo value above 2^53 would come back wrong from the one record that is supposed
 * to be authoritative (BR-031).
 *
 * These are type aliases rather than interfaces on purpose: a type alias of an object literal
 * carries an implicit index signature, so the compiler — not a cast — is what proves each
 * payload is JSON-safe.
 */
export type PurchaseRequestSubmittedAuditPayload = {
  readonly status: PurchaseRequestStatus;
  readonly estimatedTotalCents: string;
  readonly approvalFlowId: string;
  readonly approvalStepCount: number;
};

export type PurchaseRequestCancelledAuditPayload = {
  readonly status: PurchaseRequestStatus;
  readonly previousStatus: PurchaseRequestStatus;
  /** How many steps stopped being actionable, so the trail explains the flow's own change. */
  readonly voidedApprovalStepCount: number;
};

export type ApprovalStepDecidedAuditPayload = {
  /** The state the step was moved into: APPROVED or REJECTED, and never anything else. */
  readonly decision: ApprovalStepState;
  /** FR-036. Present when one was given; `null` for an approval that carried none. */
  readonly decisionReason: string | null;
  /** FR-036/BR-002. The amount the decision was made against, in exact centavos. */
  readonly evaluatedAmountCents: string;
  readonly approvalStepId: string;
  readonly approvalStepSequence: number;
  readonly approvalStepRole: string;
  readonly approvalFlowId: string;
  readonly approvalFlowState: ApprovalFlowState;
  readonly resultingStatus: PurchaseRequestStatus;
};

export function purchaseRequestSubmittedPayload(input: {
  readonly estimatedTotalCents: bigint;
  readonly approvalFlowId: string;
  readonly approvalStepCount: number;
}): PurchaseRequestSubmittedAuditPayload {
  return {
    status: "SUBMITTED",
    estimatedTotalCents: formatCents(input.estimatedTotalCents),
    approvalFlowId: input.approvalFlowId,
    approvalStepCount: input.approvalStepCount,
  };
}

export function purchaseRequestCancelledPayload(input: {
  readonly previousStatus: PurchaseRequestStatus;
  readonly voidedApprovalStepCount: number;
}): PurchaseRequestCancelledAuditPayload {
  return {
    status: "CANCELLED",
    previousStatus: input.previousStatus,
    voidedApprovalStepCount: input.voidedApprovalStepCount,
  };
}

export function approvalStepDecidedPayload(input: {
  readonly step: ApprovalStepRecord;
  readonly approvalFlowState: ApprovalFlowState;
  readonly resultingStatus: PurchaseRequestStatus;
}): ApprovalStepDecidedAuditPayload {
  return {
    decision: input.step.state,
    decisionReason: input.step.decisionReason,
    evaluatedAmountCents: formatCents(input.step.evaluatedAmountCents),
    approvalStepId: input.step.id,
    approvalStepSequence: input.step.sequence,
    approvalStepRole: input.step.role,
    approvalFlowId: input.step.approvalFlowId,
    approvalFlowState: input.approvalFlowState,
    resultingStatus: input.resultingStatus,
  };
}

import type { ApprovalStepRecord } from "../../../approval/application/contracts/approval-flow.repository";
import type {
  ApprovalFlowState,
  ApprovalStepState,
} from "../../../approval/application/support/approval-step-state";
import { formatCents } from "../../../platform/numeric/centavos";
import type { PurchaseRequestStatus } from "./purchase-request-status";

/**
 * The payloads of the two outgoing facts this phase emits (ADR-003).
 *
 * They look like the audit payloads next door and they are not the same thing. An audit
 * payload is history and stays inside PostgreSQL; this one is a transport copy that leaves
 * the process, so it is deliberately *narrower*:
 *
 * - **No `decisionReason`.** FR-031's rejection reason is free text written by a person about
 *   a colleague's request. It is recorded in the audit trail, where it is tenant-scoped and
 *   access-controlled. It does not go on a queue.
 * - **No justification, no names, no email addresses.** Same reason.
 * - **Identifiers and enums, plus amounts as digit strings** (BR-031). A consumer that needs
 *   more reads PostgreSQL under a tenant-scoped query.
 *
 * These are type aliases rather than interfaces on purpose: a type alias of an object literal
 * carries an implicit index signature, so the compiler — not a cast — is what proves each
 * payload satisfies `OutgoingEventPayload`.
 */
export type PurchaseRequestSubmittedEventPayload = {
  readonly status: PurchaseRequestStatus;
  readonly estimatedTotalCents: string;
  readonly requesterId: string;
  /** BR-042: the request's own department, which is the manager boundary that must act. */
  readonly departmentId: string;
  readonly approvalFlowId: string;
  readonly approvalStepCount: number;
};

export type PurchaseRequestApprovalDecidedEventPayload = {
  readonly decision: ApprovalStepState;
  readonly evaluatedAmountCents: string;
  readonly approvalStepId: string;
  readonly approvalStepSequence: number;
  readonly approvalStepRole: string;
  readonly approvalFlowId: string;
  readonly approvalFlowState: ApprovalFlowState;
  readonly resultingStatus: PurchaseRequestStatus;
  readonly requesterId: string;
  readonly decidedById: string;
};

export function purchaseRequestSubmittedEventPayload(input: {
  readonly estimatedTotalCents: bigint;
  readonly requesterId: string;
  readonly departmentId: string;
  readonly approvalFlowId: string;
  readonly approvalStepCount: number;
}): PurchaseRequestSubmittedEventPayload {
  return {
    status: "SUBMITTED",
    estimatedTotalCents: formatCents(input.estimatedTotalCents),
    requesterId: input.requesterId,
    departmentId: input.departmentId,
    approvalFlowId: input.approvalFlowId,
    approvalStepCount: input.approvalStepCount,
  };
}

export function purchaseRequestApprovalDecidedEventPayload(input: {
  readonly step: ApprovalStepRecord;
  readonly approvalFlowState: ApprovalFlowState;
  readonly resultingStatus: PurchaseRequestStatus;
  readonly requesterId: string;
  readonly decidedById: string;
}): PurchaseRequestApprovalDecidedEventPayload {
  return {
    decision: input.step.state,
    evaluatedAmountCents: formatCents(input.step.evaluatedAmountCents),
    approvalStepId: input.step.id,
    approvalStepSequence: input.step.sequence,
    approvalStepRole: input.step.role,
    approvalFlowId: input.step.approvalFlowId,
    approvalFlowState: input.approvalFlowState,
    resultingStatus: input.resultingStatus,
    requesterId: input.requesterId,
    decidedById: input.decidedById,
  };
}

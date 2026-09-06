import type {
  ApprovalFlowRecord,
  ApprovalStepRecord,
} from "../../../approval/application/contracts/approval-flow.repository";
import type {
  PurchaseRequestListCursor,
  PurchaseRequestRecord,
  PurchaseRequestSummaryRecord,
} from "./purchase-request.repository";

/**
 * FR-026. A request together with the approval ladder it is standing in.
 *
 * `approvalFlow` is `null` for a request that has none — a DRAFT — rather than an empty flow,
 * so "not submitted yet" and "submitted, ladder materialized" are distinguishable without
 * counting steps.
 */
export interface PurchaseRequestView {
  readonly request: PurchaseRequestRecord;
  readonly approvalFlow: ApprovalFlowRecord | null;
}

/** FR-030. One row of a decision maker's queue: what to decide, and which step. */
export interface PurchaseRequestApprovalQueueItem {
  readonly request: PurchaseRequestSummaryRecord;
  readonly pendingStep: ApprovalStepRecord;
}

export interface PurchaseRequestApprovalQueuePage {
  readonly items: readonly PurchaseRequestApprovalQueueItem[];
  readonly nextCursor: PurchaseRequestListCursor | null;
}

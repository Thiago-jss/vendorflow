import type { ApprovalStepRole } from "../../../approval/application/support/approval-policy";
import type { ApprovalDecision } from "../../../approval/application/support/approval-step-state";
import type { PurchaseRequestStatus } from "./purchase-request-status";

/**
 * BR-002/FR-032. The only approval step a decision can be made against in this phase.
 *
 * The Manager step is evaluated against the **estimated total** and gates entry into
 * quotation, so it can be decided the moment a request is submitted. The Purchasing and
 * Finance steps are evaluated against the **selected quote total**, which does not exist
 * until a buyer selects a quote; exposing a way to decide them now would mean approving an
 * amount the requirements say is not the amount those steps approve.
 */
export const DECIDABLE_APPROVAL_STEP_ROLE: ApprovalStepRole = "MANAGER";

/**
 * FR-032. Manager approval moves the request into quotation; rejection ends it, terminally
 * (BR-004). The mapping is total — there is no third decision — so there is no default case
 * and no way to reach an unlisted state.
 */
export function purchaseRequestStatusAfterApprovalDecision(
  decision: ApprovalDecision,
): PurchaseRequestStatus {
  return decision === "APPROVED" ? "IN_QUOTATION" : "REJECTED";
}

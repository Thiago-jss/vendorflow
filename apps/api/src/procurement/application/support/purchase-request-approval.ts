import type { ApprovalStepRole } from "../../../approval/application/support/approval-policy";
import type {
  ApprovalDecision,
  ApprovalFlowState,
} from "../../../approval/application/support/approval-step-state";
import {
  MANAGER_DECIDABLE_STATUSES,
  POST_QUOTATION_DECIDABLE_STATUSES,
  type PurchaseRequestStatus,
} from "./purchase-request-status";

/**
 * FR-030. The rung the Manager queue is about. It is a constant rather than a literal because
 * the queue, the capability check that guards it and the step lookup that fills it must all
 * name the same rung, and three literals are three chances to disagree.
 */
export const MANAGER_APPROVAL_STEP_ROLE: ApprovalStepRole = "MANAGER";

/**
 * FR-032/FR-034. What a decision on one rung of the ladder does to the request itself.
 *
 * The **step's** responsibility drives this, not the caller's role and not a field in the
 * payload. That matters because one person may hold MANAGER and BUYER at once: the flow is
 * waiting on exactly one step, and which one it is decides both who may act and what the
 * request becomes.
 *
 * - A **Manager** approval opens quotation (FR-032). It never approves the request outright,
 *   even in BR-001's first tier, because the amount that tier was measured against is an
 *   estimate and the real price is not known yet (BR-002).
 * - A **Purchasing or Finance** approval finishes the request only when it was the last rung.
 *   While another rung stands, the request keeps its state and the ladder simply moves on,
 *   which is why `null` — "no transition" — is a legitimate answer here rather than a missing
 *   case.
 * - A **rejection** ends the request from either side, terminally (BR-004).
 */
export function purchaseRequestStatusAfterApprovalDecision(input: {
  readonly stepRole: ApprovalStepRole;
  readonly decision: ApprovalDecision;
  /** The flow's state *after* the decision was recorded. */
  readonly flowState: ApprovalFlowState;
}): PurchaseRequestStatus | null {
  if (input.decision === "REJECTED") {
    return "REJECTED";
  }

  if (input.stepRole === "MANAGER") {
    return "IN_QUOTATION";
  }

  return input.flowState === "COMPLETED" ? "APPROVED" : null;
}

/**
 * AUTHZ-005. The states a decision on a given rung may be made from, restated inside the
 * conditional write so they are a predicate and not only a pre-check.
 *
 * A Manager step is decided on a SUBMITTED request; a Purchasing or Finance step on one in
 * IN_FINAL_APPROVAL, which is the state a quote selection put it in. There is no rung that can
 * be decided from both, which is what stops a Purchasing approval from being accepted before
 * the amount it approves exists.
 */
export function decidableStatusesForStepRole(
  stepRole: ApprovalStepRole,
): readonly PurchaseRequestStatus[] {
  return stepRole === "MANAGER"
    ? MANAGER_DECIDABLE_STATUSES
    : POST_QUOTATION_DECIDABLE_STATUSES;
}

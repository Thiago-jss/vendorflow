import type { ApprovalStepRole, RequiredApprovalStep } from "./approval-policy";

/**
 * The step lifecycle, stated explicitly rather than inferred from which timestamps happen to
 * be null. A reader — and a query — can tell "waiting on this one" from "exists but not yet
 * reachable" without reconstructing the flow's history.
 */
export const approvalStepStates = [
  "PENDING",
  "ACTIONABLE",
  "APPROVED",
  "REJECTED",
  "VOIDED",
] as const;

export type ApprovalStepState = (typeof approvalStepStates)[number];

export const approvalFlowStates = [
  "ACTIVE",
  "COMPLETED",
  "REJECTED",
  "VOIDED",
] as const;

export type ApprovalFlowState = (typeof approvalFlowStates)[number];

/** The two states a decision may put a step into. Both are final (BR-006). */
export const approvalDecisions = ["APPROVED", "REJECTED"] as const;

export type ApprovalDecision = (typeof approvalDecisions)[number];

/** A step that is still waiting for someone: the only two states a decision can act on. */
export const UNDECIDED_APPROVAL_STEP_STATES: readonly ApprovalStepState[] = [
  "PENDING",
  "ACTIONABLE",
];

export interface MaterializedApprovalStep extends RequiredApprovalStep {
  readonly state: ApprovalStepState;
}

/**
 * FR-035. The whole ladder is materialized at submission, and **exactly one** step — the
 * first — is actionable. The rest exist, in order, and are not decidable until the steps
 * ahead of them complete; that is what `PENDING` means and why it is a state rather than an
 * absence.
 */
export function materializeApprovalSteps(
  steps: readonly RequiredApprovalStep[],
): readonly MaterializedApprovalStep[] {
  return steps.map((step, index) => ({
    ...step,
    state: index === 0 ? "ACTIONABLE" : "PENDING",
  }));
}

/**
 * What a decision leaves the flow in.
 *
 * A rejection ends the flow: BR-004 makes it terminal, and the steps that will now never be
 * decided are voided rather than deleted. An approval that leaves no undecided step behind
 * completes the flow — that is the BR-001 first tier, whose only step is the Manager's.
 *
 * An approval that *does* leave steps behind keeps the flow `ACTIVE` and promotes nothing:
 * BR-002 evaluates the Purchasing and Finance steps against the **selected quote total**,
 * which does not exist until quotation. Promoting the next step here would mean asking a
 * buyer to approve an amount the requirements say is not the amount they approve.
 */
export function approvalFlowStateAfterDecision(
  decision: ApprovalDecision,
  undecidedStepsRemaining: number,
): ApprovalFlowState {
  if (decision === "REJECTED") {
    return "REJECTED";
  }

  return undecidedStepsRemaining === 0 ? "COMPLETED" : "ACTIVE";
}

/** The principal role FR-034 lets act on each step. A Purchasing step is a BUYER's. */
export const APPROVAL_STEP_DECIDER_ROLE: Readonly<
  Record<ApprovalStepRole, "MANAGER" | "BUYER" | "FINANCE">
> = {
  MANAGER: "MANAGER",
  PURCHASING: "BUYER",
  FINANCE: "FINANCE",
};

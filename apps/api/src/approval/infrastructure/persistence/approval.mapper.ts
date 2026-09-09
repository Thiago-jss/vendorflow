import {
  approvalStepRoles,
  type ApprovalStepRole,
} from "../../application/support/approval-policy";
import {
  approvalFlowStates,
  approvalStepStates,
  type ApprovalFlowState,
  type ApprovalStepState,
} from "../../application/support/approval-step-state";

/**
 * Persistence returns the PostgreSQL enums as strings. Narrowing them here, in one place,
 * means a value added to the database but not to the application contract fails loudly
 * instead of reaching the workflow as an unrecognized role or state.
 */
export function toApprovalStepRole(value: string): ApprovalStepRole {
  const role = approvalStepRoles.find((candidate) => candidate === value);

  if (role === undefined) {
    throw new Error("Persistence returned an unsupported approval step role");
  }

  return role;
}

export function toApprovalStepState(value: string): ApprovalStepState {
  const state = approvalStepStates.find((candidate) => candidate === value);

  if (state === undefined) {
    throw new Error("Persistence returned an unsupported approval step state");
  }

  return state;
}

export function toApprovalFlowState(value: string): ApprovalFlowState {
  const state = approvalFlowStates.find((candidate) => candidate === value);

  if (state === undefined) {
    throw new Error("Persistence returned an unsupported approval flow state");
  }

  return state;
}

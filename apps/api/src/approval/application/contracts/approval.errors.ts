/**
 * AUTHZ-003/AUTHZ-006. The principal authenticated, but their current roles do not let them
 * decide this kind of step. Like its procurement counterpart it names an action and never a
 * resource, so refusing it confirms nothing about what exists.
 */
export class ApprovalActionNotAuthorizedError extends Error {
  constructor(readonly attemptedAction: string) {
    super(`This principal may not ${attemptedAction} an approval step`);
    this.name = "ApprovalActionNotAuthorizedError";
  }
}

/**
 * BR-005. The actor raised this request, so no role they hold can let them decide it. This is
 * deliberately not a "not found": the requester already knows the request exists — they
 * created it — so the denial discloses nothing, and answering 404 would hide a rule the
 * caller needs to understand.
 */
export class SelfApprovalNotAllowedError extends Error {
  constructor() {
    super("A requester may not decide the approval of their own purchase request");
    this.name = "SelfApprovalNotAllowedError";
  }
}

/**
 * There is no step of this responsibility waiting for a decision: the flow is finished, the
 * request was cancelled, the step was already decided (BR-006), or the step exists but is
 * still `PENDING` behind an earlier one (FR-035). The message distinguishes none of those —
 * the caller may see the request's own state through its own routes.
 */
export class ApprovalStepNotActionableError extends Error {
  constructor() {
    super("No approval step of this responsibility is awaiting a decision");
    this.name = "ApprovalStepNotActionableError";
  }
}

/**
 * FR-031. The decision itself is well formed, and a rule about its reason refuses it. The
 * message states the rule and never echoes the submitted text (SEC-009).
 */
export class ApprovalDecisionValidationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ApprovalDecisionValidationError";
  }
}

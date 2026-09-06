import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import {
  ApprovalActionNotAuthorizedError,
  SelfApprovalNotAllowedError,
} from "../contracts/approval.errors";
import type { ApprovalStepRole } from "./approval-policy";
import { APPROVAL_STEP_DECIDER_ROLE } from "./approval-step-state";

/**
 * AUTHZ-002/AUTHZ-006. Only the role a step is assigned to may decide it, and the mapping is
 * fixed: a Manager step is a MANAGER's, a Purchasing step is a BUYER's, a Finance step is a
 * FINANCE user's.
 *
 * ADMIN is absent on purpose (AUTHZ-007): an administrator manages structure and identity and
 * holds no implicit approval authority. So is EMPLOYEE. `principal.roles` is rebuilt from the
 * `user_roles` rows by the access-token guard rather than read from a token claim, so a role
 * revoked a moment ago stops granting this on the next request.
 *
 * This is only the **capability** half of the decision. Tenant scope, the department
 * boundary, ownership and the step's own state are separate checks, made in the persistence
 * predicates that actually read and write the row.
 */
export function mayDecideApprovalStep(
  principal: TrustedPrincipal,
  stepRole: ApprovalStepRole,
): boolean {
  return principal.roles.includes(APPROVAL_STEP_DECIDER_ROLE[stepRole]);
}

export function assertMayDecideApprovalStep(
  principal: TrustedPrincipal,
  stepRole: ApprovalStepRole,
): void {
  if (!mayDecideApprovalStep(principal, stepRole)) {
    throw new ApprovalActionNotAuthorizedError("decide");
  }
}

/**
 * BR-005. Segregation of duties, with no fallback and no override: holding MANAGER does not
 * let a person approve what they themselves raised, and neither does holding ADMIN as well.
 */
export function assertNotSelfApproval(
  principal: TrustedPrincipal,
  requesterId: string,
): void {
  if (principal.userId === requesterId) {
    throw new SelfApprovalNotAllowedError();
  }
}

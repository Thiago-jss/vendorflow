import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import {
  ApprovalActionNotAuthorizedError,
  SelfApprovalNotAllowedError,
} from "../contracts/approval.errors";
import type { ApprovalStepRole } from "./approval-policy";
import { APPROVAL_STEP_DECIDER_ROLE } from "./approval-step-state";

/**
 * AUTHZ-004. The boundary each responsibility acts inside.
 *
 * A Manager is a manager *of a Department*, so a Manager step is decided only on a request
 * that belongs to the decider's own Department. Buyer and Finance act at organization scope,
 * which the requirement states outright — a purchasing or finance decision is not a
 * departmental one, and narrowing it to the decider's Department would make most requests
 * undecidable by the people responsible for deciding them.
 *
 * This is a *scope*, not a permission: it says which predicate the request is read under, and
 * the capability check below is separate and still required.
 */
export const APPROVAL_STEP_SCOPE: Readonly<
  Record<ApprovalStepRole, "DEPARTMENT" | "ORGANIZATION">
> = {
  MANAGER: "DEPARTMENT",
  PURCHASING: "ORGANIZATION",
  FINANCE: "ORGANIZATION",
};

/**
 * AUTHZ-002/AUTHZ-006. Only the role a step is assigned to may decide it, and the mapping is
 * fixed: a Manager step is a MANAGER's, a Purchasing step is a BUYER's, a Finance step is a
 * FINANCE user's. The step names the responsibility; the caller does not get to choose which
 * of their roles they are acting as.
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

/**
 * AUTHZ-003, checked before any read.
 *
 * The precise rule is per step — the ladder names a responsibility and the principal is checked
 * against that one — but the step cannot be known without reading. This is the cheap gate that
 * makes the read safe to perform: a principal who holds none of the three decision-making roles
 * is refused outright, so an EMPLOYEE or a lone ADMIN cannot use the difference between 403 and
 * 404 to discover whether a request exists.
 */
export function mayDecideSomeApprovalStep(
  principal: TrustedPrincipal,
): boolean {
  return Object.values(APPROVAL_STEP_DECIDER_ROLE).some((role) =>
    principal.roles.includes(role),
  );
}

export function assertMayDecideAnyApprovalStep(
  principal: TrustedPrincipal,
): void {
  if (!mayDecideSomeApprovalStep(principal)) {
    throw new ApprovalActionNotAuthorizedError("decide");
  }
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

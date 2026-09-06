import type {
  PrincipalRole,
  TrustedPrincipal,
} from "../../../platform/tenancy/trusted-principal";
import { PurchaseRequestActionNotAuthorizedError } from "../contracts/purchase-request.errors";

/**
 * FR-020: "An **Employee** can create a Purchase Request in DRAFT."
 *
 * Authentication is not authorization (AUTHZ-003). Every route in this module is already
 * behind the default-deny access-token guard, but that guard only establishes *who* the
 * caller is. Raising a purchase request is a capability the requirements grant to one role,
 * so a principal holding, say, only BUYER or FINANCE must be refused here even though they
 * authenticated perfectly well.
 *
 * `principal.roles` is not a token claim. The access-token guard discards the claims and
 * rebuilds `TrustedPrincipal` from the `user_roles` rows, so a role revoked a moment ago
 * stops granting this capability on the next request rather than at token expiry — and a
 * forged or stale `roles` claim buys nothing.
 *
 * This is deliberately a single explicit rule rather than a policy engine: there is one
 * capability to guard in this module, and a framework built for it would have exactly one
 * user.
 */
export const PURCHASE_REQUEST_CREATION_ROLE: PrincipalRole = "EMPLOYEE";

export function mayCreatePurchaseRequest(principal: TrustedPrincipal): boolean {
  return principal.roles.includes(PURCHASE_REQUEST_CREATION_ROLE);
}

export function assertMayCreatePurchaseRequest(
  principal: TrustedPrincipal,
): void {
  if (!mayCreatePurchaseRequest(principal)) {
    throw new PurchaseRequestActionNotAuthorizedError("create");
  }
}

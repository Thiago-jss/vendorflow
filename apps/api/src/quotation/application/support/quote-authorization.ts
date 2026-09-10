import type {
  PrincipalRole,
  TrustedPrincipal,
} from "../../../platform/tenancy/trusted-principal";
import { QuotationActionNotAuthorizedError } from "../contracts/quotation.errors";

/**
 * FR-040/FR-043/FR-044/FR-046. Quotation is the Buyer's work, and only the Buyer's.
 *
 * ADMIN is deliberately absent, and that is the difference between this module and the
 * supplier registry next door. An Administrator maintains master data — that is what FR-010
 * says and it is what an Administrator is for. Registering a supplier's price, comparing
 * offers and choosing a winner are commercial decisions with a monetary consequence, and
 * AUTHZ-007 is explicit that an Administrator holds no implicit authority over the approval
 * policy. Letting ADMIN select a quote would hand the amount that Purchasing and Finance
 * approve to a role the policy never mentions.
 *
 * `principal.roles` is rebuilt from the `user_roles` rows by the access-token guard rather
 * than read from a token claim, so a role revoked a moment ago stops granting this on the next
 * request.
 */
export const QUOTATION_ROLE: PrincipalRole = "BUYER";

export function mayRunQuotation(principal: TrustedPrincipal): boolean {
  return principal.roles.includes(QUOTATION_ROLE);
}

export function assertMayRunQuotation(
  principal: TrustedPrincipal,
  attemptedAction: string,
): void {
  if (!mayRunQuotation(principal)) {
    throw new QuotationActionNotAuthorizedError(attemptedAction);
  }
}

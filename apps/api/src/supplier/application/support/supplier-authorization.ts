import type {
  PrincipalRole,
  TrustedPrincipal,
} from "../../../platform/tenancy/trusted-principal";
import { SupplierActionNotAuthorizedError } from "../contracts/supplier.errors";

/**
 * FR-010: "A **Buyer or Administrator** can register a Supplier."
 *
 * Both act at organization scope for this capability (AUTHZ-004). That is a statement about
 * the supplier registry and nothing else: it does not give an Administrator a way to register
 * a quote, select one, or decide an approval step. AUTHZ-007 is not weakened by letting an
 * Administrator maintain master data, which is precisely what an Administrator is for.
 *
 * `principal.roles` is rebuilt from the `user_roles` rows by the access-token guard rather
 * than read from a token claim, so a role revoked a moment ago stops granting this on the next
 * request.
 */
export const SUPPLIER_MAINTENANCE_ROLES: readonly PrincipalRole[] = [
  "BUYER",
  "ADMIN",
];

export function mayMaintainSuppliers(principal: TrustedPrincipal): boolean {
  return principal.roles.some((role) =>
    SUPPLIER_MAINTENANCE_ROLES.includes(role),
  );
}

export function assertMayMaintainSuppliers(
  principal: TrustedPrincipal,
  attemptedAction: string,
): void {
  if (!mayMaintainSuppliers(principal)) {
    throw new SupplierActionNotAuthorizedError(attemptedAction);
  }
}

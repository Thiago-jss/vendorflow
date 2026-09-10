import type {
  PrincipalRole,
  TrustedPrincipal,
} from "../../../platform/tenancy/trusted-principal";
import { PurchaseOrderActionNotAuthorizedError } from "../contracts/purchase-order.errors";

/**
 * FR-050 and FR-054, which grant different things and are therefore two rules rather than one.
 *
 * **Issuance is the Buyer's.** FR-050 says "a Buyer can issue a Purchase Order", and issuing is
 * the commercial act that commits the organization to a supplier at a price. An Administrator
 * has no more standing to do that than to select the quote it is derived from (AUTHZ-007).
 *
 * **Reading and cancelling are the Buyer's or the Administrator's.** FR-054 names both
 * explicitly. Cancellation is a correction to a document rather than a purchasing decision — it
 * commits nothing, reopens nothing and cannot resurrect a request — which is why an
 * Administrator may make it and may not make the other one.
 *
 * Both act at organization scope (AUTHZ-004).
 */
export const PURCHASE_ORDER_ISSUING_ROLE: PrincipalRole = "BUYER";

export const PURCHASE_ORDER_ADMINISTRATION_ROLES: readonly PrincipalRole[] = [
  "BUYER",
  "ADMIN",
];

export function assertMayIssuePurchaseOrder(
  principal: TrustedPrincipal,
): void {
  if (!principal.roles.includes(PURCHASE_ORDER_ISSUING_ROLE)) {
    throw new PurchaseOrderActionNotAuthorizedError("issue");
  }
}

export function assertMayAdministerPurchaseOrders(
  principal: TrustedPrincipal,
  attemptedAction: string,
): void {
  if (
    !principal.roles.some((role) =>
      PURCHASE_ORDER_ADMINISTRATION_ROLES.includes(role),
    )
  ) {
    throw new PurchaseOrderActionNotAuthorizedError(attemptedAction);
  }
}

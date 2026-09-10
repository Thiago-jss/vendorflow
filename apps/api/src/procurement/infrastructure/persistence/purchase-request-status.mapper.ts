import {
  purchaseRequestStatuses,
  type PurchaseRequestStatus,
} from "../../application/support/purchase-request-status";

/**
 * Persistence returns the PostgreSQL enum as a string. Narrowing it here, in one place,
 * means a state added to the database but not to the application contract fails loudly
 * instead of reaching the state machine as an unrecognized status.
 */
export function toPurchaseRequestStatus(status: string): PurchaseRequestStatus {
  const purchaseRequestStatus = purchaseRequestStatuses.find(
    (candidate) => candidate === status,
  );

  if (purchaseRequestStatus === undefined) {
    throw new Error("Persistence returned an unsupported purchase request status");
  }

  return purchaseRequestStatus;
}

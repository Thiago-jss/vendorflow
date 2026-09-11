import type { PurchaseRequestStatus } from "./contracts";
import { statusLabel } from "./formatting";

/**
 * The status the API reported. The colour is decoration: the badge always carries the word,
 * so nothing about the state of a request is conveyed by colour alone.
 */
export function StatusBadge({ status }: { readonly status: PurchaseRequestStatus }) {
  return (
    <span className="status-badge" data-status={status}>
      {statusLabel(status)}
    </span>
  );
}

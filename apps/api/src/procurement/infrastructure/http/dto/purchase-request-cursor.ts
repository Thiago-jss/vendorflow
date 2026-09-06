import { InvalidPaginationCursorError } from "../../../application/contracts/purchase-request.errors";
import type { PurchaseRequestListCursor } from "../../../application/contracts/purchase-request.repository";

const CURSOR_SEPARATOR = "|";

/**
 * The cursor is the last row's ordering key, base64url-encoded so clients treat it as opaque
 * and do not build one by hand.
 *
 * It is deliberately not signed or encrypted: it carries no secret. Both halves are values
 * the caller already received in the same response, and the query that consumes it is
 * scoped to the caller's organization and requester id, so a forged cursor can only move a
 * caller around inside their own rows (ADR-002).
 */
export function encodePurchaseRequestCursor(
  cursor: PurchaseRequestListCursor,
): string {
  return Buffer.from(
    `${cursor.createdAt.toISOString()}${CURSOR_SEPARATOR}${cursor.id}`,
    "utf8",
  ).toString("base64url");
}

export function decodePurchaseRequestCursor(
  value: string,
): PurchaseRequestListCursor {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  const separator = decoded.indexOf(CURSOR_SEPARATOR);

  if (separator === -1) {
    throw new InvalidPaginationCursorError();
  }

  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (Number.isNaN(createdAt.getTime()) || id.length === 0) {
    throw new InvalidPaginationCursorError();
  }

  return { createdAt, id };
}

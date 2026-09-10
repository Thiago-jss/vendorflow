import { PurchaseOrderValidationError } from "../contracts/purchase-order.errors";

/** FR-054, counted after trimming: ten spaces are not a reason. */
export const MINIMUM_CANCELLATION_REASON_LENGTH = 10;

/** The width of the `cancellation_reason` column, restated so an over-long value gets a stated
 * domain answer instead of a driver error. */
export const CANCELLATION_REASON_COLUMN_WIDTH = 2000;

/**
 * FR-054. Cancelling a purchase order must say why.
 *
 * The reason is auditable text about a commercial document and stays in tenant-scoped
 * PostgreSQL. It is never put in a broker payload, never logged, and never echoed in an error
 * message — the messages below name the rule and never the text (SEC-009).
 */
export function normalizeCancellationReason(reason: string): string {
  const trimmed = reason.trim();

  if (trimmed.length < MINIMUM_CANCELLATION_REASON_LENGTH) {
    throw new PurchaseOrderValidationError(
      `A cancellation reason requires at least ${MINIMUM_CANCELLATION_REASON_LENGTH} non-whitespace characters`,
    );
  }

  if (trimmed.length > CANCELLATION_REASON_COLUMN_WIDTH) {
    throw new PurchaseOrderValidationError(
      `A cancellation reason may not exceed ${CANCELLATION_REASON_COLUMN_WIDTH} characters`,
    );
  }

  return trimmed;
}

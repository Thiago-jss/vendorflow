import { SupplierQuoteValidationError } from "../contracts/quotation.errors";

/** FR-044, counted after trimming: ten spaces are not a rationale. */
export const MINIMUM_SELECTION_RATIONALE_LENGTH = 10;

/** The width of the `selection_rationale` column, restated so an over-long value gets a
 * stated domain answer instead of a driver error. */
export const SELECTION_RATIONALE_COLUMN_WIDTH = 2000;

/**
 * FR-044. Selection is required even when only one quote exists, and it must say why.
 *
 * The rationale is the one piece of free text this module keeps, and it is kept because a
 * purchase decision without a recorded reason is exactly what an audit trail is for. It stays
 * in tenant-scoped PostgreSQL: it is never put in an outbox payload, never logged, and never
 * echoed in an error message.
 */
export function normalizeSelectionRationale(rationale: string): string {
  const trimmed = rationale.trim();

  if (trimmed.length < MINIMUM_SELECTION_RATIONALE_LENGTH) {
    throw new SupplierQuoteValidationError(
      `A selection rationale requires at least ${MINIMUM_SELECTION_RATIONALE_LENGTH} non-whitespace characters`,
    );
  }

  if (trimmed.length > SELECTION_RATIONALE_COLUMN_WIDTH) {
    throw new SupplierQuoteValidationError(
      `A selection rationale may not exceed ${SELECTION_RATIONALE_COLUMN_WIDTH} characters`,
    );
  }

  return trimmed;
}

/**
 * BR-023, inclusive on the validity date. A quote valid until the 5th is selectable *on* the
 * 5th, in the organization's own reading of that day — which is why `valid_until` is a DATE
 * and the comparison is made against a calendar day rather than an instant. Comparing an
 * instant to a date would make a quote expire at midnight UTC for a buyer whose working day
 * has not finished.
 *
 * This is the pre-check that produces a good message. The authority is the conditional write,
 * which restates the same comparison inside the transaction (REL-005).
 */
export function isQuoteStillValid(validUntil: Date, now: Date): boolean {
  return toCalendarDayNumber(validUntil) >= toCalendarDayNumber(now);
}

/**
 * A DATE column round-trips as midnight UTC, so both sides are reduced to the same UTC
 * calendar day before comparison. No timezone arithmetic, and no `Date` mutation.
 */
function toCalendarDayNumber(value: Date): number {
  return Date.UTC(
    value.getUTCFullYear(),
    value.getUTCMonth(),
    value.getUTCDate(),
  );
}

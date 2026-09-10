/**
 * FR-053. The human-readable identifier a purchase order carries, and the only place its shape
 * is decided.
 *
 * `PO-000001`, zero-padded to six digits and unique **within the organization** (MT-006). One
 * counter per tenant is deliberate: it means `PO-000001` is the first order of every
 * organization, so no tenant can infer another's purchasing volume from the numbers it sees.
 *
 * The padding is a minimum, not a ceiling. An organization that issues more than 999,999 orders
 * gets `PO-1000000` rather than a wrapped or truncated number, and the database CHECK is
 * written as "six or more digits" for exactly that reason. A format that silently stops being
 * unique is worse than one that gets longer.
 *
 * The counter itself is a `bigint`, not a `number`: the value is allocated by PostgreSQL from a
 * BIGINT column, and narrowing it to a JavaScript number would introduce a precision cliff into
 * an identifier that must be exact.
 */
export const PURCHASE_ORDER_NUMBER_PREFIX = "PO-";

export const PURCHASE_ORDER_NUMBER_MINIMUM_DIGITS = 6;

/** The same shape the database CHECK enforces, restated here so both can be tested together. */
export const PURCHASE_ORDER_NUMBER_PATTERN = new RegExp(
  `^${PURCHASE_ORDER_NUMBER_PREFIX}\\d{${PURCHASE_ORDER_NUMBER_MINIMUM_DIGITS},}$`,
);

export function formatPurchaseOrderNumber(sequenceValue: bigint): string {
  if (sequenceValue < 1n) {
    // The first allocation is 1, never 0 and never 2. A caller that reached this with a
    // smaller value has an allocation bug, and formatting it would hide the bug behind a
    // plausible-looking identifier.
    throw new Error("A purchase order sequence value starts at 1");
  }

  return `${PURCHASE_ORDER_NUMBER_PREFIX}${sequenceValue
    .toString()
    .padStart(PURCHASE_ORDER_NUMBER_MINIMUM_DIGITS, "0")}`;
}

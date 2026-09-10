import {
  MAXIMUM_STORABLE_CENTS,
  isStorableCents,
} from "../../../platform/numeric/centavos";
import {
  calculateLineTotalCents,
  type LineTotalInput,
} from "../../../platform/numeric/line-total";

/**
 * FR-042 and BR-030 – BR-033. A quote's arithmetic, in exact integers, once.
 *
 * The primitives it builds on — the thousandths representation of a quantity, the centavo
 * representation of money, and the single half-up step that turns the two into a line total —
 * live in `platform/numeric`. They are representation, not any one module's private state:
 * two modules that each define their own idea of "half-up at the centavo" will eventually
 * disagree about a total, and a disagreement about a total is a disagreement about what a
 * supplier is owed. What stays here is the part that is only true of a *quote*: freight, a
 * discount, and the refusals BR-032 attaches to them.
 *
 * There is no `Number`, no `parseFloat`, no `toFixed` and no division that is not exact
 * integer division anywhere in this file.
 */

/** Quantity is taken from the persisted PurchaseRequestItem. Never client input (BR-025). */
export type QuoteLineInput = LineTotalInput;

export interface QuoteTotalsInput {
  readonly lines: readonly QuoteLineInput[];
  readonly freightCents: bigint;
  readonly discountCents: bigint;
}

export interface QuoteTotals {
  /** Each line's own rounded total, in the order the lines were given. */
  readonly lineTotalsCents: readonly bigint[];
  readonly itemsTotalCents: bigint;
  readonly totalCents: bigint;
}

export type QuoteTotalsFailure =
  | "negative-freight"
  | "negative-discount"
  | "discount-exceeds-total"
  | "not-storable";

export type QuoteTotalsResult =
  | { readonly ok: true; readonly value: QuoteTotals }
  | { readonly ok: false; readonly reason: QuoteTotalsFailure };

/**
 * BR-033: half-up, at the centavo, applied **once** at the line total and never at the unit
 * price. The rounding itself is the platform primitive; a quote adds nothing to it, and
 * re-deriving it here is exactly how two modules come to disagree about one line.
 */
export function calculateQuoteLineTotalCents(line: QuoteLineInput): bigint {
  return calculateLineTotalCents(line);
}

/**
 * FR-042. `sum(rounded line totals) + freight − discount`.
 *
 * Lines are summed **after** rounding, so the number a buyer sees on a line is the number that
 * contributes to the total: summing unrounded lines and rounding once at the end produces a
 * total no set of displayed lines adds up to.
 *
 * Every failure below is a stated domain refusal rather than a wrapped value or a database
 * error. `not-storable` is the BIGINT range of the monetary columns — a technical
 * representation limit, explicitly not a policy about how much a supplier may charge — and it
 * is checked on the intermediate sum as well as on the result, so an overflow cannot hide
 * inside a subtraction that happens to bring the total back into range.
 */
export function calculateQuoteTotals(
  input: QuoteTotalsInput,
): QuoteTotalsResult {
  if (input.freightCents < 0n) {
    return { ok: false, reason: "negative-freight" };
  }

  if (input.discountCents < 0n) {
    return { ok: false, reason: "negative-discount" };
  }

  const lineTotalsCents = input.lines.map((line) =>
    calculateQuoteLineTotalCents(line),
  );
  const itemsTotalCents = lineTotalsCents.reduce(
    (total, lineTotal) => total + lineTotal,
    0n,
  );

  if (!isStorableCents(itemsTotalCents)) {
    return { ok: false, reason: "not-storable" };
  }

  const beforeDiscount = itemsTotalCents + input.freightCents;

  if (beforeDiscount > MAXIMUM_STORABLE_CENTS) {
    return { ok: false, reason: "not-storable" };
  }

  const totalCents = beforeDiscount - input.discountCents;

  // BR-032. A discount larger than the goods plus freight would make a supplier owe the
  // organization money, which is not a quote. Refused, never clamped to zero.
  if (totalCents < 0n) {
    return { ok: false, reason: "discount-exceeds-total" };
  }

  return {
    ok: true,
    value: { lineTotalsCents, itemsTotalCents, totalCents },
  };
}

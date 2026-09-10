import { calculateLineTotalCents } from "../../../platform/numeric/line-total";
import type { ScaledQuantity } from "../../../platform/numeric/scaled-quantity";

/**
 * FR-020 and BR-032/BR-033, and nothing else.
 *
 * The exact primitives this builds on — the centavo representation of money, the thousandths
 * representation of a quantity and the single half-up step that turns the two into a line
 * total — belong to `platform/numeric`, because procurement, quotation and purchase-order all
 * speak them and a second definition of any of them is a second answer to "what is this
 * total".
 *
 * What stays here is the part that is only true of a *purchase request*: an estimate is the
 * requester's own figure rather than a supplier's price, and a request total is the sum of
 * its estimated lines.
 *
 * There is no `Number`, no `parseFloat`, no `toFixed` and no inexact division anywhere in
 * this chain.
 */
export interface EstimatedLine {
  /** Thousandths of a unit; see `platform/numeric/scaled-quantity.ts`. */
  readonly quantityScaled: ScaledQuantity;
  readonly estimatedUnitPriceCents: bigint;
}

/**
 * BR-033 at a request line. The rounding itself is the platform primitive; the only thing
 * added here is that the price being multiplied is an *estimate*.
 */
export function calculateEstimatedLineTotalCents(line: EstimatedLine): bigint {
  return calculateLineTotalCents({
    quantityScaled: line.quantityScaled,
    unitPriceCents: line.estimatedUnitPriceCents,
  });
}

/**
 * BR-032. A request total is the sum of the **already rounded** line totals, so the number
 * a requester sees on a line is the number that contributes to the total. Summing unrounded
 * lines and rounding once at the end would produce a total that no set of displayed lines
 * adds up to.
 *
 * This is the only place a request total is produced, and it takes lines — never a total.
 */
export function calculateEstimatedTotalCents(
  lines: readonly EstimatedLine[],
): bigint {
  return lines.reduce(
    (total, line) => total + calculateEstimatedLineTotalCents(line),
    0n,
  );
}

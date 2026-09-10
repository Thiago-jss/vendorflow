import { quantityScaleFactor, type ScaledQuantity } from "./scaled-quantity";

/**
 * BR-033. One exact scaled quantity times one integer unit price, rounded half-up to the
 * centavo exactly once.
 *
 * It is here rather than in a business module because both a purchase request's estimate and
 * a supplier quote's line are the same arithmetic, and two modules that each write their own
 * half-up step will eventually disagree about a total — a disagreement about a total is a
 * disagreement about what a supplier is owed. What a line *means* stays with its owner; only
 * the multiplication and the single rounding step live here.
 */
export interface LineTotalInput {
  readonly quantityScaled: ScaledQuantity;
  readonly unitPriceCents: bigint;
}

/**
 * The multiplication happens in exact integer arithmetic before any division, so the only
 * rounding in the whole calculation is the single half-up step below. `remainder * 2 >=
 * divisor` is the half-up test written without a division that would reintroduce rounding;
 * quantity is positive and price is non-negative, so there is no away-from-zero case to
 * distinguish.
 *
 * The unit price is never rounded: rounding it first would be a second rounding step, and
 * BR-033 permits exactly one, at the line.
 */
export function calculateLineTotalCents(line: LineTotalInput): bigint {
  const divisor = quantityScaleFactor();
  const scaledTotal = line.quantityScaled * line.unitPriceCents;
  const quotient = scaledTotal / divisor;
  const remainder = scaledTotal % divisor;

  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

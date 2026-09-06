import { quantityScaleFactor, type ScaledQuantity } from "./decimal-quantity";

/**
 * BR-030/BR-031. Money is BRL-only and is an integer number of centavos in the database, in
 * the domain and on the wire. There is no currency column and no currency field.
 *
 * The domain type is `bigint`, and the wire type is a digit string. Both are exact at any
 * magnitude, which is what lets this module carry no business ceiling on a unit price or a
 * total: after the arbitrary caps of the first implementation were removed, a total can
 * legitimately exceed `Number.MAX_SAFE_INTEGER`, and narrowing it to a JSON number would
 * silently corrupt it. A string does not.
 *
 * The one remaining ceiling is `MAXIMUM_STORABLE_CENTS`. It is the range of PostgreSQL's
 * `BIGINT`, which is what the monetary columns are — a storage width, explicitly technical,
 * not a policy about how much an organization may request. Exceeding it is reported as such
 * rather than wrapping or truncating.
 */
export const MAXIMUM_STORABLE_CENTS = 9_223_372_036_854_775_807n;

/** Canonical non-negative integer, no sign, no separators, no leading zeros. */
export const CENTS_WIRE_PATTERN = /^(0|[1-9]\d*)$/;

export type CentsParseResult =
  | { readonly ok: true; readonly value: bigint }
  | { readonly ok: false; readonly reason: "malformed" | "not-storable" };

export function parseCents(value: string): CentsParseResult {
  if (!CENTS_WIRE_PATTERN.test(value)) {
    return { ok: false, reason: "malformed" };
  }

  const parsed = BigInt(value);

  if (parsed > MAXIMUM_STORABLE_CENTS) {
    return { ok: false, reason: "not-storable" };
  }

  return { ok: true, value: parsed };
}

export function formatCents(value: bigint): string {
  return value.toString();
}

export interface EstimatedLine {
  /** Thousandths of a unit; see `decimal-quantity.ts`. */
  readonly quantityScaled: ScaledQuantity;
  readonly estimatedUnitPriceCents: bigint;
}

/**
 * BR-033: rounding is half-up, at the centavo, applied **once** at the line total and never
 * at the unit price.
 *
 * The multiplication happens in exact integer arithmetic before any division, so the only
 * rounding in the whole calculation is the single half-up step below. `remainder * 2 >=
 * divisor` is the half-up test written without a division that would reintroduce rounding;
 * quantity is positive and price is non-negative, so there is no away-from-zero case to
 * distinguish.
 */
export function calculateEstimatedLineTotalCents(line: EstimatedLine): bigint {
  const divisor = quantityScaleFactor();
  const scaledTotal = line.quantityScaled * line.estimatedUnitPriceCents;
  const quotient = scaledTotal / divisor;
  const remainder = scaledTotal % divisor;

  return remainder * 2n >= divisor ? quotient + 1n : quotient;
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

export function isStorableCents(value: bigint): boolean {
  return value >= 0n && value <= MAXIMUM_STORABLE_CENTS;
}

/**
 * BR-030/BR-031. Money is BRL-only and is an integer number of centavos in the database, in
 * the domain and on the wire. There is no currency column and no currency field.
 *
 * The domain type is `bigint`, and the wire type is a digit string. Both are exact at any
 * magnitude, which is what lets this module carry no business ceiling on a unit price or a
 * total: a total can legitimately exceed `Number.MAX_SAFE_INTEGER`, and narrowing it to a
 * JSON number would silently corrupt it. A string does not.
 *
 * The one remaining ceiling is `MAXIMUM_STORABLE_CENTS`. It is the range of PostgreSQL's
 * `BIGINT`, which is what the monetary columns are — a storage width, explicitly technical,
 * not a policy about how much anyone may charge or request. Exceeding it is reported as such
 * rather than wrapping or truncating.
 *
 * This file lives in `platform` because it is *representation*, not policy: procurement,
 * quotation and purchase-order all speak centavos, and three modules that each define their
 * own idea of "a centavo amount" will eventually disagree about a total. What a given amount
 * is allowed to be — a request's estimate, a quote's discount — stays in the module that owns
 * the rule.
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

export function isStorableCents(value: bigint): boolean {
  return value >= 0n && value <= MAXIMUM_STORABLE_CENTS;
}

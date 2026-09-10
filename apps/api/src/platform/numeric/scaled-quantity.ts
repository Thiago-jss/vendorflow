/**
 * Quantities are exact decimals, never IEEE-754 binary floating point.
 *
 * The representation is a `bigint` count of thousandths — 1.25 is `1250n`. That is the only
 * form quantity takes inside the application: it is parsed straight from the wire string
 * into scaled units by digit manipulation, and formatted back the same way. No `Number`,
 * `parseFloat` or arithmetic on a binary float appears anywhere in the chain, so 0.1 + 0.2
 * has no opportunity to become 0.30000000000000004.
 *
 * Both bounds below are **technical representation constraints**, not business policy: they
 * are the precision and scale the `NUMERIC(20, 3)` column declares, and they are stated here
 * so the domain refuses an unstorable quantity itself instead of letting the driver fail on
 * it. Neither is a rule about how much may be requested.
 */
export const QUANTITY_DECIMAL_SCALE = 3;

/** Total significant digits of `NUMERIC(20, 3)`; 17 of them precede the decimal point. */
export const QUANTITY_DECIMAL_PRECISION = 20;

const QUANTITY_SCALE_FACTOR = 10n ** BigInt(QUANTITY_DECIMAL_SCALE);

/**
 * The largest value the column holds, in thousandths: 99999999999999999.999.
 *
 * Derived from precision and scale rather than written as a literal, so changing the column
 * changes one constant and the derivation follows. A scaled quantity is exactly the column's
 * digits with the point removed, so the maximum is simply "precision nines".
 */
export const MAXIMUM_SCALED_QUANTITY =
  10n ** BigInt(QUANTITY_DECIMAL_PRECISION) - 1n;

/**
 * Canonical decimal, no sign, no exponent, no leading zeros. Anything else is refused rather
 * than coerced: "1e3", "+1", " 1 " and "01.5" are all ways of asking the parser to guess.
 */
const QUANTITY_ANY_SCALE_PATTERN = /^(0|[1-9]\d*)(?:\.(\d+))?$/;

/**
 * The same shape, additionally bounded to the declared scale. This is the format rule the
 * HTTP boundary enforces, so a value carrying more precision than the system keeps is a
 * malformed representation (400) rather than a business-rule violation (422). The parser
 * below deliberately uses the permissive pattern instead, so it can tell a caller that has
 * no HTTP boundary *which* rule they broke.
 */
export const QUANTITY_WIRE_PATTERN = new RegExp(
  `^(0|[1-9]\\d*)(?:\\.\\d{1,${QUANTITY_DECIMAL_SCALE}})?$`,
);

/**
 * A quantity in thousandths. Kept as a plain `bigint` rather than wrapped in a class so it
 * survives structural typing across the application boundary without a conversion ritual;
 * the name is what carries the unit.
 */
export type ScaledQuantity = bigint;

export interface QuantityParseFailure {
  readonly reason:
    | "malformed"
    | "scale-exceeded"
    | "not-positive"
    | "not-storable";
}

export type QuantityParseResult =
  | { readonly ok: true; readonly value: ScaledQuantity }
  | { readonly ok: false; readonly failure: QuantityParseFailure };

/**
 * Parses a decimal string into thousandths exactly. The fractional digits are padded to the
 * declared scale and concatenated onto the integer part, so the result is a digit-string
 * conversion rather than a multiplication that could round.
 */
export function parseQuantity(value: string): QuantityParseResult {
  const match = QUANTITY_ANY_SCALE_PATTERN.exec(value);

  if (match === null) {
    return { ok: false, failure: { reason: "malformed" } };
  }

  const integerDigits = match[1] ?? "0";
  const fractionDigits = match[2] ?? "";

  // Refused, not rounded. Silently dropping a digit the caller wrote is how a quantity stops
  // meaning what it said.
  if (fractionDigits.length > QUANTITY_DECIMAL_SCALE) {
    return { ok: false, failure: { reason: "scale-exceeded" } };
  }

  const scaled = BigInt(
    `${integerDigits}${fractionDigits.padEnd(QUANTITY_DECIMAL_SCALE, "0")}`,
  );

  // BR-012: quantity > 0.
  if (scaled <= 0n) {
    return { ok: false, failure: { reason: "not-positive" } };
  }

  // Refused here rather than by the driver. A value wider than the column would otherwise
  // pass every domain rule and then surface as a PostgreSQL numeric overflow — a persistence
  // failure standing in for a validation answer the domain is perfectly able to give.
  if (scaled > MAXIMUM_SCALED_QUANTITY) {
    return { ok: false, failure: { reason: "not-storable" } };
  }

  return { ok: true, value: scaled };
}

/**
 * Always emits the declared scale — 4 becomes "4.000" — so a reader of the API can see the
 * precision the system actually keeps instead of inferring it from whichever value happened
 * to have trailing zeros.
 */
export function formatQuantity(scaled: ScaledQuantity): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled)
    .toString()
    .padStart(QUANTITY_DECIMAL_SCALE + 1, "0");
  const integerPart = digits.slice(0, digits.length - QUANTITY_DECIMAL_SCALE);
  const fractionPart = digits.slice(digits.length - QUANTITY_DECIMAL_SCALE);

  return `${negative ? "-" : ""}${integerPart}.${fractionPart}`;
}

/** The factor a scaled quantity must be divided by to become whole units. */
export function quantityScaleFactor(): bigint {
  return QUANTITY_SCALE_FACTOR;
}

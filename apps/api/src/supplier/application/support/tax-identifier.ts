/**
 * FR-010/FR-013. A Supplier's fiscal identity, modelled as a decision rather than as a guess.
 *
 * The type is declared by the caller and is never inferred from the shape of the string.
 * Sniffing "fourteen digits, therefore a CNPJ" would be a claim about a national registry
 * made by a regular expression, and it would silently mislabel an internal supplier code that
 * happens to be fourteen digits long.
 *
 * Two forms are kept for every supplier, and they answer different questions:
 *
 * - `taxIdentifier` is what the organization typed, trimmed. It exists so a person recognizes
 *   their own data — `11.222.333/0001-81` reads as a CNPJ and `11222333000181` does not.
 * - `taxIdentifierNormalized` is the comparison form, and the only one FR-013's uniqueness is
 *   decided on. Two spellings of one identifier therefore collide, which is the entire point.
 */
export const supplierTaxIdentifierTypes = ["CNPJ", "OTHER"] as const;

export type SupplierTaxIdentifierType =
  (typeof supplierTaxIdentifierTypes)[number];

export const CNPJ_DIGIT_COUNT = 14;

/** The column width both forms share. */
export const TAX_IDENTIFIER_MAXIMUM_LENGTH = 40;

export interface NormalizedTaxIdentifier {
  readonly taxIdentifier: string;
  readonly taxIdentifierNormalized: string;
}

export type TaxIdentifierNormalizationFailure =
  | "blank"
  | "too-long"
  | "cnpj-malformed"
  | "cnpj-check-digits"
  | "no-comparable-characters";

export type TaxIdentifierNormalizationResult =
  | { readonly ok: true; readonly value: NormalizedTaxIdentifier }
  | { readonly ok: false; readonly reason: TaxIdentifierNormalizationFailure };

/**
 * The two check-digit weight vectors of the Brazilian CNPJ, from the Receita Federal's
 * modulus-11 rule. They are written out rather than generated, because the sequence restarts
 * at 9 after 2 and a generator for that is longer than the two lines it would replace.
 */
const FIRST_CHECK_DIGIT_WEIGHTS = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] as const;
const SECOND_CHECK_DIGIT_WEIGHTS = [
  6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2,
] as const;

export function normalizeTaxIdentifier(
  type: SupplierTaxIdentifierType,
  raw: string,
): TaxIdentifierNormalizationResult {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { ok: false, reason: "blank" };
  }

  if (trimmed.length > TAX_IDENTIFIER_MAXIMUM_LENGTH) {
    return { ok: false, reason: "too-long" };
  }

  return type === "CNPJ"
    ? normalizeCnpj(trimmed)
    : normalizeOtherIdentifier(trimmed);
}

/**
 * Punctuation is what a CNPJ is usually written with, so it is stripped rather than refused.
 * Anything else — a letter, an embedded space — is not formatting and is refused, because
 * dropping it would change the identifier the caller believes they registered.
 */
function normalizeCnpj(trimmed: string): TaxIdentifierNormalizationResult {
  const digits = trimmed.replace(/[.\-/]/g, "");

  if (!/^\d+$/.test(digits) || digits.length !== CNPJ_DIGIT_COUNT) {
    return { ok: false, reason: "cnpj-malformed" };
  }

  // Fourteen repetitions of one digit satisfy the modulus-11 arithmetic and are not CNPJs.
  // Refused explicitly, because "00000000000000" passing a check-digit test is exactly the
  // kind of correctness that looks fine until a real invoice is issued against it.
  if (/^(\d)\1{13}$/.test(digits)) {
    return { ok: false, reason: "cnpj-check-digits" };
  }

  const body = digits.slice(0, 12);
  const firstCheckDigit = modulus11CheckDigit(body, FIRST_CHECK_DIGIT_WEIGHTS);
  const secondCheckDigit = modulus11CheckDigit(
    `${body}${firstCheckDigit}`,
    SECOND_CHECK_DIGIT_WEIGHTS,
  );

  if (digits !== `${body}${firstCheckDigit}${secondCheckDigit}`) {
    return { ok: false, reason: "cnpj-check-digits" };
  }

  return {
    ok: true,
    value: { taxIdentifier: trimmed, taxIdentifierNormalized: digits },
  };
}

/**
 * A non-CNPJ identifier is kept exactly as given and compared case- and punctuation-insensitively.
 * Nothing here claims the value was validated against any registry, and the persisted type
 * says so.
 */
function normalizeOtherIdentifier(
  trimmed: string,
): TaxIdentifierNormalizationResult {
  const normalized = trimmed.toUpperCase().replace(/[^0-9A-Z]/g, "");

  if (normalized.length === 0) {
    return { ok: false, reason: "no-comparable-characters" };
  }

  return {
    ok: true,
    value: { taxIdentifier: trimmed, taxIdentifierNormalized: normalized },
  };
}

/**
 * Modulus 11: sum the weighted digits, and the check digit is 0 when the remainder is below 2
 * and `11 - remainder` otherwise. Plain integer arithmetic on values far below 2^53, so there
 * is no float and nothing to round.
 */
function modulus11CheckDigit(
  digits: string,
  weights: readonly number[],
): number {
  let sum = 0;

  for (const [index, weight] of weights.entries()) {
    sum += Number(digits[index]) * weight;
  }

  const remainder = sum % 11;

  return remainder < 2 ? 0 : 11 - remainder;
}

import {
  CNPJ_DIGIT_COUNT,
  TAX_IDENTIFIER_MAXIMUM_LENGTH,
  normalizeTaxIdentifier,
} from "./tax-identifier";

/** Real, valid CNPJ check digits. Both spellings of the same identifier. */
const VALID_CNPJ_PUNCTUATED = "11.222.333/0001-81";
const VALID_CNPJ_DIGITS = "11222333000181";

function normalized(type: "CNPJ" | "OTHER", raw: string): string {
  const result = normalizeTaxIdentifier(type, raw);

  if (!result.ok) {
    throw new Error(`expected a normalized identifier, got ${result.reason}`);
  }

  return result.value.taxIdentifierNormalized;
}

function failure(type: "CNPJ" | "OTHER", raw: string): string {
  const result = normalizeTaxIdentifier(type, raw);

  if (result.ok) {
    throw new Error("expected a refusal");
  }

  return result.reason;
}

describe("CNPJ normalization and validation", () => {
  it("keeps what was typed and compares on the digits alone (FR-013)", () => {
    const result = normalizeTaxIdentifier("CNPJ", VALID_CNPJ_PUNCTUATED);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The original spelling survives so a person recognizes their own data...
      expect(result.value.taxIdentifier).toBe(VALID_CNPJ_PUNCTUATED);
      // ...and uniqueness is decided on the comparison form.
      expect(result.value.taxIdentifierNormalized).toBe(VALID_CNPJ_DIGITS);
      expect(result.value.taxIdentifierNormalized).toHaveLength(
        CNPJ_DIGIT_COUNT,
      );
    }
  });

  it("makes two spellings of one identifier collide on the normalized form", () => {
    // This is the whole point of storing both: registering "11.222.333/0001-81" and
    // "11222333000181" must not produce two suppliers.
    expect(normalized("CNPJ", VALID_CNPJ_PUNCTUATED)).toBe(
      normalized("CNPJ", VALID_CNPJ_DIGITS),
    );
    expect(normalized("CNPJ", `  ${VALID_CNPJ_PUNCTUATED}  `)).toBe(
      VALID_CNPJ_DIGITS,
    );
  });

  it("refuses invalid check digits rather than storing a plausible-looking number", () => {
    // Same body, last digit off by one. Structurally perfect and arithmetically wrong, which
    // is exactly the case a length check alone would let through.
    expect(failure("CNPJ", "11222333000182")).toBe("cnpj-check-digits");
    expect(failure("CNPJ", "11.222.333/0001-80")).toBe("cnpj-check-digits");
  });

  it("refuses a repeated-digit CNPJ even though the arithmetic accepts it", () => {
    // 00000000000000 and its siblings satisfy modulus 11. They are not CNPJs, and letting one
    // through is the kind of correctness that looks fine until an invoice is issued against it.
    for (let digit = 0; digit <= 9; digit += 1) {
      expect(failure("CNPJ", String(digit).repeat(CNPJ_DIGIT_COUNT))).toBe(
        "cnpj-check-digits",
      );
    }
  });

  it("refuses anything that is not 14 digits once punctuation is removed", () => {
    expect(failure("CNPJ", "1122233300018")).toBe("cnpj-malformed");
    expect(failure("CNPJ", "112223330001811")).toBe("cnpj-malformed");
    // A letter is not formatting: dropping it would change the identifier that was registered.
    expect(failure("CNPJ", "1122233300018A")).toBe("cnpj-malformed");
    expect(failure("CNPJ", "11 222 333 0001 81")).toBe("cnpj-malformed");
  });

  it("refuses a blank identifier", () => {
    expect(failure("CNPJ", "   ")).toBe("blank");
    expect(failure("OTHER", "")).toBe("blank");
  });

  it("refuses an identifier wider than the column stores", () => {
    const tooLong = "A".repeat(TAX_IDENTIFIER_MAXIMUM_LENGTH + 1);

    expect(failure("OTHER", tooLong)).toBe("too-long");
    expect(failure("CNPJ", tooLong)).toBe("too-long");
  });
});

describe("OTHER identifiers", () => {
  it("stores what was given and compares case- and punctuation-insensitively", () => {
    const result = normalizeTaxIdentifier("OTHER", " vat-gb 123.456 ");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.taxIdentifier).toBe("vat-gb 123.456");
      expect(result.value.taxIdentifierNormalized).toBe("VATGB123456");
    }
  });

  it("makes casing and punctuation differences collide", () => {
    expect(normalized("OTHER", "vat-gb-123")).toBe(
      normalized("OTHER", "VAT GB 123"),
    );
  });

  it("refuses an identifier with nothing comparable in it", () => {
    // "---" normalizes to the empty string, which would make every such supplier collide with
    // every other. Refused rather than stored as a shared empty key.
    expect(failure("OTHER", "---")).toBe("no-comparable-characters");
    expect(failure("OTHER", "/. -")).toBe("no-comparable-characters");
  });

  it("claims no national validation: a 14-digit OTHER value is accepted as given", () => {
    // The same digits that would fail as a CNPJ are perfectly acceptable as an unvalidated
    // internal identifier, because the *type* is what states what was checked.
    expect(failure("CNPJ", "11222333000182")).toBe("cnpj-check-digits");
    expect(normalized("OTHER", "11222333000182")).toBe("11222333000182");
  });

  it("keeps the two types in separate normalization rules but one uniqueness space", () => {
    // FR-013 is per organization and regardless of type: a CNPJ and an OTHER identifier that
    // normalize alike are the same supplier as far as the unique constraint is concerned, and
    // that is deliberate — one company should not be registerable twice by relabelling it.
    expect(normalized("OTHER", VALID_CNPJ_PUNCTUATED)).toBe(
      normalized("CNPJ", VALID_CNPJ_PUNCTUATED),
    );
  });
});

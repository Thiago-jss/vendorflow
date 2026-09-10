import {
  decodeSupplierQuoteCursor,
  encodeSupplierQuoteCursor,
} from "./supplier-quote.response";

const QUOTE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/**
 * FR-043 and NFR-004. The comparison's keyset cursor carries **both** ordering keys, and every
 * shape that is not both of them is refused rather than guessed at.
 *
 * The encoding is deliberately exercised as a round trip: a cursor that does not decode back
 * to the exact value it was built from is a cursor that silently skips or repeats a quote at
 * a page boundary.
 */
const encode = (value: string) =>
  Buffer.from(value, "utf8").toString("base64url");

describe("supplier quote comparison cursor", () => {
  it("round-trips the total and the quote identifier exactly", () => {
    const cursor = { totalCents: 699_875n, id: QUOTE_ID };

    expect(decodeSupplierQuoteCursor(encodeSupplierQuoteCursor(cursor))).toEqual(
      cursor,
    );
  });

  it("stays exact above Number.MAX_SAFE_INTEGER", () => {
    // 2^53 + 1 centavos. Through a JSON number this would come back as 9007199254740992 and
    // the resumed page would start at the wrong row.
    const cursor = { totalCents: 9_007_199_254_740_993n, id: QUOTE_ID };
    const decoded = decodeSupplierQuoteCursor(encodeSupplierQuoteCursor(cursor));

    expect(decoded?.totalCents).toBe(9_007_199_254_740_993n);
  });

  it("encodes a zero total, which is a real quote and not an absent cursor", () => {
    const cursor = { totalCents: 0n, id: QUOTE_ID };

    expect(decodeSupplierQuoteCursor(encodeSupplierQuoteCursor(cursor))).toEqual(
      cursor,
    );
  });

  it("refuses anything that is not both halves of a usable key", () => {
    for (const value of [
      "not-a-cursor",
      "",
      // No separator at all.
      encode(QUOTE_ID),
      // A total that is not a canonical non-negative integer.
      encode(`-1|${QUOTE_ID}`),
      encode(`01|${QUOTE_ID}`),
      encode(`1.5|${QUOTE_ID}`),
      encode(`|${QUOTE_ID}`),
      // An identifier the uuid column could never hold. Refused here rather than by the
      // driver, so a malformed cursor is a stated 400 and not a 500.
      encode("100000|nope"),
      encode("100000|"),
    ]) {
      expect(decodeSupplierQuoteCursor(value)).toBeNull();
    }
  });

  /**
   * `Buffer.from(value, "base64url")` skips characters outside the alphabet, tolerates `=`
   * padding and accepts trailing bits no encoder emits, so without a syntax check several
   * different strings would decode to one cursor. The contract is one cursor, one spelling.
   */
  describe("refuses every spelling but the canonical one", () => {
    const valid = encodeSupplierQuoteCursor({
      totalCents: 699_875n,
      id: QUOTE_ID,
    });

    it("refuses a character outside the base64url alphabet", () => {
      // `+` and `/` are base64's alphabet, not base64url's; `.` is neither.
      expect(decodeSupplierQuoteCursor(`${valid.slice(0, -1)}+`)).toBeNull();
      expect(decodeSupplierQuoteCursor(`${valid.slice(0, -1)}/`)).toBeNull();
      expect(decodeSupplierQuoteCursor(`${valid}.`)).toBeNull();
    });

    it("refuses a padded cursor", () => {
      expect(decodeSupplierQuoteCursor(`${valid}=`)).toBeNull();
      expect(decodeSupplierQuoteCursor(`${valid}==`)).toBeNull();
    });

    it("refuses leading, trailing and embedded whitespace", () => {
      expect(decodeSupplierQuoteCursor(` ${valid}`)).toBeNull();
      expect(decodeSupplierQuoteCursor(`${valid} `)).toBeNull();
      expect(decodeSupplierQuoteCursor(`${valid}\n`)).toBeNull();
      expect(
        decodeSupplierQuoteCursor(
          `${valid.slice(0, 4)} ${valid.slice(4)}`,
        ),
      ).toBeNull();
    });

    it("refuses a trailing-bit variant that decodes to the same payload", () => {
      const alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const payload = Buffer.from(valid, "base64url").toString("utf8");
      // The final character of an unpadded encoding carries bits the payload does not use, so
      // more than one character spells the same bytes. Only the one this API emits is a cursor.
      const variants = [...alphabet]
        .map((character) => `${valid.slice(0, -1)}${character}`)
        .filter(
          (candidate) =>
            candidate !== valid &&
            Buffer.from(candidate, "base64url").toString("utf8") === payload,
        );

      expect(variants.length).toBeGreaterThan(0);

      for (const variant of variants) {
        expect(decodeSupplierQuoteCursor(variant)).toBeNull();
      }
    });

    it("still accepts the cursor it actually issued", () => {
      expect(decodeSupplierQuoteCursor(valid)).toEqual({
        totalCents: 699_875n,
        id: QUOTE_ID,
      });
    });
  });

  it("refuses a total wider than the monetary column stores", () => {
    const beyondStorage = (9_223_372_036_854_775_807n + 1n).toString();

    expect(
      decodeSupplierQuoteCursor(
        Buffer.from(`${beyondStorage}|${QUOTE_ID}`, "utf8").toString(
          "base64url",
        ),
      ),
    ).toBeNull();
  });
});

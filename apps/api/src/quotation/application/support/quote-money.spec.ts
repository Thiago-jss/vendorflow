import { MAXIMUM_STORABLE_CENTS } from "../../../platform/numeric/centavos";
import {
  calculateQuoteLineTotalCents,
  calculateQuoteTotals,
} from "./quote-money";

function totals(input: Parameters<typeof calculateQuoteTotals>[0]) {
  const result = calculateQuoteTotals(input);

  if (!result.ok) {
    throw new Error(`expected totals, got ${result.reason}`);
  }

  return result.value;
}

function refusal(input: Parameters<typeof calculateQuoteTotals>[0]) {
  const result = calculateQuoteTotals(input);

  if (result.ok) {
    throw new Error("expected a refusal");
  }

  return result.reason;
}

describe("BR-033 line rounding", () => {
  it("rounds half-up at the centavo, exactly once, at the line", () => {
    // 1.5 units at 1 centavo is 1.5 centavos: half-up gives 2, not 1 and not 1.5.
    expect(
      calculateQuoteLineTotalCents({
        quantityScaled: 1_500n,
        unitPriceCents: 1n,
      }),
    ).toBe(2n);
  });

  it("rounds a value just below the half down and one just at it up", () => {
    // 1.499 x 1 = 1.499 centavos -> 1. 1.500 x 1 = 1.500 -> 2. The boundary is the whole rule.
    expect(
      calculateQuoteLineTotalCents({
        quantityScaled: 1_499n,
        unitPriceCents: 1n,
      }),
    ).toBe(1n);
    expect(
      calculateQuoteLineTotalCents({
        quantityScaled: 1_501n,
        unitPriceCents: 1n,
      }),
    ).toBe(2n);
  });

  it("never rounds the unit price, only the line", () => {
    // 3 units at 3333 centavos is exactly 9999; a rule that rounded the unit price first would
    // still get this right, so the case that distinguishes them is a fractional quantity.
    expect(
      calculateQuoteLineTotalCents({
        quantityScaled: 3_000n,
        unitPriceCents: 3_333n,
      }),
    ).toBe(9_999n);
    // 0.333 units at 100 centavos is 33.3 centavos -> 33. Rounding the price to 100 first and
    // then multiplying would give the same answer; rounding the quantity to 0 would not.
    expect(
      calculateQuoteLineTotalCents({
        quantityScaled: 333n,
        unitPriceCents: 100n,
      }),
    ).toBe(33n);
  });

  it("stays exact far above 2^53, where a double silently would not", () => {
    // 9,007,199,254,740,993 is the first integer a JavaScript number cannot represent.
    const beyondDouble = 9_007_199_254_740_993n;

    expect(
      calculateQuoteLineTotalCents({
        quantityScaled: 1_000n,
        unitPriceCents: beyondDouble,
      }),
    ).toBe(beyondDouble);
    // The collapse this avoids: as doubles, that value and the one below it are the same
    // number, so a total carried through a `number` would be silently off by a centavo.
    expect(Number(beyondDouble)).toBe(Number(beyondDouble - 1n));
  });

  it("handles a zero unit price without special-casing it (BR-012)", () => {
    expect(
      calculateQuoteLineTotalCents({
        quantityScaled: 1_234n,
        unitPriceCents: 0n,
      }),
    ).toBe(0n);
  });
});

describe("FR-042 quote totals", () => {
  it("sums the already-rounded line totals, so displayed lines add up to the total", () => {
    // Three lines of 1.5 centavos each. Rounded first: 2 + 2 + 2 = 6. Summed unrounded and
    // rounded once: 4.5 -> 5, a total no set of displayed lines adds up to.
    const result = totals({
      lines: [
        { quantityScaled: 1_500n, unitPriceCents: 1n },
        { quantityScaled: 1_500n, unitPriceCents: 1n },
        { quantityScaled: 1_500n, unitPriceCents: 1n },
      ],
      freightCents: 0n,
      discountCents: 0n,
    });

    expect(result.lineTotalsCents).toEqual([2n, 2n, 2n]);
    expect(result.itemsTotalCents).toBe(6n);
    expect(result.totalCents).toBe(6n);
  });

  it("adds freight and subtracts the discount", () => {
    const result = totals({
      lines: [{ quantityScaled: 2_000n, unitPriceCents: 50_000n }],
      freightCents: 12_500n,
      discountCents: 2_500n,
    });

    expect(result.itemsTotalCents).toBe(100_000n);
    expect(result.totalCents).toBe(110_000n);
  });

  it("keeps the line totals in the order the lines were given", () => {
    const result = totals({
      lines: [
        { quantityScaled: 1_000n, unitPriceCents: 100n },
        { quantityScaled: 2_000n, unitPriceCents: 100n },
        { quantityScaled: 3_000n, unitPriceCents: 100n },
      ],
      freightCents: 0n,
      discountCents: 0n,
    });

    expect(result.lineTotalsCents).toEqual([100n, 200n, 300n]);
  });

  it("allows a discount that brings the total to exactly zero", () => {
    const result = totals({
      lines: [{ quantityScaled: 1_000n, unitPriceCents: 1_000n }],
      freightCents: 0n,
      discountCents: 1_000n,
    });

    expect(result.totalCents).toBe(0n);
  });
});

describe("what a quote total refuses", () => {
  it("refuses a negative freight or discount", () => {
    expect(
      refusal({
        lines: [{ quantityScaled: 1_000n, unitPriceCents: 100n }],
        freightCents: -1n,
        discountCents: 0n,
      }),
    ).toBe("negative-freight");
    expect(
      refusal({
        lines: [{ quantityScaled: 1_000n, unitPriceCents: 100n }],
        freightCents: 0n,
        discountCents: -1n,
      }),
    ).toBe("negative-discount");
  });

  it("refuses a discount larger than the goods plus freight, rather than clamping it", () => {
    // A negative total would make a supplier owe the organization money, which is not a quote.
    expect(
      refusal({
        lines: [{ quantityScaled: 1_000n, unitPriceCents: 1_000n }],
        freightCents: 100n,
        discountCents: 1_101n,
      }),
    ).toBe("discount-exceeds-total");
  });

  it("refuses a goods subtotal wider than the column, before any discount hides it", () => {
    // Two lines that each fit and together do not. Checking only the final total would let a
    // large discount mask the overflow and store a number that was never computed correctly.
    expect(
      refusal({
        lines: [
          { quantityScaled: 1_000n, unitPriceCents: MAXIMUM_STORABLE_CENTS },
          { quantityScaled: 1_000n, unitPriceCents: 1n },
        ],
        freightCents: 0n,
        discountCents: MAXIMUM_STORABLE_CENTS,
      }),
    ).toBe("not-storable");
  });

  it("refuses freight that pushes an otherwise-storable subtotal over the limit", () => {
    expect(
      refusal({
        lines: [
          { quantityScaled: 1_000n, unitPriceCents: MAXIMUM_STORABLE_CENTS },
        ],
        freightCents: 1n,
        discountCents: 1n,
      }),
    ).toBe("not-storable");
  });

  it("accepts a total that lands exactly on the storable maximum", () => {
    // The bound is a storage width, not a business ceiling: the largest exactly storable
    // amount is a legitimate quote.
    const result = totals({
      lines: [
        { quantityScaled: 1_000n, unitPriceCents: MAXIMUM_STORABLE_CENTS },
      ],
      freightCents: 0n,
      discountCents: 0n,
    });

    expect(result.totalCents).toBe(MAXIMUM_STORABLE_CENTS);
  });
});

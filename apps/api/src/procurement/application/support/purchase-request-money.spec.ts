import { formatCents } from "../../../platform/numeric/centavos";
import { parseQuantity } from "../../../platform/numeric/scaled-quantity";
import {
  calculateEstimatedLineTotalCents,
  calculateEstimatedTotalCents,
} from "./purchase-request-money";

function quantity(value: string): bigint {
  const result = parseQuantity(value);

  if (!result.ok) {
    throw new Error(`expected ${value} to parse`);
  }

  return result.value;
}

function line(quantityValue: string, unitPriceCents: string) {
  return {
    quantityScaled: quantity(quantityValue),
    estimatedUnitPriceCents: BigInt(unitPriceCents),
  };
}

/**
 * BR-033's rounding itself is `platform/numeric/line-total`'s and is tested there. What is
 * tested here is the part procurement still owns: that an *estimated* line reaches that
 * primitive intact, and that a request total is the sum of already-rounded lines.
 */
describe("estimated line totals delegate to the exact half-up primitive", () => {
  it("multiplies an exact decimal quantity by an integer estimated unit price", () => {
    // R$ 19.99 x 3 = R$ 59.97, exactly.
    expect(calculateEstimatedLineTotalCents(line("3", "1999"))).toBe(5997n);
    expect(calculateEstimatedLineTotalCents(line("1.25", "1999"))).toBe(2499n);
    expect(calculateEstimatedLineTotalCents(line("0.5", "1"))).toBe(1n);
  });
});

describe("request total aggregation", () => {
  it("sums the already-rounded line totals", () => {
    expect(
      calculateEstimatedTotalCents([
        line("3", "1999"),
        line("10", "250"),
        line("1", "1"),
      ]),
    ).toBe(5997n + 2500n + 1n);
  });

  it("aggregates rounded lines rather than rounding an unrounded sum", () => {
    // Each line is 0.5 centavos and rounds up to 1, so the total is 2. Summing first would
    // give 1.0 and a total of 1 — a total no displayed line adds up to.
    const lines = [line("0.005", "100"), line("0.005", "100")];

    expect(calculateEstimatedLineTotalCents(lines[0]!)).toBe(1n);
    expect(calculateEstimatedTotalCents(lines)).toBe(2n);
  });

  it("returns zero for an empty line list", () => {
    expect(calculateEstimatedTotalCents([])).toBe(0n);
  });

  it("stays exact above Number.MAX_SAFE_INTEGER", () => {
    // 2^53 + 1 centavos. As a JSON number this becomes 9007199254740992.
    const beyondSafeInteger = "9007199254740993";
    const total = calculateEstimatedTotalCents([line("1", beyondSafeInteger)]);

    expect(total).toBe(9_007_199_254_740_993n);
    expect(formatCents(total)).toBe(beyondSafeInteger);
    expect(Number(total).toString()).not.toBe(beyondSafeInteger);
  });
});

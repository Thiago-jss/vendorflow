import { parseQuantity } from "./decimal-quantity";
import {
  MAXIMUM_STORABLE_CENTS,
  calculateEstimatedLineTotalCents,
  calculateEstimatedTotalCents,
  formatCents,
  isStorableCents,
  parseCents,
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

describe("centavo parsing", () => {
  it("accepts a canonical non-negative integer and rejects everything else", () => {
    expect(parseCents("0")).toEqual({ ok: true, value: 0n });
    expect(parseCents("549900")).toEqual({ ok: true, value: 549_900n });

    for (const value of ["-1", "1.5", "+1", "01", "1e3", "", " 1", "abc"]) {
      expect(parseCents(value)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("reports an amount larger than the storage width as such, not as malformed", () => {
    expect(parseCents((MAXIMUM_STORABLE_CENTS + 1n).toString())).toEqual({
      ok: false,
      reason: "not-storable",
    });
    expect(parseCents(MAXIMUM_STORABLE_CENTS.toString())).toEqual({
      ok: true,
      value: MAXIMUM_STORABLE_CENTS,
    });
    expect(isStorableCents(MAXIMUM_STORABLE_CENTS)).toBe(true);
    expect(isStorableCents(MAXIMUM_STORABLE_CENTS + 1n)).toBe(false);
  });
});

describe("line total computation", () => {
  it("multiplies an exact decimal quantity by an integer unit price", () => {
    // R$ 19.99 x 3 = R$ 59.97, exactly.
    expect(calculateEstimatedLineTotalCents(line("3", "1999"))).toBe(5997n);
    expect(calculateEstimatedLineTotalCents(line("4", "549900"))).toBe(
      2_199_600n,
    );
  });

  it("handles fractional quantities exactly when no rounding is needed", () => {
    expect(calculateEstimatedLineTotalCents(line("0.5", "1000"))).toBe(500n);
    expect(calculateEstimatedLineTotalCents(line("1.25", "800"))).toBe(1000n);
    expect(calculateEstimatedLineTotalCents(line("2.5", "1998"))).toBe(4995n);
  });

  it("rounds half-up at the centavo, once, at the line (BR-033)", () => {
    // 0.5 x 3 = 1.5 centavos -> 2
    expect(calculateEstimatedLineTotalCents(line("0.5", "3"))).toBe(2n);
    // 0.5 x 1 = 0.5 centavos -> 1: exactly half goes up, never to even.
    expect(calculateEstimatedLineTotalCents(line("0.5", "1"))).toBe(1n);
    // 1.25 x 1999 = 2498.75 -> 2499
    expect(calculateEstimatedLineTotalCents(line("1.25", "1999"))).toBe(2499n);
    // 0.333 x 100 = 33.3 -> 33: below half stays down.
    expect(calculateEstimatedLineTotalCents(line("0.333", "100"))).toBe(33n);
    // 0.335 x 100 = 33.5 -> 34
    expect(calculateEstimatedLineTotalCents(line("0.335", "100"))).toBe(34n);
    // 0.334 x 100 = 33.4 -> 33
    expect(calculateEstimatedLineTotalCents(line("0.334", "100"))).toBe(33n);
  });

  it("never rounds the unit price (BR-033)", () => {
    // 0.001 x 1 = 0.001 centavos. Rounding the price to the centavo first would make this 0
    // by a different route; here the single rounding step is at the line and gives 0.
    expect(calculateEstimatedLineTotalCents(line("0.001", "1"))).toBe(0n);
    // And 1000 of the same unit is the full centavo, proving the price was never truncated.
    expect(calculateEstimatedLineTotalCents(line("1000", "1"))).toBe(1000n);
  });

  it("treats a zero-priced line as valid and contributing nothing (BR-012)", () => {
    expect(calculateEstimatedLineTotalCents(line("7.5", "0"))).toBe(0n);
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

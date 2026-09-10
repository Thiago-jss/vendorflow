import { calculateLineTotalCents } from "./line-total";
import { parseQuantity } from "./scaled-quantity";

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
    unitPriceCents: BigInt(unitPriceCents),
  };
}

describe("BR-033 line total computation", () => {
  it("multiplies an exact decimal quantity by an integer unit price", () => {
    // R$ 19.99 x 3 = R$ 59.97, exactly.
    expect(calculateLineTotalCents(line("3", "1999"))).toBe(5997n);
    expect(calculateLineTotalCents(line("4", "549900"))).toBe(2_199_600n);
  });

  it("handles fractional quantities exactly when no rounding is needed", () => {
    expect(calculateLineTotalCents(line("0.5", "1000"))).toBe(500n);
    expect(calculateLineTotalCents(line("1.25", "800"))).toBe(1000n);
    expect(calculateLineTotalCents(line("2.5", "1998"))).toBe(4995n);
  });

  it("rounds half-up at the centavo, once, at the line (BR-033)", () => {
    // 0.5 x 3 = 1.5 centavos -> 2
    expect(calculateLineTotalCents(line("0.5", "3"))).toBe(2n);
    // 0.5 x 1 = 0.5 centavos -> 1: exactly half goes up, never to even.
    expect(calculateLineTotalCents(line("0.5", "1"))).toBe(1n);
    // 1.25 x 1999 = 2498.75 -> 2499
    expect(calculateLineTotalCents(line("1.25", "1999"))).toBe(2499n);
    // 0.333 x 100 = 33.3 -> 33: below half stays down.
    expect(calculateLineTotalCents(line("0.333", "100"))).toBe(33n);
    // 0.335 x 100 = 33.5 -> 34
    expect(calculateLineTotalCents(line("0.335", "100"))).toBe(34n);
    // 0.334 x 100 = 33.4 -> 33
    expect(calculateLineTotalCents(line("0.334", "100"))).toBe(33n);
  });

  it("never rounds the unit price (BR-033)", () => {
    // 0.001 x 1 = 0.001 centavos. Rounding the price to the centavo first would make this 0
    // by a different route; here the single rounding step is at the line and gives 0.
    expect(calculateLineTotalCents(line("0.001", "1"))).toBe(0n);
    // And 1000 of the same unit is the full centavo, proving the price was never truncated.
    expect(calculateLineTotalCents(line("1000", "1"))).toBe(1000n);
  });

  it("treats a zero-priced line as valid and contributing nothing (BR-012)", () => {
    expect(calculateLineTotalCents(line("7.5", "0"))).toBe(0n);
  });
});

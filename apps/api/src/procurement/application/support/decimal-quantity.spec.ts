import {
  MAXIMUM_SCALED_QUANTITY,
  QUANTITY_DECIMAL_PRECISION,
  QUANTITY_DECIMAL_SCALE,
  formatQuantity,
  parseQuantity,
} from "./decimal-quantity";

describe("exact decimal quantity", () => {
  function parsed(value: string): bigint {
    const result = parseQuantity(value);

    if (!result.ok) {
      throw new Error(`expected ${value} to parse`);
    }

    return result.value;
  }

  it("parses fractional quantities into exact thousandths", () => {
    expect(parsed("0.5")).toBe(500n);
    expect(parsed("1.25")).toBe(1250n);
    expect(parsed("4")).toBe(4000n);
    expect(parsed("0.001")).toBe(1n);
    expect(parsed("1.250")).toBe(1250n);
  });

  it("represents values a binary float cannot", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754. In thousandths it is simply 300.
    expect(parsed("0.1") + parsed("0.2")).toBe(parsed("0.3"));
    // 4.35 is stored as 4.3499999999999996 by a double; toFixed(2) on it yields "4.35" only
    // by luck of the rounding mode. There is no such value here.
    expect(parsed("4.35")).toBe(4350n);
  });

  it("stays exact at magnitudes a double cannot hold", () => {
    // Beyond Number.MAX_SAFE_INTEGER: a JSON number would lose the final digit.
    const huge = "9007199254740993.001";
    expect(formatQuantity(parsed(huge))).toBe(huge);
  });

  it("refuses more precision than the declared scale rather than rounding it away", () => {
    const result = parseQuantity("1.2345");

    expect(result).toEqual({
      ok: false,
      failure: { reason: "scale-exceeded" },
    });
    expect(QUANTITY_DECIMAL_SCALE).toBe(3);
  });

  it("accepts the largest quantity NUMERIC(20, 3) holds", () => {
    const largest = "99999999999999999.999";

    expect(parsed(largest)).toBe(MAXIMUM_SCALED_QUANTITY);
    expect(formatQuantity(MAXIMUM_SCALED_QUANTITY)).toBe(largest);
  });

  it("refuses a quantity one thousandth wider than the column, before any driver sees it", () => {
    // The next representable value up, and the round number just past it.
    for (const value of ["100000000000000000.000", "100000000000000000"]) {
      expect(parseQuantity(value)).toEqual({
        ok: false,
        failure: { reason: "not-storable" },
      });
    }
  });

  it("derives the maximum from the declared precision rather than a literal", () => {
    expect(QUANTITY_DECIMAL_PRECISION).toBe(20);
    expect(MAXIMUM_SCALED_QUANTITY).toBe(
      10n ** BigInt(QUANTITY_DECIMAL_PRECISION) - 1n,
    );
    // Precision counts every significant digit; scale says how many follow the point.
    expect(formatQuantity(MAXIMUM_SCALED_QUANTITY).replace(".", "")).toHaveLength(
      QUANTITY_DECIMAL_PRECISION,
    );
  });

  it("refuses a quantity of zero (BR-012)", () => {
    for (const value of ["0", "0.0", "0.000"]) {
      expect(parseQuantity(value)).toEqual({
        ok: false,
        failure: { reason: "not-positive" },
      });
    }
  });

  it("refuses anything that asks the parser to guess", () => {
    for (const value of [
      "-1",
      "+1",
      "1e3",
      "1E3",
      " 1",
      "1 ",
      "01.5",
      "1.",
      ".5",
      "1,5",
      "",
      "abc",
      "Infinity",
      "NaN",
    ]) {
      expect(parseQuantity(value).ok).toBe(false);
    }
  });

  it("formats at the declared scale so the kept precision is visible", () => {
    expect(formatQuantity(1250n)).toBe("1.250");
    expect(formatQuantity(4000n)).toBe("4.000");
    expect(formatQuantity(500n)).toBe("0.500");
    expect(formatQuantity(1n)).toBe("0.001");
  });

  it("round-trips every parsed value", () => {
    for (const value of ["0.001", "0.500", "1.000", "1.250", "999999.999"]) {
      expect(formatQuantity(parsed(value))).toBe(value);
    }
  });
});

import {
  PURCHASE_ORDER_NUMBER_MINIMUM_DIGITS,
  PURCHASE_ORDER_NUMBER_PATTERN,
  formatPurchaseOrderNumber,
} from "./purchase-order-number";

describe("FR-053 purchase order numbering", () => {
  it("formats the first allocation of an organization as PO-000001", () => {
    // The allocation returns 1, not 0 and not 2. Getting this wrong is invisible until someone
    // asks why their first purchase order is numbered two.
    expect(formatPurchaseOrderNumber(1n)).toBe("PO-000001");
  });

  it("counts up without gaps and keeps the padding", () => {
    expect(formatPurchaseOrderNumber(2n)).toBe("PO-000002");
    expect(formatPurchaseOrderNumber(42n)).toBe("PO-000042");
    expect(formatPurchaseOrderNumber(999_999n)).toBe("PO-999999");
  });

  it("gets longer rather than wrapping past the padded width", () => {
    // The padding is a minimum, not a ceiling. A format that silently stops being unique is
    // worse than one that gets longer, which is why the database CHECK says "six or more".
    expect(formatPurchaseOrderNumber(1_000_000n)).toBe("PO-1000000");
    expect(PURCHASE_ORDER_NUMBER_PATTERN.test("PO-1000000")).toBe(true);
  });

  it("stays exact far above 2^53, where a double silently would not", () => {
    const beyondDouble = 9_007_199_254_740_993n;

    expect(formatPurchaseOrderNumber(beyondDouble)).toBe("PO-9007199254740993");
    // The collapse this avoids: as doubles, that value and the one below it are one number.
    expect(Number(beyondDouble)).toBe(Number(beyondDouble - 1n));
  });

  it("produces exactly the shape the database CHECK enforces", () => {
    for (const value of [1n, 999_999n, 1_000_000n]) {
      expect(
        PURCHASE_ORDER_NUMBER_PATTERN.test(formatPurchaseOrderNumber(value)),
      ).toBe(true);
    }

    expect(PURCHASE_ORDER_NUMBER_PATTERN.test("PO-00001")).toBe(false);
    expect(PURCHASE_ORDER_NUMBER_PATTERN.test("PO-")).toBe(false);
    expect(PURCHASE_ORDER_NUMBER_PATTERN.test("000001")).toBe(false);
    expect(PURCHASE_ORDER_NUMBER_PATTERN.test("po-000001")).toBe(false);
  });

  it("refuses a sequence value below 1 instead of formatting a plausible identifier", () => {
    // Reaching here with 0 means the allocation is broken; a well-formed PO-000000 would hide
    // the bug behind something that looks like a real order.
    expect(() => formatPurchaseOrderNumber(0n)).toThrow();
    expect(() => formatPurchaseOrderNumber(-1n)).toThrow();
  });

  it("pads to the declared minimum width and no other", () => {
    expect(formatPurchaseOrderNumber(1n)).toHaveLength(
      "PO-".length + PURCHASE_ORDER_NUMBER_MINIMUM_DIGITS,
    );
  });
});

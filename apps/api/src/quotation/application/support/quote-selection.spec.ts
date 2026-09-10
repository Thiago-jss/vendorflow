import { SupplierQuoteValidationError } from "../contracts/quotation.errors";
import {
  MINIMUM_SELECTION_RATIONALE_LENGTH,
  SELECTION_RATIONALE_COLUMN_WIDTH,
  isQuoteStillValid,
  normalizeSelectionRationale,
} from "./quote-selection";

describe("FR-044 selection rationale", () => {
  it("requires at least ten non-whitespace characters", () => {
    expect(() => normalizeSelectionRationale("too short")).toThrow(
      SupplierQuoteValidationError,
    );
    expect(normalizeSelectionRationale("lowest bid")).toBe("lowest bid");
  });

  it("counts after trimming, so padding does not satisfy the rule", () => {
    // Ten spaces around a two-character reason is not a reason.
    expect(() => normalizeSelectionRationale("   ok     ")).toThrow(
      SupplierQuoteValidationError,
    );
    expect(() => normalizeSelectionRationale(" ".repeat(40))).toThrow(
      SupplierQuoteValidationError,
    );
  });

  it("stores the trimmed text rather than what the whitespace made it look like", () => {
    expect(normalizeSelectionRationale("  lowest total offered  ")).toBe(
      "lowest total offered",
    );
  });

  it("refuses text wider than the column instead of letting the driver fail", () => {
    expect(() =>
      normalizeSelectionRationale(
        "x".repeat(SELECTION_RATIONALE_COLUMN_WIDTH + 1),
      ),
    ).toThrow(SupplierQuoteValidationError);
    expect(() =>
      normalizeSelectionRationale("x".repeat(SELECTION_RATIONALE_COLUMN_WIDTH)),
    ).not.toThrow();
  });

  it("names the rule and never echoes the submitted text (SEC-009)", () => {
    try {
      normalizeSelectionRationale("secret");
      throw new Error("expected a refusal");
    } catch (error: unknown) {
      expect((error as Error).message).not.toContain("secret");
      expect((error as Error).message).toContain(
        String(MINIMUM_SELECTION_RATIONALE_LENGTH),
      );
    }
  });
});

describe("BR-023 validity, inclusive on the date", () => {
  const validUntil = new Date("2026-12-31T00:00:00.000Z");

  it("is selectable at any time on the validity date itself", () => {
    // A DATE column round-trips as midnight UTC. Comparing an instant to it directly would
    // expire a quote at the first moment of the day it is still valid on.
    expect(isQuoteStillValid(validUntil, new Date("2026-12-31T00:00:00.000Z"))).toBe(true);
    expect(isQuoteStillValid(validUntil, new Date("2026-12-31T23:59:59.999Z"))).toBe(true);
  });

  it("is selectable before the validity date", () => {
    expect(isQuoteStillValid(validUntil, new Date("2026-01-01T00:00:00.000Z"))).toBe(true);
  });

  it("is not selectable on the day after", () => {
    expect(isQuoteStillValid(validUntil, new Date("2027-01-01T00:00:00.000Z"))).toBe(false);
    expect(isQuoteStillValid(validUntil, new Date("2027-06-15T12:00:00.000Z"))).toBe(false);
  });
});

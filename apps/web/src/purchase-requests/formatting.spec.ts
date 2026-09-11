import { describe, expect, it } from "vitest";
import {
  UNAVAILABLE,
  formatCalendarDate,
  formatCents,
  formatQuantity,
  formatTimestamp,
  statusLabel
} from "./formatting";

describe("exact display formatting", () => {
  it("spells centavos without arithmetic", () => {
    expect(formatCents("0")).toBe("R$ 0,00");
    expect(formatCents("7")).toBe("R$ 0,07");
    expect(formatCents("99")).toBe("R$ 0,99");
    expect(formatCents("100")).toBe("R$ 1,00");
    expect(formatCents("687375")).toBe("R$ 6.873,75");
  });

  it("keeps an amount that no javascript number could hold", () => {
    expect(formatCents("9007199254740993")).toBe("R$ 90.071.992.547.409,93");
    expect(formatCents("9223372036854775807")).toBe(
      "R$ 92.233.720.368.547.758,07"
    );
  });

  it("keeps every decimal place of a quantity", () => {
    expect(formatQuantity("1.250")).toBe("1,250");
    expect(formatQuantity("0.001")).toBe("0,001");
    expect(formatQuantity("12345.678")).toBe("12.345,678");
    expect(formatQuantity("3")).toBe("3");
  });

  it("refuses to guess at a value that is not canonical", () => {
    expect(formatCents("1.5")).toBe(UNAVAILABLE);
    expect(formatCents("-1")).toBe(UNAVAILABLE);
    expect(formatCents("01")).toBe(UNAVAILABLE);
    expect(formatCents("1e3")).toBe(UNAVAILABLE);
    expect(formatQuantity("1.2345")).toBe(UNAVAILABLE);
    expect(formatQuantity(".5")).toBe(UNAVAILABLE);
    expect(formatCalendarDate("30/11/2026")).toBe(UNAVAILABLE);
    expect(formatTimestamp("not a date")).toBe(UNAVAILABLE);
    expect(formatTimestamp(null)).toBe(UNAVAILABLE);
  });

  it("shows a calendar day without applying a time zone", () => {
    expect(formatCalendarDate("2026-11-30")).toBe("30/11/2026");
  });

  it("names every status", () => {
    expect(statusLabel("DRAFT")).toBe("Rascunho");
    expect(statusLabel("IN_FINAL_APPROVAL")).toBe("Em aprovação final");
  });
});

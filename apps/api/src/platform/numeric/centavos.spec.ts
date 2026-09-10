import {
  MAXIMUM_STORABLE_CENTS,
  isStorableCents,
  parseCents,
} from "./centavos";

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

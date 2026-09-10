import { MAXIMUM_STORABLE_CENTS } from "../../../platform/numeric/centavos";
import { PurchaseRequestValidationError } from "../contracts/purchase-request.errors";
import {
  normalizePurchaseRequestDraft,
  type PurchaseRequestDraftInput,
} from "./purchase-request-draft";

describe("purchase request draft invariants", () => {
  function draft(
    overrides: Partial<PurchaseRequestDraftInput> = {},
  ): PurchaseRequestDraftInput {
    return {
      justification: "Replacement laptops for the onboarding cohort",
      neededBy: "2026-11-30",
      items: [
        {
          description: "Laptop, 16 GB RAM",
          unitOfMeasure: "UN",
          quantity: "4",
          estimatedUnitPriceCents: "549900",
        },
      ],
      ...overrides,
    };
  }

  it("computes the estimated total from the items and normalizes the date", () => {
    const normalized = normalizePurchaseRequestDraft(
      draft({
        items: [
          {
            description: "Laptop, 16 GB RAM",
            unitOfMeasure: "UN",
            quantity: "4",
            estimatedUnitPriceCents: "549900",
          },
          {
            description: "Docking station",
            unitOfMeasure: "UN",
            quantity: "4",
            estimatedUnitPriceCents: "89900",
          },
        ],
      }),
    );

    expect(normalized.estimatedTotalCents).toBe(4n * 549_900n + 4n * 89_900n);
    expect(normalized.neededBy.toISOString()).toBe("2026-11-30T00:00:00.000Z");
  });

  it("accepts fractional quantities and rounds each line once (BR-033)", () => {
    const normalized = normalizePurchaseRequestDraft(
      draft({
        items: [
          {
            description: "Copper cable",
            unitOfMeasure: "M",
            quantity: "1.25",
            estimatedUnitPriceCents: "1999",
          },
          {
            description: "Cleaning solution",
            unitOfMeasure: "L",
            quantity: "0.5",
            estimatedUnitPriceCents: "3",
          },
        ],
      }),
    );

    expect(normalized.items[0]?.quantityScaled).toBe(1250n);
    expect(normalized.items[1]?.quantityScaled).toBe(500n);
    // 2498.75 -> 2499 and 1.5 -> 2, summed after rounding.
    expect(normalized.estimatedTotalCents).toBe(2499n + 2n);
  });

  it("trims free text rather than storing padded values", () => {
    const normalized = normalizePurchaseRequestDraft(
      draft({
        justification: "  Office chairs  ",
        items: [
          {
            description: "  Ergonomic chair  ",
            unitOfMeasure: "  UN  ",
            quantity: "2",
            estimatedUnitPriceCents: "120000",
          },
        ],
      }),
    );

    expect(normalized.justification).toBe("Office chairs");
    expect(normalized.items[0]?.description).toBe("Ergonomic chair");
    expect(normalized.items[0]?.unitOfMeasure).toBe("UN");
  });

  it("requires a justification that is more than whitespace", () => {
    expect(() =>
      normalizePurchaseRequestDraft(draft({ justification: "   " })),
    ).toThrow(PurchaseRequestValidationError);
  });

  it("requires at least one item (BR-012)", () => {
    expect(() => normalizePurchaseRequestDraft(draft({ items: [] }))).toThrow(
      "A purchase request requires at least one item",
    );
  });

  it("imposes no maximum item count", () => {
    const items = Array.from({ length: 500 }, () => ({
      description: "Pen",
      unitOfMeasure: "UN",
      quantity: "1",
      estimatedUnitPriceCents: "100",
    }));

    expect(
      normalizePurchaseRequestDraft(draft({ items })).estimatedTotalCents,
    ).toBe(50_000n);
  });

  it("imposes no maximum quantity or unit price below the storage width", () => {
    const normalized = normalizePurchaseRequestDraft(
      draft({
        items: [
          {
            description: "Bulk order",
            unitOfMeasure: "UN",
            quantity: "1000000",
            estimatedUnitPriceCents: "100000000000",
          },
        ],
      }),
    );

    expect(normalized.estimatedTotalCents).toBe(1_000_000n * 100_000_000_000n);
    // Far beyond Number.MAX_SAFE_INTEGER, and exact.
    expect(normalized.estimatedTotalCents).toBeGreaterThan(
      BigInt(Number.MAX_SAFE_INTEGER),
    );
  });

  it("refuses a quantity of zero (BR-012)", () => {
    for (const quantity of ["0", "0.000"]) {
      expect(() =>
        normalizePurchaseRequestDraft(
          draft({
            items: [
              {
                description: "Pen",
                unitOfMeasure: "UN",
                quantity,
                estimatedUnitPriceCents: "100",
              },
            ],
          }),
        ),
      ).toThrow("An item quantity must be greater than zero");
    }
  });

  it("refuses a negative estimated unit price and accepts zero (BR-012)", () => {
    expect(() =>
      normalizePurchaseRequestDraft(
        draft({
          items: [
            {
              description: "Pen",
              unitOfMeasure: "UN",
              quantity: "1",
              estimatedUnitPriceCents: "-1",
            },
          ],
        }),
      ),
    ).toThrow(PurchaseRequestValidationError);

    expect(
      normalizePurchaseRequestDraft(
        draft({
          items: [
            {
              description: "Donated pen",
              unitOfMeasure: "UN",
              quantity: "1",
              estimatedUnitPriceCents: "0",
            },
          ],
        }),
      ).estimatedTotalCents,
    ).toBe(0n);
  });

  it("refuses more quantity precision than the declared scale", () => {
    expect(() =>
      normalizePurchaseRequestDraft(
        draft({
          items: [
            {
              description: "Cable",
              unitOfMeasure: "M",
              quantity: "2.5001",
              estimatedUnitPriceCents: "100",
            },
          ],
        }),
      ),
    ).toThrow("An item quantity may not have more than 3 decimal places");
  });

  it("refuses a fractional centavo and a quantity that is not a decimal", () => {
    expect(() =>
      normalizePurchaseRequestDraft(
        draft({
          items: [
            {
              description: "Cable",
              unitOfMeasure: "M",
              quantity: "2",
              estimatedUnitPriceCents: "100.5",
            },
          ],
        }),
      ),
    ).toThrow(
      "An item estimated unit price must be a whole number of centavos, such as 54990",
    );

    expect(() =>
      normalizePurchaseRequestDraft(
        draft({
          items: [
            {
              description: "Cable",
              unitOfMeasure: "M",
              quantity: "1e3",
              estimatedUnitPriceCents: "100",
            },
          ],
        }),
      ),
    ).toThrow("An item quantity must be a decimal number such as 1 or 1.25");
  });

  it("refuses an amount the database cannot store exactly", () => {
    expect(() =>
      normalizePurchaseRequestDraft(
        draft({
          items: [
            {
              description: "Absurd",
              unitOfMeasure: "UN",
              quantity: "1",
              estimatedUnitPriceCents: (MAXIMUM_STORABLE_CENTS + 1n).toString(),
            },
          ],
        }),
      ),
    ).toThrow(/largest amount this system stores exactly/);

    // Storable per line, but the sum overflows the column.
    expect(() =>
      normalizePurchaseRequestDraft(
        draft({
          items: [
            {
              description: "Absurd",
              unitOfMeasure: "UN",
              quantity: "1",
              estimatedUnitPriceCents: MAXIMUM_STORABLE_CENTS.toString(),
            },
            {
              description: "Absurd again",
              unitOfMeasure: "UN",
              quantity: "1",
              estimatedUnitPriceCents: "1",
            },
          ],
        }),
      ),
    ).toThrow(/largest amount this system stores exactly/);
  });

  it("refuses a quantity wider than the system stores, as a domain rule", () => {
    expect(() =>
      normalizePurchaseRequestDraft(
        draft({
          items: [
            {
              description: "Absurd quantity",
              unitOfMeasure: "UN",
              quantity: "100000000000000000.000",
              // Zero price, so the request total is 0 and the amount check cannot mask this.
              estimatedUnitPriceCents: "0",
            },
          ],
        }),
      ),
    ).toThrow(
      "An item quantity may not exceed 99999999999999999.999, the largest quantity this system stores exactly",
    );

    // One thousandth less is fine, so the boundary is exactly where the column puts it.
    expect(
      normalizePurchaseRequestDraft(
        draft({
          items: [
            {
              description: "Enormous but storable",
              unitOfMeasure: "UN",
              quantity: "99999999999999999.999",
              estimatedUnitPriceCents: "0",
            },
          ],
        }),
      ).items[0]?.quantityScaled,
    ).toBe(99_999_999_999_999_999_999n);
  });

  it("refuses a needed-by value that is not a real calendar date", () => {
    for (const neededBy of [
      "2026-02-30",
      "2026-13-01",
      "30-11-2026",
      "2026-11-30T00:00:00Z",
      "",
    ]) {
      expect(() => normalizePurchaseRequestDraft(draft({ neededBy }))).toThrow(
        "A needed-by date must be a calendar date formatted as YYYY-MM-DD",
      );
    }
  });

  it("accepts a leap day that exists and rejects one that does not", () => {
    expect(
      normalizePurchaseRequestDraft(
        draft({ neededBy: "2028-02-29" }),
      ).neededBy.toISOString(),
    ).toBe("2028-02-29T00:00:00.000Z");

    expect(() =>
      normalizePurchaseRequestDraft(draft({ neededBy: "2027-02-29" })),
    ).toThrow(PurchaseRequestValidationError);
  });
});

import { parseCalendarDate } from "../../../platform/calendar/calendar-date";
import {
  MAXIMUM_STORABLE_CENTS,
  isStorableCents,
  parseCents,
} from "../../../platform/numeric/centavos";
import {
  MAXIMUM_SCALED_QUANTITY,
  QUANTITY_DECIMAL_SCALE,
  formatQuantity,
  parseQuantity,
  type QuantityParseFailure,
  type ScaledQuantity,
} from "../../../platform/numeric/scaled-quantity";
import { PurchaseRequestValidationError } from "../contracts/purchase-request.errors";
import { calculateEstimatedTotalCents } from "./purchase-request-money";

/**
 * These are the widths of the `VARCHAR` columns the migration declares, restated so the
 * application can reject an over-long value with a useful message instead of a driver error.
 * They are storage limits, not product policy, and there is deliberately no limit on the
 * number of items, the quantity or the unit price: those caps existed in the first
 * implementation, were never in the requirements, and have been removed.
 */
const JUSTIFICATION_COLUMN_WIDTH = 2000;
const DESCRIPTION_COLUMN_WIDTH = 500;
const UNIT_OF_MEASURE_COLUMN_WIDTH = 20;

/** What a requester may state about a need. Nothing here is authority over anything else. */
export interface PurchaseRequestDraftItemInput {
  readonly description: string;
  readonly unitOfMeasure: string;
  /** Exact decimal, as a string. Never a JSON number: see `platform/numeric/scaled-quantity.ts`. */
  readonly quantity: string;
  /** Integer centavos, as a string. Never a JSON number: see `platform/numeric/centavos.ts`. */
  readonly estimatedUnitPriceCents: string;
}

export interface PurchaseRequestDraftInput {
  readonly justification: string;
  readonly neededBy: string;
  readonly items: readonly PurchaseRequestDraftItemInput[];
}

export interface NormalizedPurchaseRequestDraftItem {
  readonly description: string;
  readonly unitOfMeasure: string;
  readonly quantityScaled: ScaledQuantity;
  readonly estimatedUnitPriceCents: bigint;
}

export interface NormalizedPurchaseRequestDraft {
  readonly justification: string;
  readonly neededBy: Date;
  readonly items: readonly NormalizedPurchaseRequestDraftItem[];
  /** BR-032. Derived here and nowhere else; never read from the input. */
  readonly estimatedTotalCents: bigint;
}

/**
 * The single gate every write path goes through, expressed without HTTP, Nest or Prisma so
 * NFR-007 can prove it with a plain unit test. DTO validation covers the same ground at the
 * boundary (SEC-004); this exists because the rules must hold for any caller, not only for
 * one that arrived over HTTP.
 */
export function normalizePurchaseRequestDraft(
  input: PurchaseRequestDraftInput,
): NormalizedPurchaseRequestDraft {
  const justification = input.justification.trim();

  if (justification.length === 0) {
    throw new PurchaseRequestValidationError("A justification is required");
  }

  if (justification.length > JUSTIFICATION_COLUMN_WIDTH) {
    throw new PurchaseRequestValidationError(
      `A justification may not exceed ${JUSTIFICATION_COLUMN_WIDTH} characters`,
    );
  }

  const neededBy = parseCalendarDate(input.neededBy);

  if (neededBy === null) {
    throw new PurchaseRequestValidationError(
      "A needed-by date must be a calendar date formatted as YYYY-MM-DD",
    );
  }

  // BR-012. A request with no items has no need to state and no total to compute.
  if (input.items.length === 0) {
    throw new PurchaseRequestValidationError(
      "A purchase request requires at least one item",
    );
  }

  const items = input.items.map((item) => normalizeItem(item));
  const estimatedTotalCents = calculateEstimatedTotalCents(items);

  // The only ceiling left, and it is the width of the BIGINT column rather than a rule about
  // how much may be requested.
  if (!isStorableCents(estimatedTotalCents)) {
    throw new PurchaseRequestValidationError(
      `An estimated total may not exceed ${MAXIMUM_STORABLE_CENTS} centavos, the largest amount this system stores exactly`,
    );
  }

  return { justification, neededBy, items, estimatedTotalCents };
}

function normalizeItem(
  item: PurchaseRequestDraftItemInput,
): NormalizedPurchaseRequestDraftItem {
  const description = requireBoundedText(
    item.description,
    DESCRIPTION_COLUMN_WIDTH,
    "An item description",
  );
  const unitOfMeasure = requireBoundedText(
    item.unitOfMeasure,
    UNIT_OF_MEASURE_COLUMN_WIDTH,
    "An item unit of measure",
  );

  const quantity = parseQuantity(item.quantity);

  if (!quantity.ok) {
    throw new PurchaseRequestValidationError(
      describeQuantityFailure(quantity.failure),
    );
  }

  const unitPrice = parseCents(item.estimatedUnitPriceCents);

  if (!unitPrice.ok) {
    // BR-012 (estimated unit price ≥ 0): a zero-priced line is a legitimate expectation, so
    // only a negative, malformed or unstorable value is refused.
    throw new PurchaseRequestValidationError(
      unitPrice.reason === "not-storable"
        ? `An item estimated unit price may not exceed ${MAXIMUM_STORABLE_CENTS} centavos, the largest amount this system stores exactly`
        : "An item estimated unit price must be a whole number of centavos, such as 54990",
    );
  }

  return {
    description,
    unitOfMeasure,
    quantityScaled: quantity.value,
    estimatedUnitPriceCents: unitPrice.value,
  };
}

/**
 * Each failure gets its own sentence, so a caller can tell "not a number" from "more
 * precision than this system keeps" from "larger than this system stores" — three different
 * corrections. None of the messages names a column, a type or a driver.
 */
function describeQuantityFailure(failure: QuantityParseFailure): string {
  switch (failure.reason) {
    case "scale-exceeded":
      return `An item quantity may not have more than ${QUANTITY_DECIMAL_SCALE} decimal places`;
    case "not-positive":
      // BR-012.
      return "An item quantity must be greater than zero";
    case "not-storable":
      return `An item quantity may not exceed ${formatQuantity(MAXIMUM_SCALED_QUANTITY)}, the largest quantity this system stores exactly`;
    case "malformed":
      return "An item quantity must be a decimal number such as 1 or 1.25";
  }
}

function requireBoundedText(
  value: string,
  columnWidth: number,
  subject: string,
): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new PurchaseRequestValidationError(`${subject} is required`);
  }

  if (trimmed.length > columnWidth) {
    throw new PurchaseRequestValidationError(
      `${subject} may not exceed ${columnWidth} characters`,
    );
  }

  return trimmed;
}

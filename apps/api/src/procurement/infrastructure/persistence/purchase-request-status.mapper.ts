import { Prisma } from "@vendorflow/database";
import {
  QUANTITY_DECIMAL_SCALE,
  formatQuantity,
  parseQuantity,
  type ScaledQuantity,
} from "../../application/support/decimal-quantity";
import {
  purchaseRequestStatuses,
  type PurchaseRequestStatus,
} from "../../application/support/purchase-request-status";

/**
 * Persistence returns the PostgreSQL enum as a string. Narrowing it here, in one place,
 * means a state added to the database but not to the application contract fails loudly
 * instead of reaching the state machine as an unrecognized status.
 */
export function toPurchaseRequestStatus(status: string): PurchaseRequestStatus {
  const purchaseRequestStatus = purchaseRequestStatuses.find(
    (candidate) => candidate === status,
  );

  if (purchaseRequestStatus === undefined) {
    throw new Error("Persistence returned an unsupported purchase request status");
  }

  return purchaseRequestStatus;
}

/**
 * `quantity` is `NUMERIC(20, 3)`, which Prisma surfaces as a `Decimal`. The conversion to
 * the application's scaled `bigint` goes through the decimal's fixed-point *string*, never
 * through `toNumber()` and never through decimal multiplication: `toFixed` renders the exact
 * stored value, and the parser turns its digits into thousandths without arithmetic. A
 * binary float never holds the value at any point.
 */
export function toScaledQuantity(quantity: Prisma.Decimal): ScaledQuantity {
  const parsed = parseQuantity(quantity.toFixed(QUANTITY_DECIMAL_SCALE));

  if (!parsed.ok) {
    throw new Error("Persistence returned a quantity the domain cannot represent");
  }

  return parsed.value;
}

/**
 * The reverse. A fixed-point string is handed to Prisma rather than a `number`, so the
 * driver binds the exact decimal literal the domain computed.
 */
export function toDecimalQuantity(scaled: ScaledQuantity): Prisma.Decimal {
  return new Prisma.Decimal(formatQuantity(scaled));
}

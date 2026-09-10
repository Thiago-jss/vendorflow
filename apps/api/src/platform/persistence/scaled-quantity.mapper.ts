import { Prisma } from "@vendorflow/database";
import {
  QUANTITY_DECIMAL_SCALE,
  formatQuantity,
  parseQuantity,
  type ScaledQuantity,
} from "../numeric/scaled-quantity";

/**
 * The one conversion between PostgreSQL's `NUMERIC(20, 3)` and the application's exact scaled
 * `bigint`, in `platform` because three modules persist quantities and a conversion each of
 * them writes for itself is a conversion one of them will write with a `Number` in it.
 *
 * The representation itself stays where the domain defines it — `numeric/scaled-quantity.ts` — and
 * this file is only the driver-facing half of it.
 */

/**
 * Prisma surfaces `NUMERIC` as a `Decimal`. The conversion goes through the decimal's
 * fixed-point *string*, never through `toNumber()` and never through decimal multiplication:
 * `toFixed` renders the exact stored value, and the parser turns its digits into thousandths
 * without arithmetic. A binary float never holds the value at any point.
 */
export function toScaledQuantity(quantity: Prisma.Decimal): ScaledQuantity {
  const parsed = parseQuantity(quantity.toFixed(QUANTITY_DECIMAL_SCALE));

  if (!parsed.ok) {
    throw new Error("Persistence returned a quantity the domain cannot represent");
  }

  return parsed.value;
}

/**
 * The reverse. A fixed-point string is handed to Prisma rather than a `number`, so the driver
 * binds the exact decimal literal the domain computed.
 */
export function toDecimalQuantity(scaled: ScaledQuantity): Prisma.Decimal {
  return new Prisma.Decimal(formatQuantity(scaled));
}

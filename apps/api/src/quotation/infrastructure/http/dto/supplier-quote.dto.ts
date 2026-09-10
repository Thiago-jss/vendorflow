import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { CENTS_WIRE_PATTERN } from "../../../../platform/numeric/centavos";
import {
  MINIMUM_SELECTION_RATIONALE_LENGTH,
  SELECTION_RATIONALE_COLUMN_WIDTH,
} from "../../../application/support/quote-selection";
import {
  DEFAULT_SUPPLIER_QUOTE_PAGE_SIZE,
  MAXIMUM_SUPPLIER_QUOTE_PAGE_SIZE,
} from "../../../application/use-cases/list-supplier-quotes";

/**
 * A quote lead time longer than this is almost certainly a typo, and an unbounded integer is a
 * way to store one. Two years is generous for a purchasing lead time and still refuses 99999.
 */
export const MAXIMUM_DELIVERY_LEAD_TIME_DAYS = 730;

/**
 * SEC-004. What a client may say about one quoted line: which line, and what it costs.
 *
 * There is deliberately **no quantity and no line total**. A quote prices what the request
 * asked for; the quantity is read from the persisted PurchaseRequestItem and the line total is
 * computed (BR-025, BR-032). Sending either is a 400 rather than a value the server has to
 * remember to ignore, because the global `ValidationPipe` runs with `forbidNonWhitelisted`.
 */
export class RegisterSupplierQuoteLineDto {
  @ApiProperty({
    format: "uuid",
    description:
      "A line of *this* purchase request. An identifier from another request — or another tenant — is refused as not belonging to it, and nothing about it is disclosed.",
  })
  @IsUUID("4")
  purchaseRequestItemId!: string;

  @ApiProperty({
    description:
      "The supplier's unit price in integer centavos (BRL), as a string. Zero is allowed; a negative value is not.",
    example: "549900",
  })
  @IsString()
  @Matches(CENTS_WIRE_PATTERN)
  unitPriceCents!: string;
}

/**
 * FR-041. The quote itself.
 *
 * There is no `totalCents`, no `itemsTotalCents`, no `status`, no `supplierQuoteId` and no
 * `organizationId`: totals are computed (BR-032), the lifecycle is driven by named commands
 * (AUTHZ-005), and the tenant comes from the access token (MT-003).
 *
 * Amounts are **strings**, not JSON numbers. A JSON number is an IEEE-754 double in every
 * parser this API will meet, and a centavo amount above 2^53 does not survive one.
 */
export class RegisterSupplierQuoteDto {
  @ApiProperty({
    format: "uuid",
    description:
      "An active supplier of this organization (FR-040). An inactive one is refused with 409.",
  })
  @IsUUID("4")
  supplierId!: string;

  @ApiProperty({
    description: "Quote-level freight in integer centavos. Never negative.",
    example: "12500",
  })
  @IsString()
  @Matches(CENTS_WIRE_PATTERN)
  freightCents!: string;

  @ApiProperty({
    description:
      "Quote-level discount in integer centavos. Never negative, and never more than the goods plus freight.",
    example: "0",
  })
  @IsString()
  @Matches(CENTS_WIRE_PATTERN)
  discountCents!: string;

  @ApiProperty({
    format: "date",
    example: "2026-12-31",
    description:
      "BR-023, inclusive: the quote is selectable on this calendar day. The pattern bounds the shape; a value such as 2026-02-30 is refused with 422.",
  })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  validUntil!: string;

  @ApiProperty({
    minimum: 0,
    maximum: MAXIMUM_DELIVERY_LEAD_TIME_DAYS,
    description: "Whole days from order to delivery. Zero means same-day.",
    example: 15,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAXIMUM_DELIVERY_LEAD_TIME_DAYS)
  deliveryLeadTimeDays!: number;

  @ApiProperty({
    type: [RegisterSupplierQuoteLineDto],
    description:
      "BR-021. Exactly one entry per item of the request: no missing line, no duplicate, no foreign line. Enforced in the domain, by a composite foreign key, and again by a deferred constraint trigger at COMMIT.",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RegisterSupplierQuoteLineDto)
  lines!: RegisterSupplierQuoteLineDto[];
}

/** FR-044. Selection is required even when only one quote exists, and it must say why. */
export class SelectSupplierQuoteDto {
  @ApiProperty({
    minLength: MINIMUM_SELECTION_RATIONALE_LENGTH,
    maxLength: SELECTION_RATIONALE_COLUMN_WIDTH,
    description: `Why this supplier was chosen. At least ${MINIMUM_SELECTION_RATIONALE_LENGTH} non-whitespace characters. Recorded in the audit trail and deliberately never published to a broker.`,
    example: "Lowest total with the shortest lead time of the three offers",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(SELECTION_RATIONALE_COLUMN_WIDTH)
  selectionRationale!: string;
}

/**
 * FR-043 and NFR-004. There is no "all" option: the page size is bounded by the type, and a
 * value outside the range is a 400 rather than a silently clamped read.
 *
 * The bound is on the *page*, never on how many quotes a request may collect. A cap on
 * suppliers would make the comparison fit in one response by making the comparison wrong.
 */
export class ListSupplierQuotesQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAXIMUM_SUPPLIER_QUOTE_PAGE_SIZE,
    default: DEFAULT_SUPPLIER_QUOTE_PAGE_SIZE,
    description: "Page size. Bounded so no request can ask for an unbounded collection.",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAXIMUM_SUPPLIER_QUOTE_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({
    description:
      "Opaque keyset cursor, taken verbatim from a previous response's nextCursor. It encodes the last row's total and identifier; anything that does not decode to both is a 400.",
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import {
  purchaseOrderStatuses,
  type PurchaseOrderStatus,
} from "../../../application/contracts/purchase-order.repository";
import {
  CANCELLATION_REASON_COLUMN_WIDTH,
  MINIMUM_CANCELLATION_REASON_LENGTH,
} from "../../../application/support/purchase-order-cancellation";
import {
  DEFAULT_PURCHASE_ORDER_PAGE_SIZE,
  MAXIMUM_PURCHASE_ORDER_PAGE_SIZE,
} from "../../../application/use-cases/list-purchase-orders";

/**
 * SEC-004. One field.
 *
 * There is no supplier, no line list, no total, no number and no issuing actor: every one of
 * them is derived server-side from the approved request and its selected quote (FR-051,
 * BR-032, MT-003). The global `ValidationPipe` runs with `forbidNonWhitelisted`, so sending any
 * of them is a 400 rather than a value the server has to remember to ignore.
 */
export class IssuePurchaseOrderDto {
  @ApiProperty({
    format: "uuid",
    description:
      "An APPROVED purchase request of this organization with exactly one selected quote (FR-050).",
  })
  @IsUUID("4")
  purchaseRequestId!: string;
}

/** FR-054. Cancelling says why, in at least ten non-whitespace characters. */
export class CancelPurchaseOrderDto {
  @ApiProperty({
    minLength: MINIMUM_CANCELLATION_REASON_LENGTH,
    maxLength: CANCELLATION_REASON_COLUMN_WIDTH,
    description: `At least ${MINIMUM_CANCELLATION_REASON_LENGTH} non-whitespace characters. Recorded in the audit trail and deliberately never published to a broker.`,
    example: "Supplier withdrew after a plant fire; reordering elsewhere",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(CANCELLATION_REASON_COLUMN_WIDTH)
  reason!: string;
}

/** NFR-004. There is no "all" option: the page size is bounded by the type. */
export class ListPurchaseOrdersQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAXIMUM_PURCHASE_ORDER_PAGE_SIZE,
    default: DEFAULT_PURCHASE_ORDER_PAGE_SIZE,
    description: "Page size. Bounded so no request can ask for an unbounded collection.",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAXIMUM_PURCHASE_ORDER_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({
    description:
      "Opaque keyset cursor, taken verbatim from a previous response's nextCursor.",
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    enum: purchaseOrderStatuses,
    description: "Narrows to issued or cancelled orders. Omitted lists both.",
  })
  @IsOptional()
  @IsIn(purchaseOrderStatuses)
  status?: PurchaseOrderStatus;
}

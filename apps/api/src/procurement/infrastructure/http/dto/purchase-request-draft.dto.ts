import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator";
import {
  QUANTITY_DECIMAL_SCALE,
  QUANTITY_WIRE_PATTERN,
} from "../../../application/support/decimal-quantity";
import { CENTS_WIRE_PATTERN } from "../../../application/support/purchase-request-money";

/**
 * SEC-004. The global `ValidationPipe` runs with `whitelist` and `forbidNonWhitelisted`, so
 * a body carrying anything beyond these fields is rejected rather than trimmed. That is what
 * makes `organizationId`, `requesterId`, `departmentId`, `status`, `roles` and
 * `estimatedTotalCents` unsendable: they are not declared here, so supplying one is a 400
 * rather than a value the server has to remember to ignore (BR-032, MT-003).
 *
 * Quantities and amounts are **strings**, not JSON numbers. A JSON number is an IEEE-754
 * double in every parser this API will meet: it cannot hold 0.1 exactly, and it cannot hold
 * a centavo amount above 2^53 at all. Since the arbitrary caps of the first implementation
 * were removed, both cases are reachable, so the wire format is the exact decimal text.
 */
export class PurchaseRequestItemDto {
  @ApiProperty({ example: "Laptop, 16 GB RAM" })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description!: string;

  @ApiProperty({ example: "UN" })
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  unitOfMeasure!: string;

  @ApiProperty({
    description: `Exact decimal quantity as a string, with at most ${QUANTITY_DECIMAL_SCALE} decimal places. Must be greater than zero (BR-012).`,
    example: "1.250",
  })
  @IsString()
  @Matches(QUANTITY_WIRE_PATTERN)
  quantity!: string;

  @ApiProperty({
    description:
      "The requester's expected unit price in integer centavos (BRL), as a string. Zero is allowed (BR-012); this is never the purchase-order price (FR-021).",
    example: "549900",
  })
  @IsString()
  @Matches(CENTS_WIRE_PATTERN)
  estimatedUnitPriceCents!: string;
}

export class PurchaseRequestDraftDto {
  @ApiProperty({ example: "Replacement laptops for the onboarding cohort" })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  justification!: string;

  @ApiProperty({
    description:
      "Calendar day, not an instant. The pattern bounds the shape; the domain refuses a value such as 2026-02-30 with 422.",
    example: "2026-11-30",
  })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  neededBy!: string;

  @ApiProperty({
    type: [PurchaseRequestItemDto],
    description: "At least one item (BR-012). There is no maximum item count.",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseRequestItemDto)
  items!: PurchaseRequestItemDto[];
}

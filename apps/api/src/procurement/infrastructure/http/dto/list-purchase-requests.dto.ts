import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import {
  DEFAULT_PURCHASE_REQUEST_PAGE_SIZE,
  MAXIMUM_PURCHASE_REQUEST_PAGE_SIZE,
} from "../../../application/use-cases/list-own-purchase-requests";

/** NFR-004. There is no "all" option: the page size is bounded by the type. */
export class ListPurchaseRequestsQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAXIMUM_PURCHASE_REQUEST_PAGE_SIZE,
    default: DEFAULT_PURCHASE_REQUEST_PAGE_SIZE,
    description: "Page size. Bounded so no request can ask for an unbounded collection.",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAXIMUM_PURCHASE_REQUEST_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({
    description:
      "Opaque keyset cursor, taken verbatim from a previous response's nextCursor.",
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}

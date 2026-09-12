import { ApiProperty } from "@nestjs/swagger";
import { formatCalendarDate } from "../../../../platform/calendar/calendar-date";
import {
  QUANTITY_DECIMAL_SCALE,
  formatQuantity,
} from "../../../../platform/numeric/scaled-quantity";
import type { QuotationWorkPurchaseRequestRecord } from "../../../application/contracts/purchase-request.repository";

/**
 * FR-040/FR-041. A request line as a Buyer needs it to price one quote line: which line, and how
 * much of what. The requester's estimated prices are not part of it.
 */
export class PurchaseRequestQuotationWorkItemResponse {
  @ApiProperty({
    format: "uuid",
    description: "The purchaseRequestItemId a quote line must name.",
  })
  id!: string;

  @ApiProperty({
    description: "Server-assigned, 1-based. Clients never supply or reorder it.",
  })
  position!: number;

  @ApiProperty()
  description!: string;

  @ApiProperty()
  unitOfMeasure!: string;

  @ApiProperty({
    description: `Exact decimal, always rendered with ${QUANTITY_DECIMAL_SCALE} decimal places so the precision the system keeps is visible.`,
    example: "1.250",
  })
  quantity!: string;
}

/**
 * The Buyer's quotation work on one request, and deliberately nothing more: no status (it is
 * awaiting quotation, or it would be a 404), no justification, no estimates, no requester or
 * department, no approval history and no lifecycle timestamps.
 */
export class PurchaseRequestQuotationWorkResponse {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ format: "date", example: "2026-11-30" })
  neededBy!: string;

  @ApiProperty({
    type: [PurchaseRequestQuotationWorkItemResponse],
    description: "Every persisted item, ordered by position.",
  })
  items!: PurchaseRequestQuotationWorkItemResponse[];
}

export function toPurchaseRequestQuotationWorkResponse(
  record: QuotationWorkPurchaseRequestRecord,
): PurchaseRequestQuotationWorkResponse {
  return {
    id: record.id,
    neededBy: formatCalendarDate(record.neededBy),
    items: record.items.map((item) => ({
      id: item.id,
      position: item.position,
      description: item.description,
      unitOfMeasure: item.unitOfMeasure,
      quantity: formatQuantity(item.quantityScaled),
    })),
  };
}

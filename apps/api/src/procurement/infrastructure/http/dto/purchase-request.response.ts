import { ApiProperty } from "@nestjs/swagger";
import { formatCalendarDate } from "../../../../platform/calendar/calendar-date";
import { formatCents } from "../../../../platform/numeric/centavos";
import {
  QUANTITY_DECIMAL_SCALE,
  formatQuantity,
} from "../../../../platform/numeric/scaled-quantity";
import type { PurchaseRequestSupplements } from "../../../application/contracts/purchase-request-supplements";
import type { PurchaseRequestView } from "../../../application/contracts/purchase-request-view";
import type {
  PurchaseRequestPage,
  PurchaseRequestSummaryRecord,
} from "../../../application/contracts/purchase-request.repository";
import {
  purchaseRequestStatuses,
  type PurchaseRequestStatus,
} from "../../../application/support/purchase-request-status";
import {
  ApprovalFlowResponse,
  toApprovalFlowResponse,
} from "./purchase-request-approval.response";
import { encodePurchaseRequestCursor } from "./purchase-request-cursor";

/**
 * The wire contract, declared separately from the persistence record so a column added to
 * the schema does not silently become part of the API. These are classes rather than
 * interfaces because an interface leaves no runtime metadata, and the OpenAPI document is
 * generated from this metadata rather than transcribed by hand (NFR-009).
 *
 * Quantities and amounts leave as strings for the same reason they arrive as strings: a JSON
 * number is a binary double, and neither an exact decimal quantity nor a centavo amount
 * above 2^53 survives one.
 */
export class PurchaseRequestItemResponse {
  @ApiProperty({ format: "uuid" })
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

  @ApiProperty({ description: "Integer centavos (BRL).", example: "549900" })
  estimatedUnitPriceCents!: string;

  @ApiProperty({
    description:
      "quantity x estimatedUnitPriceCents, rounded half-up to the centavo exactly once at the line (BR-033).",
    example: "687375",
  })
  estimatedLineTotalCents!: string;
}

/**
 * FR-026, added additively in this phase. The winning quote, summarized.
 *
 * It is a summary and not the quote: the selection rationale, the priced lines and the
 * supplier's own details are reachable through the quotation routes, under that module's own
 * authorization. What a requester's view of their own request needs is which supplier won, at
 * what total, and by when it will arrive.
 */
export class SelectedQuoteSummaryResponse {
  @ApiProperty({ format: "uuid" })
  supplierQuoteId!: string;

  @ApiProperty({ format: "uuid" })
  supplierId!: string;

  @ApiProperty({ description: "Integer centavos (BRL).", example: "699875" })
  totalCents!: string;

  @ApiProperty({ format: "date", example: "2026-12-31" })
  validUntil!: string;

  @ApiProperty()
  deliveryLeadTimeDays!: number;

  @ApiProperty({ format: "date-time" })
  selectedAt!: string;
}

/** FR-026, added additively in this phase. The purchase order, summarized. */
export class PurchaseOrderSummaryResponse {
  @ApiProperty({ format: "uuid" })
  purchaseOrderId!: string;

  @ApiProperty({ example: "PO-000001" })
  number!: string;

  @ApiProperty({ enum: ["ISSUED", "CANCELLED"] })
  status!: "ISSUED" | "CANCELLED";

  @ApiProperty({ description: "Integer centavos (BRL).", example: "699875" })
  totalCents!: string;

  @ApiProperty({ format: "date-time" })
  issuedAt!: string;

  @ApiProperty({ format: "date-time", nullable: true, type: String })
  cancelledAt!: string | null;
}

export class PurchaseRequestResponse {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ enum: purchaseRequestStatuses })
  status!: PurchaseRequestStatus;

  @ApiProperty({
    format: "uuid",
    description: "Derived from the authenticated principal; never client input.",
  })
  requesterId!: string;

  @ApiProperty({
    format: "uuid",
    description:
      "The requester's department at creation time (BR-042). Later moves do not reassign it.",
  })
  departmentId!: string;

  @ApiProperty()
  justification!: string;

  @ApiProperty({ format: "date", example: "2026-11-30" })
  neededBy!: string;

  @ApiProperty({
    description:
      "Sum of the already-rounded line totals, in integer centavos. Computed by the backend (BR-032).",
    example: "687375",
  })
  estimatedTotalCents!: string;

  @ApiProperty({ format: "date-time", nullable: true, type: String })
  submittedAt!: string | null;

  @ApiProperty({ format: "date-time", nullable: true, type: String })
  cancelledAt!: string | null;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;

  @ApiProperty({ format: "date-time" })
  updatedAt!: string;

  @ApiProperty({ type: [PurchaseRequestItemResponse] })
  items!: PurchaseRequestItemResponse[];

  @ApiProperty({
    type: ApprovalFlowResponse,
    nullable: true,
    description:
      "FR-026. The approval flow materialized at submission: the step it is waiting on and the full ordered history. Null while the request is a DRAFT, which has no flow.",
  })
  approval!: ApprovalFlowResponse | null;

  @ApiProperty({
    type: SelectedQuoteSummaryResponse,
    nullable: true,
    description:
      "FR-026, added in this phase. The winning quote once one has been selected, and null before that. Existing clients that ignore it are unaffected.",
  })
  selectedQuote!: SelectedQuoteSummaryResponse | null;

  @ApiProperty({
    type: PurchaseOrderSummaryResponse,
    nullable: true,
    description:
      "FR-026, added in this phase. The purchase order once one has been issued, and null before that.",
  })
  purchaseOrder!: PurchaseOrderSummaryResponse | null;
}

/** A list row. The justification and the item lines stay out of a collection response. */
export class PurchaseRequestSummaryResponse {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ enum: purchaseRequestStatuses })
  status!: PurchaseRequestStatus;

  @ApiProperty({ format: "date", example: "2026-11-30" })
  neededBy!: string;

  @ApiProperty({ description: "Integer centavos (BRL).", example: "687375" })
  estimatedTotalCents!: string;

  @ApiProperty()
  itemCount!: number;

  @ApiProperty({ format: "date-time", nullable: true, type: String })
  submittedAt!: string | null;

  @ApiProperty({ format: "date-time", nullable: true, type: String })
  cancelledAt!: string | null;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;

  @ApiProperty({ format: "date-time" })
  updatedAt!: string;
}

export class PurchaseRequestPageResponse {
  @ApiProperty({ type: [PurchaseRequestSummaryResponse] })
  items!: PurchaseRequestSummaryResponse[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "Opaque keyset cursor for the next page, or null on the last page. There is no total count.",
  })
  nextCursor!: string | null;
}

export function toPurchaseRequestResponse(
  view: PurchaseRequestView,
): PurchaseRequestResponse {
  const record = view.request;

  return {
    id: record.id,
    status: record.status,
    requesterId: record.requesterId,
    departmentId: record.departmentId,
    justification: record.justification,
    neededBy: formatCalendarDate(record.neededBy),
    estimatedTotalCents: formatCents(record.estimatedTotalCents),
    submittedAt: record.submittedAt?.toISOString() ?? null,
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    items: record.items.map((item) => ({
      id: item.id,
      position: item.position,
      description: item.description,
      unitOfMeasure: item.unitOfMeasure,
      quantity: formatQuantity(item.quantityScaled),
      estimatedUnitPriceCents: formatCents(item.estimatedUnitPriceCents),
      estimatedLineTotalCents: formatCents(item.estimatedLineTotalCents),
    })),
    approval:
      view.approvalFlow === null
        ? null
        : toApprovalFlowResponse(view.approvalFlow),
    ...toSupplementResponses(view.supplements),
  };
}

/**
 * The two additive fields, built from whatever the inverted ports returned. Both are `null`
 * when the corresponding module is absent or has nothing yet, so the response shape is stable
 * whether or not quotation and ordering are wired in.
 */
function toSupplementResponses(supplements: PurchaseRequestSupplements): {
  selectedQuote: SelectedQuoteSummaryResponse | null;
  purchaseOrder: PurchaseOrderSummaryResponse | null;
} {
  const quote = supplements.selectedQuote;
  const order = supplements.purchaseOrder;

  return {
    selectedQuote:
      quote === null
        ? null
        : {
            supplierQuoteId: quote.supplierQuoteId,
            supplierId: quote.supplierId,
            totalCents: formatCents(quote.totalCents),
            validUntil: formatCalendarDate(quote.validUntil),
            deliveryLeadTimeDays: quote.deliveryLeadTimeDays,
            selectedAt: quote.selectedAt.toISOString(),
          },
    purchaseOrder:
      order === null
        ? null
        : {
            purchaseOrderId: order.purchaseOrderId,
            number: order.number,
            status: order.status,
            totalCents: formatCents(order.totalCents),
            issuedAt: order.issuedAt.toISOString(),
            cancelledAt: order.cancelledAt?.toISOString() ?? null,
          },
  };
}

export function toPurchaseRequestPageResponse(
  page: PurchaseRequestPage,
): PurchaseRequestPageResponse {
  return {
    items: page.items.map((summary) => toPurchaseRequestSummaryResponse(summary)),
    nextCursor:
      page.nextCursor === null
        ? null
        : encodePurchaseRequestCursor(page.nextCursor),
  };
}

export function toPurchaseRequestSummaryResponse(
  record: PurchaseRequestSummaryRecord,
): PurchaseRequestSummaryResponse {
  return {
    id: record.id,
    status: record.status,
    neededBy: formatCalendarDate(record.neededBy),
    estimatedTotalCents: formatCents(record.estimatedTotalCents),
    itemCount: record.itemCount,
    submittedAt: record.submittedAt?.toISOString() ?? null,
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

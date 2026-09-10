import { ApiProperty } from "@nestjs/swagger";
import { formatCents } from "../../../../platform/numeric/centavos";
import { formatQuantity } from "../../../../platform/numeric/scaled-quantity";
import {
  supplierTaxIdentifierTypes,
  type SupplierTaxIdentifierType,
} from "../../../../supplier/application/support/tax-identifier";
import {
  purchaseOrderStatuses,
  type PurchaseOrderListCursor,
  type PurchaseOrderPage,
  type PurchaseOrderRecord,
  type PurchaseOrderStatus,
} from "../../../application/contracts/purchase-order.repository";

const CURSOR_SEPARATOR = "|";

/**
 * The wire contract, declared separately from the persistence record so a column added to the
 * schema does not silently become part of the API.
 *
 * The supplier fields are the **snapshot**, not a live read: they are what the order was issued
 * against, and they do not change when the supplier record does (FR-051). That is why they are
 * named `supplierLegalName` and `supplierTaxIdentifier` here rather than nested under a
 * supplier object, which would suggest a relationship that is deliberately not maintained.
 *
 * Amounts and quantities leave as strings for the same reason they arrive as strings: a JSON
 * number is a binary double, and neither an exact decimal quantity nor a centavo amount above
 * 2^53 survives one.
 */
export class PurchaseOrderItemResponse {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty()
  position!: number;

  @ApiProperty()
  description!: string;

  @ApiProperty()
  unitOfMeasure!: string;

  @ApiProperty({ example: "1.250" })
  quantity!: string;

  @ApiProperty({ description: "Integer centavos (BRL).", example: "549900" })
  unitPriceCents!: string;

  @ApiProperty({ description: "Integer centavos (BRL).", example: "687375" })
  lineTotalCents!: string;
}

export class PurchaseOrderResponse {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({
    description: "FR-053. Unique within the organization.",
    example: "PO-000001",
  })
  number!: string;

  @ApiProperty({ enum: purchaseOrderStatuses })
  status!: PurchaseOrderStatus;

  @ApiProperty({ format: "uuid" })
  purchaseRequestId!: string;

  @ApiProperty({ format: "uuid" })
  supplierQuoteId!: string;

  @ApiProperty({ format: "uuid" })
  supplierId!: string;

  @ApiProperty({
    description:
      "Snapshotted at issuance. Later changes to the supplier record do not alter it (FR-051).",
  })
  supplierLegalName!: string;

  @ApiProperty({ description: "Snapshotted at issuance." })
  supplierTaxIdentifier!: string;

  @ApiProperty({ enum: supplierTaxIdentifierTypes })
  supplierTaxIdentifierType!: SupplierTaxIdentifierType;

  @ApiProperty({ description: "Integer centavos (BRL).", example: "12500" })
  freightCents!: string;

  @ApiProperty({ description: "Integer centavos (BRL).", example: "0" })
  discountCents!: string;

  @ApiProperty({ description: "Integer centavos (BRL).", example: "687375" })
  itemsTotalCents!: string;

  @ApiProperty({ description: "Integer centavos (BRL).", example: "699875" })
  totalCents!: string;

  @ApiProperty()
  deliveryLeadTimeDays!: number;

  @ApiProperty({ format: "uuid" })
  issuedById!: string;

  @ApiProperty({ format: "date-time" })
  issuedAt!: string;

  @ApiProperty({ format: "uuid", nullable: true, type: String })
  cancelledById!: string | null;

  @ApiProperty({ format: "date-time", nullable: true, type: String })
  cancelledAt!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      "FR-054. Present only on a cancelled order. Auditable text; never published to a broker.",
  })
  cancellationReason!: string | null;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;

  @ApiProperty({ format: "date-time" })
  updatedAt!: string;

  @ApiProperty({ type: [PurchaseOrderItemResponse] })
  items!: PurchaseOrderItemResponse[];
}

export class PurchaseOrderPageResponse {
  @ApiProperty({ type: [PurchaseOrderResponse] })
  items!: PurchaseOrderResponse[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "Opaque keyset cursor for the next page, or null on the last page. There is no total count.",
  })
  nextCursor!: string | null;
}

export function toPurchaseOrderResponse(
  record: PurchaseOrderRecord,
): PurchaseOrderResponse {
  return {
    id: record.id,
    number: record.number,
    status: record.status,
    purchaseRequestId: record.purchaseRequestId,
    supplierQuoteId: record.supplierQuoteId,
    supplierId: record.supplierId,
    supplierLegalName: record.supplierLegalName,
    supplierTaxIdentifier: record.supplierTaxIdentifier,
    supplierTaxIdentifierType: record.supplierTaxIdentifierType,
    freightCents: formatCents(record.freightCents),
    discountCents: formatCents(record.discountCents),
    itemsTotalCents: formatCents(record.itemsTotalCents),
    totalCents: formatCents(record.totalCents),
    deliveryLeadTimeDays: record.deliveryLeadTimeDays,
    issuedById: record.issuedById,
    issuedAt: record.issuedAt.toISOString(),
    cancelledById: record.cancelledById,
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
    cancellationReason: record.cancellationReason,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    items: record.items.map((item) => ({
      id: item.id,
      position: item.position,
      description: item.description,
      unitOfMeasure: item.unitOfMeasure,
      quantity: formatQuantity(item.quantityScaled),
      unitPriceCents: formatCents(item.unitPriceCents),
      lineTotalCents: formatCents(item.lineTotalCents),
    })),
  };
}

export function toPurchaseOrderPageResponse(
  page: PurchaseOrderPage,
): PurchaseOrderPageResponse {
  return {
    items: page.items.map((item) => toPurchaseOrderResponse(item)),
    nextCursor:
      page.nextCursor === null
        ? null
        : encodePurchaseOrderCursor(page.nextCursor),
  };
}

/**
 * The cursor is the last row's ordering key, base64url-encoded so clients treat it as opaque.
 * It is not signed: it carries no secret, both halves came from the same response, and the
 * query that consumes it is tenant-scoped, so a forged cursor can only move a caller around
 * inside their own organization's rows (ADR-002).
 */
export function encodePurchaseOrderCursor(
  cursor: PurchaseOrderListCursor,
): string {
  return Buffer.from(
    `${cursor.issuedAt.toISOString()}${CURSOR_SEPARATOR}${cursor.id}`,
    "utf8",
  ).toString("base64url");
}

export function decodePurchaseOrderCursor(
  value: string,
): PurchaseOrderListCursor | null {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  const separator = decoded.indexOf(CURSOR_SEPARATOR);

  if (separator === -1) {
    return null;
  }

  const issuedAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (Number.isNaN(issuedAt.getTime()) || id.length === 0) {
    return null;
  }

  return { issuedAt, id };
}

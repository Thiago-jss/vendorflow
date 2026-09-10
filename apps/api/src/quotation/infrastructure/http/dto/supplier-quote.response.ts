import { ApiProperty } from "@nestjs/swagger";
import { formatCalendarDate } from "../../../../platform/calendar/calendar-date";
import {
  formatCents,
  parseCents,
} from "../../../../platform/numeric/centavos";
import { formatQuantity } from "../../../../platform/numeric/scaled-quantity";
import {
  supplierQuoteStatuses,
  type SupplierQuoteListCursor,
  type SupplierQuotePage,
  type SupplierQuoteRecord,
  type SupplierQuoteStatus,
} from "../../../application/contracts/supplier-quote.repository";
import type { SelectedSupplierQuoteResult } from "../../../application/use-cases/select-supplier-quote";

const CURSOR_SEPARATOR = "|";

/** The `uuid` shape the quote identifier column actually holds. */
const CURSOR_IDENTIFIER_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Canonical unpadded base64url, and nothing else. `Buffer.from(value, "base64url")` is
 * deliberately forgiving — it skips characters outside the alphabet, tolerates `=` padding and
 * accepts trailing bits that no encoder would ever emit — so several different strings decode
 * to the same cursor. The wire contract is that one cursor has one spelling, which means the
 * shape has to be checked before the decoder is allowed to guess.
 */
const CURSOR_BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * The wire contract, declared separately from the persistence record so a column added to the
 * schema does not silently become part of the API.
 *
 * Amounts and quantities leave as strings for the same reason they arrive as strings: a JSON
 * number is a binary double, and neither an exact decimal quantity nor a centavo amount above
 * 2^53 survives one.
 *
 * `selectionRationale` is present on the detail shape because the Buyer who wrote it and the
 * approvers who act on the selection need to read it. It is never put in a broker payload and
 * never logged.
 */
export class SupplierQuoteItemResponse {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ format: "uuid", description: "The request line this prices." })
  purchaseRequestItemId!: string;

  @ApiProperty({ description: "Copied from the request line's own position." })
  position!: number;

  @ApiProperty({
    description:
      "Copied from the persisted request line. A quote prices what was asked for; it never restates the quantity (BR-025).",
    example: "1.250",
  })
  quantity!: string;

  @ApiProperty({ description: "Integer centavos (BRL).", example: "549900" })
  unitPriceCents!: string;

  @ApiProperty({
    description:
      "quantity x unitPriceCents, rounded half-up to the centavo exactly once at the line (BR-033).",
    example: "687375",
  })
  lineTotalCents!: string;
}

export class SupplierQuoteResponse {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ format: "uuid" })
  purchaseRequestId!: string;

  @ApiProperty({ format: "uuid" })
  supplierId!: string;

  @ApiProperty({
    enum: supplierQuoteStatuses,
    description:
      "ACTIVE is a live offer; WITHDRAWN stays visible in the comparison and cannot be selected (FR-046); SELECTED is the single winner (BR-024).",
  })
  status!: SupplierQuoteStatus;

  @ApiProperty({ description: "Integer centavos (BRL).", example: "12500" })
  freightCents!: string;

  @ApiProperty({ description: "Integer centavos (BRL).", example: "0" })
  discountCents!: string;

  @ApiProperty({
    description: "Sum of the already-rounded line totals, in integer centavos.",
    example: "687375",
  })
  itemsTotalCents!: string;

  @ApiProperty({
    description:
      "itemsTotalCents + freightCents - discountCents (FR-042). Computed by the backend and never accepted from a client (BR-032).",
    example: "699875",
  })
  totalCents!: string;

  @ApiProperty({ description: "How many request lines this quote prices (BR-021)." })
  itemCount!: number;

  @ApiProperty({ format: "date", example: "2026-12-31" })
  validUntil!: string;

  @ApiProperty()
  deliveryLeadTimeDays!: number;

  @ApiProperty({ format: "uuid" })
  registeredById!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      "FR-044. Present only on the selected quote. Auditable text; never published to a broker.",
  })
  selectionRationale!: string | null;

  @ApiProperty({ format: "uuid", nullable: true, type: String })
  selectedById!: string | null;

  @ApiProperty({ format: "date-time", nullable: true, type: String })
  selectedAt!: string | null;

  @ApiProperty({ format: "date-time", nullable: true, type: String })
  withdrawnAt!: string | null;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;

  @ApiProperty({ format: "date-time" })
  updatedAt!: string;

  @ApiProperty({ type: [SupplierQuoteItemResponse] })
  items!: SupplierQuoteItemResponse[];
}

/** FR-043. The comparison: one bounded page of a request's quotes, cheapest first. */
export class SupplierQuoteListResponse {
  @ApiProperty({
    type: [SupplierQuoteResponse],
    description:
      "Ordered by total ascending, then by quote identifier ascending so equal totals have a stable order. Withdrawn quotes are included so the comparison can explain the decision that followed it.",
  })
  items!: SupplierQuoteResponse[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "Opaque keyset cursor for the next page, or null on the last page. There is no total count.",
  })
  nextCursor!: string | null;
}

/** FR-045. What selecting a quote did to the request and to the approval ladder. */
export class SelectSupplierQuoteResponse {
  @ApiProperty({ type: SupplierQuoteResponse })
  quote!: SupplierQuoteResponse;

  @ApiProperty({
    enum: ["IN_FINAL_APPROVAL", "APPROVED"],
    description:
      "Decided by BR-003's re-evaluation against the selected quote total, never by the client. APPROVED when no post-quotation approval remains.",
  })
  purchaseRequestStatus!: "IN_FINAL_APPROVAL" | "APPROVED";

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      "The approval responsibility now waiting, or null when the ladder is finished.",
  })
  actionableStepRole!: string | null;
}

export function toSupplierQuoteResponse(
  record: SupplierQuoteRecord,
): SupplierQuoteResponse {
  return {
    id: record.id,
    purchaseRequestId: record.purchaseRequestId,
    supplierId: record.supplierId,
    status: record.status,
    freightCents: formatCents(record.freightCents),
    discountCents: formatCents(record.discountCents),
    itemsTotalCents: formatCents(record.itemsTotalCents),
    totalCents: formatCents(record.totalCents),
    itemCount: record.itemCount,
    validUntil: formatCalendarDate(record.validUntil),
    deliveryLeadTimeDays: record.deliveryLeadTimeDays,
    registeredById: record.registeredById,
    selectionRationale: record.selectionRationale,
    selectedById: record.selectedById,
    selectedAt: record.selectedAt?.toISOString() ?? null,
    withdrawnAt: record.withdrawnAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    items: record.items.map((item) => ({
      id: item.id,
      purchaseRequestItemId: item.purchaseRequestItemId,
      position: item.position,
      quantity: formatQuantity(item.quantityScaled),
      unitPriceCents: formatCents(item.unitPriceCents),
      lineTotalCents: formatCents(item.lineTotalCents),
    })),
  };
}

export function toSupplierQuoteListResponse(
  page: SupplierQuotePage,
): SupplierQuoteListResponse {
  return {
    items: page.items.map((record) => toSupplierQuoteResponse(record)),
    nextCursor:
      page.nextCursor === null
        ? null
        : encodeSupplierQuoteCursor(page.nextCursor),
  };
}

/**
 * The cursor is the last row's ordering key — the total and the identifier — base64url-encoded
 * so clients treat it as opaque.
 *
 * It is not signed: it carries no secret, both halves came from the same response, and the
 * query that consumes it is scoped to one tenant *and* one purchase request, so a forged
 * cursor can only move a caller around inside a comparison they were already allowed to read
 * (ADR-002).
 *
 * The total is written with `formatCents` rather than as a JSON number for the same reason it
 * leaves that way on the wire: a total above 2^53 does not survive an IEEE-754 double, and a
 * cursor that loses precision is a cursor that skips rows.
 */
export function encodeSupplierQuoteCursor(
  cursor: SupplierQuoteListCursor,
): string {
  return Buffer.from(
    `${formatCents(cursor.totalCents)}${CURSOR_SEPARATOR}${cursor.id}`,
    "utf8",
  ).toString("base64url");
}

/**
 * Returns `null` for anything that is not both halves of a usable key, which the controller
 * turns into a 400. Every rejected shape is rejected deliberately: an empty value, a value
 * outside the canonical unpadded base64url alphabet, a value whose encoding is not the one
 * this API would have produced, a decoded value with no separator, a total that is not a
 * canonical non-negative storable integer, and an identifier that is not a UUID. The last one
 * matters most — `id` reaches a `uuid` column, and letting arbitrary text through would answer
 * a malformed cursor with a driver error instead of a stated refusal.
 *
 * The syntax is checked first and the round trip second, so the decoder never gets to smooth
 * over input the contract does not admit. Padding, whitespace, an out-of-alphabet character
 * and a trailing-bit variant of a real cursor are all refusals rather than an equivalent
 * cursor quietly accepted under a second spelling.
 */
export function decodeSupplierQuoteCursor(
  value: string,
): SupplierQuoteListCursor | null {
  if (!CURSOR_BASE64URL_PATTERN.test(value)) {
    return null;
  }

  const decoded = Buffer.from(value, "base64url").toString("utf8");

  // The one spelling test. Re-encoding what was decoded reproduces the caller's string only
  // when that string is exactly what this API emits, which rules out both a trailing-bit
  // variant and a payload that was not valid UTF-8 to begin with.
  if (Buffer.from(decoded, "utf8").toString("base64url") !== value) {
    return null;
  }

  const separator = decoded.indexOf(CURSOR_SEPARATOR);

  if (separator === -1) {
    return null;
  }

  const totalCents = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);

  if (!CURSOR_IDENTIFIER_PATTERN.test(id)) {
    return null;
  }

  const parsed = parseCents(totalCents);

  return parsed.ok ? { totalCents: parsed.value, id } : null;
}

export function toSelectSupplierQuoteResponse(
  result: SelectedSupplierQuoteResult,
): SelectSupplierQuoteResponse {
  return {
    quote: toSupplierQuoteResponse(result.quote),
    purchaseRequestStatus: result.resultingStatus,
    actionableStepRole: result.actionableStepRole,
  };
}

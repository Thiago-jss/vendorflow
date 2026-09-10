import { ApiProperty } from "@nestjs/swagger";
import type {
  SupplierListCursor,
  SupplierPage,
  SupplierRecord,
} from "../../../application/contracts/supplier.repository";
import {
  supplierTaxIdentifierTypes,
  type SupplierTaxIdentifierType,
} from "../../../application/support/tax-identifier";

const CURSOR_SEPARATOR = "|";

/**
 * The wire contract, declared separately from the persistence record so a column added to the
 * schema does not silently become part of the API.
 *
 * `taxIdentifierNormalized` is deliberately **not** exposed. It is an internal comparison key
 * whose only purpose is uniqueness; publishing it would invite clients to treat it as the
 * identifier and to build their own matching on it.
 */
export class SupplierResponse {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty()
  legalName!: string;

  @ApiProperty()
  tradeName!: string;

  @ApiProperty({ enum: supplierTaxIdentifierTypes })
  taxIdentifierType!: SupplierTaxIdentifierType;

  @ApiProperty({
    description:
      "As registered. CNPJ values were check-digit validated; OTHER values were not validated against any registry.",
  })
  taxIdentifier!: string;

  @ApiProperty()
  contactEmail!: string;

  @ApiProperty()
  contactPhone!: string;

  @ApiProperty({
    description:
      "FR-012. An inactive supplier cannot receive a newly registered quote, and stays attached to every quote and purchase order it already has.",
  })
  isActive!: boolean;

  @ApiProperty({ format: "date-time", nullable: true, type: String })
  deactivatedAt!: string | null;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;

  @ApiProperty({ format: "date-time" })
  updatedAt!: string;
}

export class SupplierPageResponse {
  @ApiProperty({ type: [SupplierResponse] })
  items!: SupplierResponse[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "Opaque keyset cursor for the next page, or null on the last page. There is no total count.",
  })
  nextCursor!: string | null;
}

export function toSupplierResponse(record: SupplierRecord): SupplierResponse {
  return {
    id: record.id,
    legalName: record.legalName,
    tradeName: record.tradeName,
    taxIdentifierType: record.taxIdentifierType,
    taxIdentifier: record.taxIdentifier,
    contactEmail: record.contactEmail,
    contactPhone: record.contactPhone,
    isActive: record.isActive,
    deactivatedAt: record.deactivatedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toSupplierPageResponse(page: SupplierPage): SupplierPageResponse {
  return {
    items: page.items.map((item) => toSupplierResponse(item)),
    nextCursor:
      page.nextCursor === null ? null : encodeSupplierCursor(page.nextCursor),
  };
}

/**
 * The cursor is the last row's ordering key, base64url-encoded so clients treat it as opaque.
 * It is not signed: it carries no secret, both halves came from the same response, and the
 * query that consumes it is tenant-scoped, so a forged cursor can only move a caller around
 * inside their own organization's rows (ADR-002).
 */
export function encodeSupplierCursor(cursor: SupplierListCursor): string {
  return Buffer.from(
    `${cursor.createdAt.toISOString()}${CURSOR_SEPARATOR}${cursor.id}`,
    "utf8",
  ).toString("base64url");
}

export function decodeSupplierCursor(value: string): SupplierListCursor | null {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  const separator = decoded.indexOf(CURSOR_SEPARATOR);

  if (separator === -1) {
    return null;
  }

  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  if (Number.isNaN(createdAt.getTime()) || id.length === 0) {
    return null;
  }

  return { createdAt, id };
}

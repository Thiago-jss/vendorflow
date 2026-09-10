import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import {
  supplierTaxIdentifierTypes,
  TAX_IDENTIFIER_MAXIMUM_LENGTH,
  type SupplierTaxIdentifierType,
} from "../../../application/support/tax-identifier";
import {
  DEFAULT_SUPPLIER_PAGE_SIZE,
  MAXIMUM_SUPPLIER_PAGE_SIZE,
} from "../../../application/use-cases/list-suppliers";

/**
 * SEC-004. A closed world of six fields.
 *
 * There is no `organizationId`, no `isActive`, no `id` and no `deactivatedAt`: the tenant
 * comes from the access token (MT-003), a new supplier is active by definition, and
 * deactivation is a named command with its own route rather than a writable field. The global
 * `ValidationPipe` runs with `forbidNonWhitelisted`, so sending any of them is a 400 rather
 * than a value the server has to remember to ignore.
 *
 * The identifier's *shape* is bounded here; whether a CNPJ's check digits are valid is a
 * domain rule and answers 422 — a 13-digit string is a perfectly well-formed string.
 */
export class RegisterSupplierDto {
  @ApiProperty({ maxLength: 200, example: "Papelaria Central Ltda" })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  legalName!: string;

  @ApiProperty({ maxLength: 200, example: "Papelaria Central" })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  tradeName!: string;

  @ApiProperty({
    enum: supplierTaxIdentifierTypes,
    description:
      "Declared, never inferred from the value. CNPJ is normalized to its 14 digits and its check digits are verified; OTHER is stored faithfully and no national validation is claimed.",
  })
  @IsIn(supplierTaxIdentifierTypes)
  taxIdentifierType!: SupplierTaxIdentifierType;

  @ApiProperty({
    maxLength: TAX_IDENTIFIER_MAXIMUM_LENGTH,
    example: "11.222.333/0001-81",
    description:
      "Unique within the organization once normalized, regardless of type (FR-013).",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(TAX_IDENTIFIER_MAXIMUM_LENGTH)
  taxIdentifier!: string;

  @ApiProperty({ maxLength: 320, example: "contato@example.com" })
  @IsEmail()
  @MaxLength(320)
  contactEmail!: string;

  @ApiProperty({ maxLength: 40, example: "+55 11 4002-8922" })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  @Matches(/^[0-9+()\-. ]+$/, {
    message: "contactPhone may contain only digits and phone punctuation",
  })
  contactPhone!: string;
}

/** NFR-004. There is no "all" option: the page size is bounded by the type. */
export class ListSuppliersQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAXIMUM_SUPPLIER_PAGE_SIZE,
    default: DEFAULT_SUPPLIER_PAGE_SIZE,
    description: "Page size. Bounded so no request can ask for an unbounded collection.",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAXIMUM_SUPPLIER_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({
    description:
      "Opaque keyset cursor, taken verbatim from a previous response's nextCursor.",
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    description:
      "Narrows to active or inactive suppliers. Omitted lists both (FR-012).",
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  isActive?: boolean;
}

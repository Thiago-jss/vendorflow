import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";
import { OPENAPI_BEARER_SCHEME } from "../../../../platform/http/openapi";
import {
  TENANT_CONTEXT,
  type TenantContext,
} from "../../../../platform/tenancy/tenant-context";
import {
  SupplierActionNotAuthorizedError,
  SupplierAlreadyInactiveError,
  SupplierNotFoundError,
  SupplierTaxIdentifierAlreadyRegisteredError,
  SupplierValidationError,
} from "../../../application/contracts/supplier.errors";
import { DeactivateSupplier } from "../../../application/use-cases/deactivate-supplier";
import { GetSupplier } from "../../../application/use-cases/get-supplier";
import { ListSuppliers } from "../../../application/use-cases/list-suppliers";
import { RegisterSupplier } from "../../../application/use-cases/register-supplier";
import {
  ListSuppliersQueryDto,
  RegisterSupplierDto,
} from "../dto/supplier.dto";
import {
  SupplierPageResponse,
  SupplierResponse,
  decodeSupplierCursor,
  toSupplierPageResponse,
  toSupplierResponse,
} from "../dto/supplier.response";

/**
 * FR-010 – FR-013. The organization's supplier registry.
 *
 * Authentication is default-deny through the global guard, so no route here is annotated to
 * be protected and none may be annotated `@Public()`. Authorization is server-side and
 * capability-first: the BUYER/ADMIN check runs before any read, so an unauthorized caller
 * never causes a lookup and learns nothing from response timing (AUTHZ-001, AUTHZ-003).
 *
 * Nothing here logs a request body, a legal name, a fiscal identifier, an email address or a
 * phone number (SEC-009). The error messages below name rules, never values.
 */
@ApiTags("suppliers")
@ApiBearerAuth(OPENAPI_BEARER_SCHEME)
@ApiUnauthorizedResponse({
  description: "No usable access token. Every route here is default-deny.",
})
@Controller("suppliers")
export class SuppliersController {
  constructor(
    @Inject(TENANT_CONTEXT) private readonly tenantContext: TenantContext,
    private readonly registerSupplier: RegisterSupplier,
    private readonly listSuppliers: ListSuppliers,
    private readonly getSupplier: GetSupplier,
    private readonly deactivateSupplier: DeactivateSupplier,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Register a supplier",
    description:
      "FR-010/FR-013. Requires BUYER or ADMIN. The organization is derived from the access token; sending it, an id, or an activity flag is a 400. A CNPJ is normalized to its 14 digits and check-digit validated (422 when invalid); an OTHER identifier is stored as given and no national validation is claimed. Uniqueness is per organization on the normalized form, whatever the type.",
  })
  @ApiCreatedResponse({ type: SupplierResponse })
  @ApiBadRequestResponse({
    description: "Malformed payload, or a field the client is not allowed to supply.",
  })
  @ApiForbiddenResponse({
    description:
      "Authenticated, but the principal holds neither BUYER nor ADMIN. Names no resource.",
  })
  @ApiConflictResponse({
    description:
      "Another supplier of this organization already carries this tax identifier (FR-013).",
  })
  @ApiUnprocessableEntityResponse({
    description:
      "Well-formed payload that a domain rule refuses, such as invalid CNPJ check digits.",
  })
  async register(@Body() body: RegisterSupplierDto): Promise<SupplierResponse> {
    return this.run(async () =>
      toSupplierResponse(
        await this.registerSupplier.execute(
          this.tenantContext.getPrincipal(),
          body,
        ),
      ),
    );
  }

  @Get()
  @ApiOperation({
    summary: "List the organization's suppliers",
    description:
      "NFR-004. Keyset pagination, newest first. Requires BUYER or ADMIN and never includes another organization's rows.",
  })
  @ApiOkResponse({ type: SupplierPageResponse })
  @ApiBadRequestResponse({
    description: "Page size out of range, unknown query parameter, or an unusable cursor.",
  })
  @ApiForbiddenResponse({ description: "The principal holds neither BUYER nor ADMIN." })
  async list(
    @Query() query: ListSuppliersQueryDto,
  ): Promise<SupplierPageResponse> {
    return this.run(async () => {
      const after =
        query.cursor === undefined ? null : decodeSupplierCursor(query.cursor);

      if (query.cursor !== undefined && after === null) {
        throw new BadRequestException("The pagination cursor is not valid");
      }

      return toSupplierPageResponse(
        await this.listSuppliers.execute(this.tenantContext.getPrincipal(), {
          limit: query.limit,
          isActive: query.isActive ?? null,
          after,
        }),
      );
    });
  }

  @Get(":supplierId")
  @ApiOperation({
    summary: "Read one supplier",
    description:
      "Requires BUYER or ADMIN. An unknown identifier and another organization's are one answer (MT-004).",
  })
  @ApiParam({ name: "supplierId", format: "uuid" })
  @ApiOkResponse({ type: SupplierResponse })
  @ApiForbiddenResponse({ description: "The principal holds neither BUYER nor ADMIN." })
  @ApiNotFoundResponse({
    description: "Unknown or another tenant's identifier — indistinguishable by design.",
  })
  async findOne(
    @Param("supplierId", new ParseUUIDPipe({ version: "4" }))
    supplierId: string,
  ): Promise<SupplierResponse> {
    return this.run(async () =>
      toSupplierResponse(
        await this.getSupplier.execute(
          this.tenantContext.getPrincipal(),
          supplierId,
        ),
      ),
    );
  }

  @Post(":supplierId/deactivate")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Deactivate a supplier",
    description:
      "FR-012. Requires BUYER or ADMIN. The supplier stays attached to every quote and purchase order it already has; what changes is that no new quote may be registered against it. Deactivating an already-inactive supplier is a 409, not a silent success — there is no idempotency key here because REL-004 does not name this operation and the conditional write is naturally at-most-once.",
  })
  @ApiParam({ name: "supplierId", format: "uuid" })
  @ApiOkResponse({ type: SupplierResponse })
  @ApiForbiddenResponse({ description: "The principal holds neither BUYER nor ADMIN." })
  @ApiNotFoundResponse({ description: "Unknown or another tenant's identifier." })
  @ApiConflictResponse({ description: "The supplier is already inactive." })
  async deactivate(
    @Param("supplierId", new ParseUUIDPipe({ version: "4" }))
    supplierId: string,
  ): Promise<SupplierResponse> {
    return this.run(async () =>
      toSupplierResponse(
        await this.deactivateSupplier.execute(
          this.tenantContext.getPrincipal(),
          supplierId,
        ),
      ),
    );
  }

  /**
   * One translation from application errors to HTTP, so every route answers a given failure
   * identically. A missing identifier and one belonging to another tenant both arrive as
   * `SupplierNotFoundError` and leave as the same bare 404 (MT-004).
   */
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof SupplierNotFoundError) {
        throw new NotFoundException();
      }

      if (error instanceof SupplierActionNotAuthorizedError) {
        throw new ForbiddenException("Not allowed to perform this action");
      }

      if (error instanceof SupplierValidationError) {
        throw new UnprocessableEntityException(error.message);
      }

      if (
        error instanceof SupplierTaxIdentifierAlreadyRegisteredError ||
        error instanceof SupplierAlreadyInactiveError
      ) {
        throw new ConflictException(error.message);
      }

      throw error;
    }
  }
}

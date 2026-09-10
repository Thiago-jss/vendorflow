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
  UseGuards,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";
import {
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKey,
} from "../../../../platform/idempotency/infrastructure/http/idempotency-key.decorator";
import { rethrowIdempotencyFailure } from "../../../../platform/idempotency/infrastructure/http/idempotency-http";
import { OPENAPI_BEARER_SCHEME } from "../../../../platform/http/openapi";
import {
  TENANT_CONTEXT,
  type TenantContext,
} from "../../../../platform/tenancy/tenant-context";
import {
  PurchaseRequestNotFoundError,
  PurchaseRequestValidationError,
} from "../../../../procurement/application/contracts/purchase-request.errors";
import {
  SupplierInactiveError,
  SupplierNotFoundError,
} from "../../../../supplier/application/contracts/supplier.errors";
import {
  QuotationActionNotAuthorizedError,
  SupplierQuoteAlreadyActiveError,
  SupplierQuoteConcurrentlyModifiedError,
  SupplierQuoteExpiredError,
  SupplierQuoteNotActionableError,
  SupplierQuoteNotFoundError,
  SupplierQuoteValidationError,
} from "../../../application/contracts/quotation.errors";
import { ListSupplierQuotes } from "../../../application/use-cases/list-supplier-quotes";
import { RegisterSupplierQuote } from "../../../application/use-cases/register-supplier-quote";
import { SelectSupplierQuote } from "../../../application/use-cases/select-supplier-quote";
import { WithdrawSupplierQuote } from "../../../application/use-cases/withdraw-supplier-quote";
import { parseQuoteValidUntil, parseQuotedCents } from "../dto/quoted-cents";
import {
  ListSupplierQuotesQueryDto,
  RegisterSupplierQuoteDto,
  SelectSupplierQuoteDto,
} from "../dto/supplier-quote.dto";
import {
  SelectSupplierQuoteResponse,
  SupplierQuoteListResponse,
  SupplierQuoteResponse,
  decodeSupplierQuoteCursor,
  toSelectSupplierQuoteResponse,
  toSupplierQuoteListResponse,
  toSupplierQuoteResponse,
} from "../dto/supplier-quote.response";
import { QuoteSelectionRateLimitGuard } from "../guards/quote-selection-rate-limit.guard";

/**
 * FR-040 – FR-046. The quotes of one purchase request.
 *
 * The route is nested under the request because a quote has no life outside one: every
 * operation here is scoped to `(organization, request, quote)`, which is what makes a quote
 * identifier from another request of the same tenant answer exactly as an unknown one does
 * (MT-004).
 *
 * Authentication is default-deny through the global guard. Authorization is capability-first:
 * the BUYER check runs before any read, so an unauthorized caller never causes a lookup
 * (AUTHZ-003). ADMIN is deliberately not accepted here — see `quote-authorization.ts`.
 *
 * Nothing here logs a request body, a quoted price, a supplier identifier or a selection
 * rationale (SEC-009).
 */
@ApiTags("supplier-quotes")
@ApiBearerAuth(OPENAPI_BEARER_SCHEME)
@ApiUnauthorizedResponse({
  description: "No usable access token. Every route here is default-deny.",
})
@Controller("purchase-requests/:purchaseRequestId/quotes")
export class SupplierQuotesController {
  constructor(
    @Inject(TENANT_CONTEXT) private readonly tenantContext: TenantContext,
    private readonly registerSupplierQuote: RegisterSupplierQuote,
    private readonly listSupplierQuotes: ListSupplierQuotes,
    private readonly withdrawSupplierQuote: WithdrawSupplierQuote,
    private readonly selectSupplierQuote: SelectSupplierQuote,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Register a supplier quote",
    description: [
      "FR-040 – FR-042. Requires BUYER, an active supplier of this organization, and a request",
      "still in IN_QUOTATION. The request's row is locked and its state proven before any quote",
      "row is written, so a quote can never be registered against a request that has just been",
      "cancelled.",
      "",
      "Line quantities are read from the persisted request items and are not accepted from the",
      "client (BR-025). Line totals, the goods subtotal and the quote total are computed",
      "server-side in exact integer centavos and are never accepted either (BR-032).",
      "",
      "BR-021 is enforced three times over: in the domain for a good message, by a composite",
      "foreign key that refuses a line belonging to another request, and by a deferred",
      "constraint trigger that refuses at COMMIT a quote whose line coverage is not exact.",
    ].join(" "),
  })
  @ApiParam({ name: "purchaseRequestId", format: "uuid" })
  @ApiCreatedResponse({ type: SupplierQuoteResponse })
  @ApiBadRequestResponse({
    description:
      "Malformed payload, a disallowed field such as a quantity or a total, or a malformed monetary string.",
  })
  @ApiForbiddenResponse({
    description: "Authenticated, but the principal does not hold BUYER. Names no resource.",
  })
  @ApiNotFoundResponse({
    description:
      "The request is unknown, belongs to another tenant, or is no longer in quotation; the supplier is unknown or belongs to another tenant. Indistinguishable by design (MT-004).",
  })
  @ApiConflictResponse({
    description:
      "The supplier is inactive (FR-012), or already has an active quote on this request (BR-022).",
  })
  @ApiUnprocessableEntityResponse({
    description:
      "Well-formed payload that a domain rule refuses: a negative freight or discount, a discount larger than the goods, an incomplete or duplicated line list, a total larger than this system stores, or a validity date such as 2026-02-30.",
  })
  async register(
    @Param("purchaseRequestId", new ParseUUIDPipe({ version: "4" }))
    purchaseRequestId: string,
    @Body() body: RegisterSupplierQuoteDto,
  ): Promise<SupplierQuoteResponse> {
    return this.run(async () =>
      toSupplierQuoteResponse(
        await this.registerSupplierQuote.execute(
          this.tenantContext.getPrincipal(),
          purchaseRequestId,
          {
            supplierId: body.supplierId,
            freightCents: parseQuotedCents(body.freightCents, "freight"),
            discountCents: parseQuotedCents(body.discountCents, "discount"),
            validUntil: parseQuoteValidUntil(body.validUntil),
            deliveryLeadTimeDays: body.deliveryLeadTimeDays,
            lines: body.lines.map((line) => ({
              purchaseRequestItemId: line.purchaseRequestItemId,
              unitPriceCents: parseQuotedCents(
                line.unitPriceCents,
                "unit price",
              ),
            })),
          },
        ),
      ),
    );
  }

  @Get()
  @ApiOperation({
    summary: "Compare the quotes of a request",
    description: [
      "FR-043. Requires BUYER. Ordered by total ascending, then by quote identifier ascending",
      "so two suppliers at the same total have a stable order rather than a physical one.",
      "",
      "NFR-004: keyset-paginated. The cursor encodes both ordering keys, so a page boundary that",
      "falls inside a group of equal totals neither skips nor repeats a quote. There is no cap on",
      "how many quotes a request may collect — the bound is on the page, not on the business.",
      "",
      "Withdrawn quotes are included with their status, because a comparison that silently drops",
      "what was taken back cannot explain the decision that followed it (FR-046).",
    ].join(" "),
  })
  @ApiParam({ name: "purchaseRequestId", format: "uuid" })
  @ApiOkResponse({ type: SupplierQuoteListResponse })
  @ApiBadRequestResponse({
    description:
      "Page size out of range, unknown query parameter, or an unusable cursor.",
  })
  @ApiForbiddenResponse({ description: "The principal does not hold BUYER." })
  @ApiNotFoundResponse({
    description: "Unknown or another tenant's request identifier.",
  })
  async list(
    @Param("purchaseRequestId", new ParseUUIDPipe({ version: "4" }))
    purchaseRequestId: string,
    @Query() query: ListSupplierQuotesQueryDto,
  ): Promise<SupplierQuoteListResponse> {
    return this.run(async () => {
      const after =
        query.cursor === undefined
          ? null
          : decodeSupplierQuoteCursor(query.cursor);

      // A cursor that does not decode is a malformed request, not an empty page: answering
      // with the first page instead would silently restart a client that believed it was
      // resuming.
      if (query.cursor !== undefined && after === null) {
        throw new BadRequestException("The pagination cursor is not valid");
      }

      return toSupplierQuoteListResponse(
        await this.listSupplierQuotes.execute(
          this.tenantContext.getPrincipal(),
          purchaseRequestId,
          { limit: query.limit, after },
        ),
      );
    });
  }

  @Post(":supplierQuoteId/withdraw")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Withdraw a quote",
    description:
      "FR-046. Requires BUYER. The quote stays visible in the comparison with its status; it is never deleted. A selected quote cannot be withdrawn (BR-024), and the conditional write restates that so a withdrawal racing a selection loses cleanly.",
  })
  @ApiParam({ name: "purchaseRequestId", format: "uuid" })
  @ApiParam({ name: "supplierQuoteId", format: "uuid" })
  @ApiOkResponse({ type: SupplierQuoteResponse })
  @ApiForbiddenResponse({ description: "The principal does not hold BUYER." })
  @ApiNotFoundResponse({
    description:
      "Unknown, another tenant's, or another request's quote identifier — indistinguishable by design.",
  })
  @ApiConflictResponse({
    description:
      "The quote is already withdrawn or already selected, or the request is no longer in quotation.",
  })
  async withdraw(
    @Param("purchaseRequestId", new ParseUUIDPipe({ version: "4" }))
    purchaseRequestId: string,
    @Param("supplierQuoteId", new ParseUUIDPipe({ version: "4" }))
    supplierQuoteId: string,
  ): Promise<SupplierQuoteResponse> {
    return this.run(async () =>
      toSupplierQuoteResponse(
        await this.withdrawSupplierQuote.execute(
          this.tenantContext.getPrincipal(),
          purchaseRequestId,
          supplierQuoteId,
        ),
      ),
    );
  }

  @Post(":supplierQuoteId/select")
  @HttpCode(HttpStatus.OK)
  @UseGuards(QuoteSelectionRateLimitGuard)
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description:
      "REL-004. An opaque token of 8 to 200 printable non-whitespace characters. Retrying with the same key replays the first result without selecting again; reusing it for a different request is a 409. Only a SHA-256 of the key is ever stored.",
  })
  @ApiOperation({
    summary: "Select the winning quote",
    description: [
      "FR-044/FR-045 and BR-003. Requires BUYER, an ACTIVE unexpired quote, a request still in",
      "IN_QUOTATION, and a rationale of at least 10 non-whitespace characters.",
      "",
      "One transaction selects the quote, re-evaluates the approval ladder against the selected",
      "quote total, transitions the request, writes both audit events and commits the outgoing",
      "notification intent. The resulting status is APPROVED when no post-quotation approval",
      "remains and IN_FINAL_APPROVAL otherwise — decided by the policy, never by the client.",
      "",
      "Validity is re-checked inside the conditional write, so a quote that expires between the",
      "read and the write does not slip through. A partial unique index permits one selected",
      "quote per request, so two buyers selecting different quotes produce exactly one winner.",
    ].join(" "),
  })
  @ApiParam({ name: "purchaseRequestId", format: "uuid" })
  @ApiParam({ name: "supplierQuoteId", format: "uuid" })
  @ApiOkResponse({ type: SelectSupplierQuoteResponse })
  @ApiBadRequestResponse({
    description: "Malformed payload, a disallowed field, or a missing or malformed Idempotency-Key.",
  })
  @ApiForbiddenResponse({ description: "The principal does not hold BUYER." })
  @ApiNotFoundResponse({
    description: "Unknown, another tenant's, or another request's identifier.",
  })
  @ApiConflictResponse({
    description:
      "The quote is withdrawn or already selected, the quote has expired, the request left IN_QUOTATION, another selection won the race, or the idempotency key was reused for a different request.",
  })
  @ApiUnprocessableEntityResponse({
    description: "A rationale shorter than 10 non-whitespace characters.",
  })
  @ApiTooManyRequestsResponse({
    description:
      "SEC-006. The caller's address or account budget for this route is spent. Nothing is selected, transitioned, audited or published.",
  })
  async select(
    @Param("purchaseRequestId", new ParseUUIDPipe({ version: "4" }))
    purchaseRequestId: string,
    @Param("supplierQuoteId", new ParseUUIDPipe({ version: "4" }))
    supplierQuoteId: string,
    @Body() body: SelectSupplierQuoteDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
  ): Promise<SelectSupplierQuoteResponse> {
    return this.run(async () =>
      toSelectSupplierQuoteResponse(
        await this.selectSupplierQuote.execute(
          this.tenantContext.getPrincipal(),
          purchaseRequestId,
          supplierQuoteId,
          {
            selectionRationale: body.selectionRationale,
            idempotencyKey,
          },
        ),
      ),
    );
  }

  /**
   * One translation from application errors to HTTP, so every route answers a given failure
   * identically.
   *
   * A quote that does not exist, one belonging to another tenant, one belonging to another
   * request, and a request that is unknown or no longer quotable all arrive as a not-found and
   * leave as the same bare 404 (MT-004). An inactive supplier and an existing active quote are
   * 409 rather than 404, because both name a resource the caller can already see and hiding the
   * reason would make the refusal unexplainable.
   */
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      // REL-004's failures answer identically on every route that requires a key.
      rethrowIdempotencyFailure(error);

      if (
        error instanceof SupplierQuoteNotFoundError ||
        error instanceof PurchaseRequestNotFoundError ||
        error instanceof SupplierNotFoundError
      ) {
        throw new NotFoundException();
      }

      if (error instanceof QuotationActionNotAuthorizedError) {
        throw new ForbiddenException("Not allowed to perform this action");
      }

      if (
        error instanceof SupplierQuoteValidationError ||
        error instanceof PurchaseRequestValidationError
      ) {
        throw new UnprocessableEntityException(error.message);
      }

      if (
        error instanceof SupplierInactiveError ||
        error instanceof SupplierQuoteAlreadyActiveError ||
        error instanceof SupplierQuoteNotActionableError ||
        error instanceof SupplierQuoteExpiredError ||
        error instanceof SupplierQuoteConcurrentlyModifiedError
      ) {
        throw new ConflictException(error.message);
      }

      throw error;
    }
  }
}

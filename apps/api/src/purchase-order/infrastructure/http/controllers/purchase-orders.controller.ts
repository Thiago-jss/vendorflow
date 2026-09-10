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
import { OPENAPI_BEARER_SCHEME } from "../../../../platform/http/openapi";
import {
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKey,
} from "../../../../platform/idempotency/infrastructure/http/idempotency-key.decorator";
import { rethrowIdempotencyFailure } from "../../../../platform/idempotency/infrastructure/http/idempotency-http";
import {
  TENANT_CONTEXT,
  type TenantContext,
} from "../../../../platform/tenancy/tenant-context";
import { PurchaseRequestNotFoundError } from "../../../../procurement/application/contracts/purchase-request.errors";
import { SupplierQuoteNotFoundError } from "../../../../quotation/application/contracts/quotation.errors";
import { SupplierNotFoundError } from "../../../../supplier/application/contracts/supplier.errors";
import {
  PurchaseOrderActionNotAuthorizedError,
  PurchaseOrderAlreadyIssuedError,
  PurchaseOrderConcurrentlyModifiedError,
  PurchaseOrderNotCancellableError,
  PurchaseOrderNotFoundError,
  PurchaseOrderValidationError,
} from "../../../application/contracts/purchase-order.errors";
import { CancelPurchaseOrder } from "../../../application/use-cases/cancel-purchase-order";
import { GetPurchaseOrder } from "../../../application/use-cases/get-purchase-order";
import { IssuePurchaseOrder } from "../../../application/use-cases/issue-purchase-order";
import { ListPurchaseOrders } from "../../../application/use-cases/list-purchase-orders";
import {
  CancelPurchaseOrderDto,
  IssuePurchaseOrderDto,
  ListPurchaseOrdersQueryDto,
} from "../dto/purchase-order.dto";
import {
  PurchaseOrderPageResponse,
  PurchaseOrderResponse,
  decodePurchaseOrderCursor,
  toPurchaseOrderPageResponse,
  toPurchaseOrderResponse,
} from "../dto/purchase-order.response";
import { PurchaseOrderRateLimitGuard } from "../guards/purchase-order-rate-limit.guard";

/**
 * FR-050 – FR-054. The organization's purchase orders.
 *
 * Authentication is default-deny through the global guard. Authorization is capability-first
 * and deliberately asymmetric: issuing requires BUYER, because it is the commercial act that
 * commits the organization to a supplier at a price; reading and cancelling accept BUYER or
 * ADMIN, because FR-054 names both and cancelling commits nothing (AUTHZ-003, AUTHZ-007).
 *
 * The literal collection routes are declared before `:purchaseOrderId`, so a literal segment
 * is never matched as an identifier. Nest resolves routes in declaration order within a
 * controller, which is why both live here rather than in two controllers whose relative order
 * would depend on module import order.
 *
 * Nothing here logs a request body, a supplier's legal name, a fiscal identifier or a
 * cancellation reason (SEC-009).
 */
@ApiTags("purchase-orders")
@ApiBearerAuth(OPENAPI_BEARER_SCHEME)
@ApiUnauthorizedResponse({
  description: "No usable access token. Every route here is default-deny.",
})
@Controller("purchase-orders")
export class PurchaseOrdersController {
  constructor(
    @Inject(TENANT_CONTEXT) private readonly tenantContext: TenantContext,
    private readonly issuePurchaseOrder: IssuePurchaseOrder,
    private readonly listPurchaseOrders: ListPurchaseOrders,
    private readonly getPurchaseOrder: GetPurchaseOrder,
    private readonly cancelPurchaseOrder: CancelPurchaseOrder,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PurchaseOrderRateLimitGuard)
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description:
      "REL-004. An opaque token of 8 to 200 printable non-whitespace characters. Retrying with the same key replays the first result without issuing again, without allocating a second number and without a second audit event or outbox row; reusing it for a different request is a 409. Only a SHA-256 of the key is ever stored.",
  })
  @ApiOperation({
    summary: "Issue a purchase order",
    description: [
      "FR-050 – FR-053. Requires BUYER and an APPROVED request with exactly one selected quote.",
      "",
      "One transaction locks the request, reads the selected quote and the supplier's legal",
      "identity, allocates the organization's next number, inserts the order and its snapshot",
      "lines, moves the request APPROVED -> ORDERED, appends the audit event and commits the",
      "outgoing notification intent. Because the number is allocated inside that transaction, a",
      "rollback consumes none: the next successful issuance gets the value this attempt would",
      "have had.",
      "",
      "The order is a snapshot. Supplier legal name and tax identifier, prices, quantities and",
      "line descriptions are copied at issuance and are unaffected by later changes to the",
      "supplier, the quote or the request (FR-051). That the order's supplier is the selected",
      "quote's supplier is enforced by a composite foreign key, not by application convention.",
    ].join(" "),
  })
  @ApiCreatedResponse({ type: PurchaseOrderResponse })
  @ApiBadRequestResponse({
    description:
      "Malformed payload, a disallowed field, or a missing or malformed Idempotency-Key.",
  })
  @ApiForbiddenResponse({
    description: "Authenticated, but the principal does not hold BUYER. Names no resource.",
  })
  @ApiNotFoundResponse({
    description:
      "The request is unknown, belongs to another tenant, or is not APPROVED; or it has no selected quote. Indistinguishable by design (MT-004).",
  })
  @ApiConflictResponse({
    description:
      "The request already has a purchase order (FR-050), it changed while this operation ran, or the idempotency key was reused for a different request.",
  })
  @ApiTooManyRequestsResponse({
    description:
      "SEC-006. The caller's address or account budget for this route is spent. No number is allocated and nothing is written.",
  })
  async issue(
    @Body() body: IssuePurchaseOrderDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
  ): Promise<PurchaseOrderResponse> {
    return this.run(async () =>
      toPurchaseOrderResponse(
        await this.issuePurchaseOrder.execute(
          this.tenantContext.getPrincipal(),
          { purchaseRequestId: body.purchaseRequestId, idempotencyKey },
        ),
      ),
    );
  }

  @Get()
  @ApiOperation({
    summary: "List the organization's purchase orders",
    description:
      "FR-054. Requires BUYER or ADMIN. Keyset pagination, newest first. Never includes another organization's rows.",
  })
  @ApiOkResponse({ type: PurchaseOrderPageResponse })
  @ApiBadRequestResponse({
    description: "Page size out of range, unknown query parameter, or an unusable cursor.",
  })
  @ApiForbiddenResponse({ description: "The principal holds neither BUYER nor ADMIN." })
  async list(
    @Query() query: ListPurchaseOrdersQueryDto,
  ): Promise<PurchaseOrderPageResponse> {
    return this.run(async () => {
      const after =
        query.cursor === undefined
          ? null
          : decodePurchaseOrderCursor(query.cursor);

      if (query.cursor !== undefined && after === null) {
        throw new BadRequestException("The pagination cursor is not valid");
      }

      return toPurchaseOrderPageResponse(
        await this.listPurchaseOrders.execute(
          this.tenantContext.getPrincipal(),
          { limit: query.limit, status: query.status ?? null, after },
        ),
      );
    });
  }

  @Get(":purchaseOrderId")
  @ApiOperation({
    summary: "Read one purchase order",
    description:
      "FR-054. Requires BUYER or ADMIN. An unknown identifier and another organization's are one answer (MT-004).",
  })
  @ApiParam({ name: "purchaseOrderId", format: "uuid" })
  @ApiOkResponse({ type: PurchaseOrderResponse })
  @ApiForbiddenResponse({ description: "The principal holds neither BUYER nor ADMIN." })
  @ApiNotFoundResponse({
    description: "Unknown or another tenant's identifier — indistinguishable by design.",
  })
  async findOne(
    @Param("purchaseOrderId", new ParseUUIDPipe({ version: "4" }))
    purchaseOrderId: string,
  ): Promise<PurchaseOrderResponse> {
    return this.run(async () =>
      toPurchaseOrderResponse(
        await this.getPurchaseOrder.execute(
          this.tenantContext.getPrincipal(),
          purchaseOrderId,
        ),
      ),
    );
  }

  @Post(":purchaseOrderId/cancel")
  @HttpCode(HttpStatus.OK)
  @UseGuards(PurchaseOrderRateLimitGuard)
  @ApiOperation({
    summary: "Cancel a purchase order",
    description: [
      "FR-054 and BR-013. Requires BUYER or ADMIN and a reason of at least 10 non-whitespace",
      "characters. Cancellation is terminal: it does not reopen the purchase request, does not",
      "return it from ORDERED, and does not make the selected quote selectable again.",
      "",
      "There is no Idempotency-Key here, because REL-004 names four durable operations and this",
      "is not one of them: the conditional write is naturally at-most-once, and retrying a",
      "completed cancellation is a stated 409 rather than a duplicated effect.",
      "",
      "An audit event is written and no message is published. FR-062 requires next-actor,",
      "approval, rejection and order-issued notifications; it does not require a cancellation",
      "notification, and this system has no consumer for one.",
    ].join(" "),
  })
  @ApiParam({ name: "purchaseOrderId", format: "uuid" })
  @ApiOkResponse({ type: PurchaseOrderResponse })
  @ApiBadRequestResponse({ description: "Malformed payload or a disallowed field." })
  @ApiForbiddenResponse({ description: "The principal holds neither BUYER nor ADMIN." })
  @ApiNotFoundResponse({ description: "Unknown or another tenant's identifier." })
  @ApiConflictResponse({
    description: "The order is already cancelled, or it changed while this operation ran.",
  })
  @ApiUnprocessableEntityResponse({
    description: "A reason shorter than 10 non-whitespace characters.",
  })
  @ApiTooManyRequestsResponse({
    description:
      "SEC-006. The caller's address or account budget for this route is spent. Nothing is cancelled or audited.",
  })
  async cancel(
    @Param("purchaseOrderId", new ParseUUIDPipe({ version: "4" }))
    purchaseOrderId: string,
    @Body() body: CancelPurchaseOrderDto,
  ): Promise<PurchaseOrderResponse> {
    return this.run(async () =>
      toPurchaseOrderResponse(
        await this.cancelPurchaseOrder.execute(
          this.tenantContext.getPrincipal(),
          purchaseOrderId,
          body.reason,
        ),
      ),
    );
  }

  /**
   * One translation from application errors to HTTP, so every route answers a given failure
   * identically.
   *
   * An unknown order, one belonging to another tenant, a request that is unknown or not
   * approved, and an approved request with no selected quote all leave as the same bare 404
   * (MT-004). Nothing distinguishes them, and nothing should: each of the last two would
   * otherwise confirm the existence of a request the caller may not be able to see.
   */
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      // REL-004's failures answer identically on every route that requires a key.
      rethrowIdempotencyFailure(error);

      if (
        error instanceof PurchaseOrderNotFoundError ||
        error instanceof PurchaseRequestNotFoundError ||
        error instanceof SupplierQuoteNotFoundError ||
        error instanceof SupplierNotFoundError
      ) {
        throw new NotFoundException();
      }

      if (error instanceof PurchaseOrderActionNotAuthorizedError) {
        throw new ForbiddenException("Not allowed to perform this action");
      }

      if (error instanceof PurchaseOrderValidationError) {
        throw new UnprocessableEntityException(error.message);
      }

      if (
        error instanceof PurchaseOrderAlreadyIssuedError ||
        error instanceof PurchaseOrderNotCancellableError ||
        error instanceof PurchaseOrderConcurrentlyModifiedError
      ) {
        throw new ConflictException(error.message);
      }

      throw error;
    }
  }
}

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
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
  InvalidPaginationCursorError,
  PurchaseRequestActionNotAuthorizedError,
  PurchaseRequestConcurrentlyModifiedError,
  PurchaseRequestNotFoundError,
  PurchaseRequestTransitionNotAllowedError,
  PurchaseRequestValidationError,
} from "../../../application/contracts/purchase-request.errors";
import { CancelOwnPurchaseRequest } from "../../../application/use-cases/cancel-own-purchase-request";
import { CreatePurchaseRequestDraft } from "../../../application/use-cases/create-purchase-request-draft";
import { DeleteOwnPurchaseRequestDraft } from "../../../application/use-cases/delete-own-purchase-request-draft";
import { GetOwnPurchaseRequest } from "../../../application/use-cases/get-own-purchase-request";
import { ListOwnPurchaseRequests } from "../../../application/use-cases/list-own-purchase-requests";
import { SubmitOwnPurchaseRequest } from "../../../application/use-cases/submit-own-purchase-request";
import { UpdateOwnPurchaseRequestDraft } from "../../../application/use-cases/update-own-purchase-request-draft";
import { CurrentOrganizationContextNotFoundError } from "../../../../identity-access/application/use-cases/get-current-organization-context";
import { ListPurchaseRequestsQueryDto } from "../dto/list-purchase-requests.dto";
import { PurchaseRequestDraftDto } from "../dto/purchase-request-draft.dto";
import { decodePurchaseRequestCursor } from "../dto/purchase-request-cursor";
import {
  PurchaseRequestPageResponse,
  PurchaseRequestResponse,
  toPurchaseRequestPageResponse,
  toPurchaseRequestResponse,
} from "../dto/purchase-request.response";

/**
 * The requester's own purchase requests.
 *
 * Authentication is default-deny through the global guard, so no route here is annotated to
 * be protected and none may be annotated `@Public()`. Authorization is object-level and
 * server-side (AUTHZ-001): every operation is scoped to the principal's organization and to
 * the principal as requester, which is why no path or body carries an owner.
 *
 * The state machine is not exposed as a writable field. `PUT` replaces the editable content
 * of a draft; a transition is a named command with its own route, so a client can never ask
 * for an arbitrary status (AUTHZ-005).
 *
 * Nothing here logs a request body, a justification or an item description (SEC-009).
 */
@ApiTags("purchase-requests")
@ApiBearerAuth(OPENAPI_BEARER_SCHEME)
@ApiUnauthorizedResponse({
  description: "No usable access token. Every route here is default-deny.",
})
@Controller("purchase-requests")
export class PurchaseRequestsController {
  constructor(
    @Inject(TENANT_CONTEXT) private readonly tenantContext: TenantContext,
    private readonly createPurchaseRequestDraft: CreatePurchaseRequestDraft,
    private readonly getOwnPurchaseRequest: GetOwnPurchaseRequest,
    private readonly listOwnPurchaseRequests: ListOwnPurchaseRequests,
    private readonly updateOwnPurchaseRequestDraft: UpdateOwnPurchaseRequestDraft,
    private readonly submitOwnPurchaseRequest: SubmitOwnPurchaseRequest,
    private readonly cancelOwnPurchaseRequest: CancelOwnPurchaseRequest,
    private readonly deleteOwnPurchaseRequestDraft: DeleteOwnPurchaseRequestDraft,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Create a purchase request in DRAFT",
    description:
      "FR-020. Requires the EMPLOYEE role. The organization, requester, department, status and estimated total are all derived server-side; sending any of them is a 400.",
  })
  @ApiCreatedResponse({ type: PurchaseRequestResponse })
  @ApiBadRequestResponse({
    description: "Malformed payload, or a field the client is not allowed to supply.",
  })
  @ApiForbiddenResponse({
    description: "The principal is authenticated but does not hold the EMPLOYEE role.",
  })
  @ApiUnprocessableEntityResponse({
    description:
      "Well-formed payload that a domain rule refuses, such as a needed-by date of 2026-02-30.",
  })
  async create(
    @Body() body: PurchaseRequestDraftDto,
  ): Promise<PurchaseRequestResponse> {
    return this.run(async () =>
      toPurchaseRequestResponse(
        await this.createPurchaseRequestDraft.execute(
          this.tenantContext.getPrincipal(),
          body,
        ),
      ),
    );
  }

  @Get()
  @ApiOperation({
    summary: "List the caller's own purchase requests",
    description:
      "NFR-004. Keyset pagination, newest first. Never includes another tenant's or another requester's rows.",
  })
  @ApiOkResponse({ type: PurchaseRequestPageResponse })
  @ApiBadRequestResponse({
    description: "Page size out of range, unknown query parameter, or an unusable cursor.",
  })
  async list(
    @Query() query: ListPurchaseRequestsQueryDto,
  ): Promise<PurchaseRequestPageResponse> {
    return this.run(async () =>
      toPurchaseRequestPageResponse(
        await this.listOwnPurchaseRequests.execute(
          this.tenantContext.getPrincipal(),
          {
            limit: query.limit,
            after:
              query.cursor === undefined
                ? null
                : decodePurchaseRequestCursor(query.cursor),
          },
        ),
      ),
    );
  }

  @Get(":purchaseRequestId")
  @ApiOperation({
    summary: "Read one of the caller's own purchase requests",
    description:
      "FR-026, for the part of it that exists in this phase: the current state. There is no pending approval step or step history yet.",
  })
  @ApiParam({ name: "purchaseRequestId", format: "uuid" })
  @ApiOkResponse({ type: PurchaseRequestResponse })
  @ApiNotFoundResponse({
    description:
      "Unknown, another requester's, or another tenant's identifier — indistinguishable by design (MT-004).",
  })
  async findOne(
    @Param("purchaseRequestId", new ParseUUIDPipe({ version: "4" }))
    purchaseRequestId: string,
  ): Promise<PurchaseRequestResponse> {
    return this.run(async () =>
      toPurchaseRequestResponse(
        await this.getOwnPurchaseRequest.execute(
          this.tenantContext.getPrincipal(),
          purchaseRequestId,
        ),
      ),
    );
  }

  @Put(":purchaseRequestId")
  @ApiOperation({
    summary: "Replace the editable content of a DRAFT",
    description:
      "FR-022. Replaces justification, needed-by date and the whole item list, and recomputes the estimated total. The status is not a writable field.",
  })
  @ApiParam({ name: "purchaseRequestId", format: "uuid" })
  @ApiOkResponse({ type: PurchaseRequestResponse })
  @ApiBadRequestResponse({ description: "Malformed payload or a disallowed field." })
  @ApiNotFoundResponse({ description: "Unknown, foreign, or another requester's identifier." })
  @ApiConflictResponse({
    description:
      "The request is no longer a DRAFT, or it changed while this operation was running (FR-023).",
  })
  @ApiUnprocessableEntityResponse({
    description: "Well-formed payload that a domain rule refuses.",
  })
  async replaceDraft(
    @Param("purchaseRequestId", new ParseUUIDPipe({ version: "4" }))
    purchaseRequestId: string,
    @Body() body: PurchaseRequestDraftDto,
  ): Promise<PurchaseRequestResponse> {
    return this.run(async () =>
      toPurchaseRequestResponse(
        await this.updateOwnPurchaseRequestDraft.execute(
          this.tenantContext.getPrincipal(),
          purchaseRequestId,
          body,
        ),
      ),
    );
  }

  @Post(":purchaseRequestId/submit")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Submit a DRAFT",
    description:
      "FR-023. DRAFT to SUBMITTED, by the requester only. This phase persists the transition and the computed total; FR-024's Approval Flow belongs to a later phase.",
  })
  @ApiParam({ name: "purchaseRequestId", format: "uuid" })
  @ApiOkResponse({ type: PurchaseRequestResponse })
  @ApiNotFoundResponse({ description: "Unknown, foreign, or another requester's identifier." })
  @ApiConflictResponse({
    description:
      "The current state does not permit submission, or a concurrent transition won the race.",
  })
  async submit(
    @Param("purchaseRequestId", new ParseUUIDPipe({ version: "4" }))
    purchaseRequestId: string,
  ): Promise<PurchaseRequestResponse> {
    return this.run(async () =>
      toPurchaseRequestResponse(
        await this.submitOwnPurchaseRequest.execute(
          this.tenantContext.getPrincipal(),
          purchaseRequestId,
        ),
      ),
    );
  }

  @Post(":purchaseRequestId/cancel")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Cancel the caller's own request",
    description:
      "FR-025 and BR-013. Permitted from DRAFT and SUBMITTED, the only states reachable in this phase, and never once ORDERED.",
  })
  @ApiParam({ name: "purchaseRequestId", format: "uuid" })
  @ApiOkResponse({ type: PurchaseRequestResponse })
  @ApiNotFoundResponse({ description: "Unknown, foreign, or another requester's identifier." })
  @ApiConflictResponse({
    description: "The current state does not permit cancellation, or it changed underneath.",
  })
  async cancel(
    @Param("purchaseRequestId", new ParseUUIDPipe({ version: "4" }))
    purchaseRequestId: string,
  ): Promise<PurchaseRequestResponse> {
    return this.run(async () =>
      toPurchaseRequestResponse(
        await this.cancelOwnPurchaseRequest.execute(
          this.tenantContext.getPrincipal(),
          purchaseRequestId,
        ),
      ),
    );
  }

  @Delete(":purchaseRequestId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Delete a DRAFT",
    description:
      "FR-022. DRAFT only, requester only. The items go with it; nothing else in the system references a draft.",
  })
  @ApiParam({ name: "purchaseRequestId", format: "uuid" })
  @ApiNoContentResponse({ description: "The draft and its items were removed." })
  @ApiNotFoundResponse({ description: "Unknown, foreign, or another requester's identifier." })
  @ApiConflictResponse({ description: "The request is no longer a DRAFT." })
  async removeDraft(
    @Param("purchaseRequestId", new ParseUUIDPipe({ version: "4" }))
    purchaseRequestId: string,
  ): Promise<void> {
    await this.run(async () => {
      await this.deleteOwnPurchaseRequestDraft.execute(
        this.tenantContext.getPrincipal(),
        purchaseRequestId,
      );
    });
  }

  /**
   * One translation from application errors to HTTP, so every route answers a given failure
   * identically. A missing identifier and one belonging to another tenant or another
   * requester all arrive as `PurchaseRequestNotFoundError` and leave as the same bare 404
   * (MT-004).
   */
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (
        error instanceof PurchaseRequestNotFoundError ||
        // The principal's own membership is gone — deactivated or removed between
        // authentication and this read. Nothing of theirs is reachable, so it is a 404 for
        // the same reason as above, not a hint that something exists.
        error instanceof CurrentOrganizationContextNotFoundError
      ) {
        throw new NotFoundException();
      }

      if (error instanceof PurchaseRequestActionNotAuthorizedError) {
        // AUTHZ-003. Distinct from 404 on purpose: this names no resource, so it confirms
        // nothing about what exists. The message says the capability is missing, never which
        // role would grant it.
        throw new ForbiddenException("Not allowed to perform this action");
      }

      if (error instanceof InvalidPaginationCursorError) {
        throw new BadRequestException(error.message);
      }

      if (error instanceof PurchaseRequestValidationError) {
        // Well-formed JSON that a domain rule refuses, as opposed to a malformed payload the
        // ValidationPipe already answered with 400.
        throw new UnprocessableEntityException(error.message);
      }

      if (
        error instanceof PurchaseRequestTransitionNotAllowedError ||
        error instanceof PurchaseRequestConcurrentlyModifiedError
      ) {
        throw new ConflictException(error.message);
      }

      throw error;
    }
  }
}

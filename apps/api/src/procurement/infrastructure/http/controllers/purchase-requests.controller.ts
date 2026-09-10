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
  UseGuards,
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
  ApiHeader,
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
import { NO_PURCHASE_REQUEST_SUPPLEMENTS } from "../../../application/contracts/purchase-request-supplements";
import {
  ApprovalActionNotAuthorizedError,
  ApprovalDecisionValidationError,
  ApprovalStepNotActionableError,
  SelfApprovalNotAllowedError,
} from "../../../../approval/application/contracts/approval.errors";
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
import { ApprovalRateLimitGuard } from "../guards/approval-rate-limit.guard";
import { CancelOwnPurchaseRequest } from "../../../application/use-cases/cancel-own-purchase-request";
import { DecidePurchaseRequestApproval } from "../../../application/use-cases/decide-purchase-request-approval";
import { ListDepartmentApprovalQueue } from "../../../application/use-cases/list-department-approval-queue";
import { ListQuotationQueue } from "../../../application/use-cases/list-quotation-queue";
import { CreatePurchaseRequestDraft } from "../../../application/use-cases/create-purchase-request-draft";
import { DeleteOwnPurchaseRequestDraft } from "../../../application/use-cases/delete-own-purchase-request-draft";
import { GetOwnPurchaseRequest } from "../../../application/use-cases/get-own-purchase-request";
import { ListOwnPurchaseRequests } from "../../../application/use-cases/list-own-purchase-requests";
import { SubmitOwnPurchaseRequest } from "../../../application/use-cases/submit-own-purchase-request";
import { UpdateOwnPurchaseRequestDraft } from "../../../application/use-cases/update-own-purchase-request-draft";
import { CurrentOrganizationContextNotFoundError } from "../../../../identity-access/application/use-cases/get-current-organization-context";
import { ApprovalDecisionDto } from "../dto/approval-decision.dto";
import { ListPurchaseRequestsQueryDto } from "../dto/list-purchase-requests.dto";
import { PurchaseRequestDraftDto } from "../dto/purchase-request-draft.dto";
import { decodePurchaseRequestCursor } from "../dto/purchase-request-cursor";
import {
  PurchaseRequestPageResponse,
  PurchaseRequestResponse,
  toPurchaseRequestPageResponse,
  toPurchaseRequestResponse,
} from "../dto/purchase-request.response";
import {
  PurchaseRequestApprovalQueueResponse,
  toPurchaseRequestApprovalQueueResponse,
} from "../dto/purchase-request-approval-queue.response";

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
    private readonly listDepartmentApprovalQueue: ListDepartmentApprovalQueue,
    private readonly listQuotationQueue: ListQuotationQueue,
    private readonly decidePurchaseRequestApproval: DecidePurchaseRequestApproval,
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
      toPurchaseRequestResponse({
        // A DRAFT has no approval flow: FR-024 materializes one at submission, and returning
        // an empty one here would be a shape that means nothing. It has no selected quote and
        // no purchase order either, for the same reason.
        request: await this.createPurchaseRequestDraft.execute(
          this.tenantContext.getPrincipal(),
          body,
        ),
        approvalFlow: null,
        supplements: NO_PURCHASE_REQUEST_SUPPLEMENTS,
      }),
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

  /**
   * Declared before `:purchaseRequestId`, so this literal segment is matched as a route and
   * never as a request identifier. Nest resolves routes in declaration order within a
   * controller, which is why both live here rather than in two controllers whose relative
   * order would depend on module import order.
   */
  @Get("awaiting-my-approval")
  @UseGuards(ApprovalRateLimitGuard)
  @ApiOperation({
    summary: "The caller's pending Manager approval queue",
    description:
      "FR-030. Requests in SUBMITTED, inside the caller's own Department, waiting on a Manager step. Requires the MANAGER role; ADMIN is not a bypass (AUTHZ-007). The organization comes from the access token and the department from the caller's persisted membership, so neither can be widened from the query string. The caller's own requests are excluded: BR-005 forbids them from deciding those.",
  })
  @ApiOkResponse({ type: PurchaseRequestApprovalQueueResponse })
  @ApiBadRequestResponse({
    description: "Page size out of range, unknown query parameter, or an unusable cursor.",
  })
  @ApiForbiddenResponse({
    description:
      "Authenticated, but the principal does not hold MANAGER. Names no resource, so it confirms nothing about what exists.",
  })
  @ApiNotFoundResponse({
    description:
      "The caller's own organization membership is no longer readable, so nothing is in scope.",
  })
  @ApiTooManyRequestsResponse({
    description:
      "SEC-006. The caller's address or account budget for this route is spent. Nothing is read.",
  })
  async listApprovalQueue(
    @Query() query: ListPurchaseRequestsQueryDto,
  ): Promise<PurchaseRequestApprovalQueueResponse> {
    return this.run(async () =>
      toPurchaseRequestApprovalQueueResponse(
        await this.listDepartmentApprovalQueue.execute(
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

  /**
   * Declared before `:purchaseRequestId` for the same reason as the queue above: a literal
   * segment must be matched as a route and never as a request identifier.
   */
  @Get("awaiting-quotation")
  @ApiOperation({
    summary: "The Buyer's quotation queue",
    description:
      "FR-040. Requests a Manager has approved into quotation and which are therefore waiting for quotes. Requires the BUYER role; ADMIN is not a bypass (AUTHZ-007). The boundary is the organization, not a Department: a Buyer runs quotation for the whole tenant (AUTHZ-004). Unlike the Manager queue this does not exclude the caller's own requests — BR-005 forbids deciding one's own request, not quoting it, and hiding those rows would conceal work from the person responsible for doing it.",
  })
  @ApiOkResponse({ type: PurchaseRequestPageResponse })
  @ApiBadRequestResponse({
    description: "Page size out of range, unknown query parameter, or an unusable cursor.",
  })
  @ApiForbiddenResponse({
    description: "Authenticated, but the principal does not hold BUYER. Names no resource.",
  })
  async listQuotationQueuePage(
    @Query() query: ListPurchaseRequestsQueryDto,
  ): Promise<PurchaseRequestPageResponse> {
    return this.run(async () =>
      toPurchaseRequestPageResponse(
        await this.listQuotationQueue.execute(
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
      "FR-026. The current state, the approval step the request is waiting on, and the full ordered step history with each decision's actor, reason, evaluated amount and timestamp. `approval` is null while the request is a DRAFT.",
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
      toPurchaseRequestResponse({
        request: await this.updateOwnPurchaseRequestDraft.execute(
          this.tenantContext.getPrincipal(),
          purchaseRequestId,
          body,
        ),
        approvalFlow: null,
        supplements: NO_PURCHASE_REQUEST_SUPPLEMENTS,
      }),
    );
  }

  @Post(":purchaseRequestId/submit")
  @HttpCode(HttpStatus.OK)
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description:
      "REL-004. An opaque token of 8 to 200 printable non-whitespace characters. Retrying with the same key replays the first result without transitioning again, without materializing a second approval flow and without a second audit event or outbox row; reusing it for a different request is a 409. Only a SHA-256 of the key is ever stored.",
  })
  @ApiOperation({
    summary: "Submit a DRAFT",
    description:
      "FR-023/FR-024. DRAFT to SUBMITTED, by the requester only. The transition, the Approval Flow's materialization (BR-001) against the computed total, and the audit event all commit in the same transaction — a request never has a status of SUBMITTED without its approval ladder.",
  })
  @ApiParam({ name: "purchaseRequestId", format: "uuid" })
  @ApiOkResponse({ type: PurchaseRequestResponse })
  @ApiNotFoundResponse({ description: "Unknown, foreign, or another requester's identifier." })
  @ApiBadRequestResponse({
    description: "A missing or malformed Idempotency-Key header.",
  })
  @ApiConflictResponse({
    description:
      "The current state does not permit submission, a concurrent transition won the race, or the idempotency key was reused for a different request.",
  })
  async submit(
    @Param("purchaseRequestId", new ParseUUIDPipe({ version: "4" }))
    purchaseRequestId: string,
    @IdempotencyKey() idempotencyKey: string | undefined,
  ): Promise<PurchaseRequestResponse> {
    return this.run(async () =>
      toPurchaseRequestResponse(
        await this.submitOwnPurchaseRequest.execute(
          this.tenantContext.getPrincipal(),
          purchaseRequestId,
          idempotencyKey,
        ),
      ),
    );
  }

  @Post(":purchaseRequestId/cancel")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Cancel the caller's own request",
    description:
      "FR-025 and BR-013. Permitted from DRAFT, SUBMITTED and IN_QUOTATION, the states reachable in this phase, and never once ORDERED. An unfinished approval flow is voided along with every step still awaiting a decision; decisions already recorded, and a flow that had already finished, are left exactly as they are (AUD-003).",
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

  @Post(":purchaseRequestId/approval-decision")
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApprovalRateLimitGuard)
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description:
      "REL-004. An opaque token of 8 to 200 printable non-whitespace characters. Retrying with the same key replays the first result without deciding again and without a second audit event or outbox row; reusing it for a different request is a 409. Only a SHA-256 of the key is ever stored.",
  })
  @ApiOperation({
    summary: "Decide the pending Manager approval step",
    description: [
      "FR-031/FR-032. Approving moves the request SUBMITTED -> IN_QUOTATION; rejecting moves",
      "it to REJECTED, which is terminal (BR-004). The decision is final: there is no",
      "un-approve and no second decision (BR-006).",
      "",
      "Only the step the flow is currently waiting on can be decided, and only by a principal",
      "holding the role that step is assigned to (AUTHZ-006). A Purchasing or Finance step is",
      "never actionable here — BR-002 evaluates those against the selected quote total.",
      "",
      "403 is returned for a capability denial (no MANAGER role) and for self-approval",
      "(BR-005), and names no resource. 404 covers an unknown identifier, another tenant's and",
      "another department's alike, so none of them can be told apart (MT-004, AUTHZ-004).",
      "409 means there was nothing actionable to decide, or a concurrent decision won the",
      "race; the loser writes nothing at all.",
    ].join(" "),
  })
  @ApiParam({ name: "purchaseRequestId", format: "uuid" })
  @ApiOkResponse({ type: PurchaseRequestResponse })
  @ApiBadRequestResponse({
    description: "Malformed payload, an unknown decision, or a disallowed field.",
  })
  @ApiForbiddenResponse({
    description:
      "The principal does not hold MANAGER, or is the requester of this request (BR-005). Nothing is written.",
  })
  @ApiNotFoundResponse({
    description:
      "Unknown, another tenant's, or another department's identifier — indistinguishable by design.",
  })
  @ApiConflictResponse({
    description:
      "No Manager step is awaiting a decision, or a concurrent decision already made one.",
  })
  @ApiUnprocessableEntityResponse({
    description:
      "A rejection without a reason of at least 10 non-whitespace characters, or a blank approval reason.",
  })
  @ApiTooManyRequestsResponse({
    description:
      "SEC-006. The caller's address or account budget for this route is spent. No decision, transition, flow change or audit event is written.",
  })
  async decideApproval(
    @Param("purchaseRequestId", new ParseUUIDPipe({ version: "4" }))
    purchaseRequestId: string,
    @Body() body: ApprovalDecisionDto,
    @IdempotencyKey() idempotencyKey: string | undefined,
  ): Promise<PurchaseRequestResponse> {
    return this.run(async () =>
      toPurchaseRequestResponse(
        await this.decidePurchaseRequestApproval.execute(
          this.tenantContext.getPrincipal(),
          purchaseRequestId,
          { ...body, idempotencyKey },
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
      // REL-004's failures answer identically on every route that requires a key.
      rethrowIdempotencyFailure(error);

      if (
        error instanceof PurchaseRequestNotFoundError ||
        // The principal's own membership is gone — deactivated or removed between
        // authentication and this read. Nothing of theirs is reachable, so it is a 404 for
        // the same reason as above, not a hint that something exists.
        error instanceof CurrentOrganizationContextNotFoundError
      ) {
        throw new NotFoundException();
      }

      if (
        error instanceof PurchaseRequestActionNotAuthorizedError ||
        error instanceof ApprovalActionNotAuthorizedError
      ) {
        // AUTHZ-003. Distinct from 404 on purpose: this names no resource, so it confirms
        // nothing about what exists. The message says the capability is missing, never which
        // role would grant it.
        throw new ForbiddenException("Not allowed to perform this action");
      }

      if (error instanceof SelfApprovalNotAllowedError) {
        // BR-005. Deliberately not a 404: the caller raised this request, so the refusal
        // discloses nothing they did not already know, and hiding the rule would leave them
        // unable to understand why their decision was refused.
        throw new ForbiddenException(error.message);
      }

      if (error instanceof InvalidPaginationCursorError) {
        throw new BadRequestException(error.message);
      }

      if (
        error instanceof PurchaseRequestValidationError ||
        error instanceof ApprovalDecisionValidationError
      ) {
        // Well-formed JSON that a domain rule refuses, as opposed to a malformed payload the
        // ValidationPipe already answered with 400.
        throw new UnprocessableEntityException(error.message);
      }

      if (
        error instanceof PurchaseRequestTransitionNotAllowedError ||
        error instanceof PurchaseRequestConcurrentlyModifiedError ||
        error instanceof ApprovalStepNotActionableError
      ) {
        throw new ConflictException(error.message);
      }

      throw error;
    }
  }
}

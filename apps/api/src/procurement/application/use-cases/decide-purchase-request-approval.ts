import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import { GetCurrentOrganizationContext } from "../../../identity-access/application/use-cases/get-current-organization-context";
import { ApprovalStepNotActionableError } from "../../../approval/application/contracts/approval.errors";
import type { ApprovalStepRecord } from "../../../approval/application/contracts/approval-flow.repository";
import {
  APPROVAL_STEP_SCOPE,
  assertMayDecideAnyApprovalStep,
  assertMayDecideApprovalStep,
  assertNotSelfApproval,
} from "../../../approval/application/support/approval-authorization";
import { normalizeApprovalDecisionReason } from "../../../approval/application/support/approval-decision";
import type { ApprovalDecision } from "../../../approval/application/support/approval-step-state";
import { DecideActionableApprovalStep } from "../../../approval/application/use-cases/decide-actionable-approval-step";
import { GetActionableApprovalStep } from "../../../approval/application/use-cases/get-actionable-approval-step";
import { GetApprovalFlowForRequest } from "../../../approval/application/use-cases/get-approval-flow-for-request";
import { RecordAuditEvent } from "../../../audit/application/use-cases/record-audit-event";
import { ExecuteIdempotently } from "../../../platform/idempotency/application/use-cases/execute-idempotently";
import type { IdempotencyOutcome } from "../../../platform/idempotency/application/contracts/idempotent-operation";
import { RecordOutgoingEvent } from "../../../platform/outbox/application/use-cases/record-outgoing-event";
import {
  PurchaseRequestConcurrentlyModifiedError,
  PurchaseRequestNotFoundError,
  PurchaseRequestTransitionNotAllowedError,
} from "../contracts/purchase-request.errors";
import {
  PURCHASE_REQUEST_REPOSITORY,
  type PurchaseRequestRecord,
  type PurchaseRequestRepository,
} from "../contracts/purchase-request.repository";
import type { PurchaseRequestView } from "../contracts/purchase-request-view";
import {
  decidableStatusesForStepRole,
  purchaseRequestStatusAfterApprovalDecision,
} from "../support/purchase-request-approval";
import { approvalStepDecidedPayload } from "../support/purchase-request-audit";
import { purchaseRequestApprovalDecidedEventPayload } from "../support/purchase-request-events";
import { isApprovalTransitionAllowed } from "../support/purchase-request-status";
import { ReadPurchaseRequestSupplements } from "./read-purchase-request-supplements";

export interface PurchaseRequestApprovalDecisionInput {
  readonly decision: ApprovalDecision;
  readonly reason?: string;
  /** REL-004. The raw header value, hashed immediately and never stored or logged. */
  readonly idempotencyKey: string | undefined;
}

/**
 * FR-031, FR-034 and FR-036: whoever the ladder is currently waiting on decides the step, and
 * the decision is final (BR-006).
 *
 * **The step's responsibility is authoritative, not the caller's role.** The flow is waiting on
 * exactly one step; that step names a responsibility; the principal is then checked against it
 * (AUTHZ-006). The reverse — letting a caller say which of their roles they are acting as —
 * would let someone holding both MANAGER and BUYER pick whichever rung happened to be
 * available. It also removes the need for a separate route per responsibility, and for the
 * client to know which one it should be calling.
 *
 * The checks run in the order that leaks least, and each answers a different question:
 *
 * 1. **Any decision capability at all** (403), before a single read. A principal holding none of
 *    MANAGER, BUYER or FINANCE learns nothing — not even whether the identifier exists — and
 *    costs nothing (AUTHZ-003). ADMIN alone is not one of the three (AUTHZ-007).
 * 2. **Scope** (404). The request is read under the narrowest scope this principal could ever
 *    act in: their own Department when they hold only MANAGER, the organization when they hold
 *    BUYER or FINANCE, whom the requirements put at organization scope (AUTHZ-004). An unknown
 *    identifier, another tenant's and — for a manager — another department's are one answer
 *    (MT-004).
 * 3. **Something to decide** (409). The step the ladder is waiting on, whatever its
 *    responsibility.
 * 4. **The step's own capability** (403). Holding MANAGER does not let anyone decide a Finance
 *    rung.
 * 5. **The boundary the read could not settle** (404). A principal read at organization scope
 *    because they hold BUYER may still be facing a Manager rung, which has to be inside their
 *    own Department (BR-042).
 * 6. **Segregation of duties** (403). BR-005: the requester never decides their own request,
 *    whatever roles they hold, on any rung.
 * 7. **Reason** (422). FR-031's ten-character minimum for a rejection.
 * 8. **State** (409). A pre-check for a useful message only; the writes are what guarantee it.
 *
 * Then one transaction does the whole change: the idempotency reservation, the step's
 * conditional decision, the promotion of whatever comes next, the request's conditional
 * transition, the audit event and the outgoing intent. Any of them failing throws, which rolls
 * all of them back (REL-001, AUD-004).
 *
 * Two approvers deciding at once therefore produce exactly one decision, one transition, one
 * audit event and one outgoing intent: the second `UPDATE` re-checks `state = ACTIONABLE`
 * under the row lock the first took, matches nothing, and takes its whole transaction down
 * with it (REL-005). A retried request carrying the same Idempotency-Key produces none of
 * them a second time (REL-004).
 */
/**
 * AUTHZ-004. Which scope this principal's request read has to use.
 *
 * A Buyer or a Finance user acts for the whole organization, so their read is tenant-wide. A
 * principal who holds only MANAGER acts for one Department, and reading tenant-wide would let
 * them tell "exists but outside my department" from "does not exist" through the difference
 * between a 409 and a 404.
 */
function organizationScopedDecider(principal: TrustedPrincipal): boolean {
  return principal.roles.includes("BUYER") || principal.roles.includes("FINANCE");
}

@Injectable()
export class DecidePurchaseRequestApproval {
  constructor(
    @Inject(PURCHASE_REQUEST_REPOSITORY)
    private readonly purchaseRequests: PurchaseRequestRepository,
    // identity-access owns the User table (ADR-001); the decider's own department is read
    // through its published interface rather than by querying users from here.
    private readonly getCurrentOrganizationContext: GetCurrentOrganizationContext,
    private readonly getActionableApprovalStep: GetActionableApprovalStep,
    private readonly decideActionableApprovalStep: DecideActionableApprovalStep,
    private readonly getApprovalFlowForRequest: GetApprovalFlowForRequest,
    private readonly readPurchaseRequestSupplements: ReadPurchaseRequestSupplements,
    private readonly recordAuditEvent: RecordAuditEvent,
    private readonly recordOutgoingEvent: RecordOutgoingEvent,
    private readonly executeIdempotently: ExecuteIdempotently,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    purchaseRequestId: string,
    input: PurchaseRequestApprovalDecisionInput,
  ): Promise<PurchaseRequestView> {
    // Before any read. A principal who holds no decision-making role at all learns nothing —
    // not even whether the identifier exists — and costs nothing (AUTHZ-003).
    assertMayDecideAnyApprovalStep(principal);

    // FR-031's reason rule depends only on the payload, so it is settled here: the normalized
    // text is part of the semantic fingerprint below, and a malformed one should be a 422
    // rather than something a key could ever replay.
    const decisionReason = normalizeApprovalDecisionReason(
      input.decision,
      input.reason,
    );

    // REL-004 wraps everything that depends on state, including the "is a step actionable?"
    // check. A retry necessarily arrives after the rung it decided has been decided, so a
    // pre-check would answer 409 to exactly the case the key exists to make safe.
    //
    // The fingerprint is deliberately the *intent* — this request, this decision, this reason —
    // and not the step's identifier, which changes the moment the decision commits and would
    // make every replay look like a different request.
    return this.executeIdempotently.execute(
      principal,
      {
        operation: "APPROVAL_DECISION",
        idempotencyKey: input.idempotencyKey,
        fingerprintParts: [
          purchaseRequestId,
          input.decision,
          decisionReason ?? "",
        ],
      },
      {
        run: (scope) =>
          this.authorizeAndDecide(principal, scope, {
            purchaseRequestId,
            decision: input.decision,
            decisionReason,
          }),
        // The same scoped read the original call's authorization passed, so a retry sees
        // exactly what the first request could — and writes nothing.
        replay: () =>
          this.readRequestInReachableScope(principal, purchaseRequestId),
      },
    ).then((request) => this.toView(principal, request));
  }

  /**
   * The state-dependent half, run inside the idempotent transaction so that everything it
   * refuses — a 404, a 403, a 409 — rolls the reservation back with it and leaves the key
   * usable.
   *
   * The order is the one that leaks least; see the class comment.
   */
  private async authorizeAndDecide(
    principal: TrustedPrincipal,
    scope: TransactionScope,
    input: {
      readonly purchaseRequestId: string;
      readonly decision: ApprovalDecision;
      readonly decisionReason: string | null;
    },
  ): Promise<{
    readonly value: PurchaseRequestRecord;
    readonly outcome: IdempotencyOutcome;
  }> {
    const existing = await this.readRequestInReachableScope(
      principal,
      input.purchaseRequestId,
    );
    const actionableStep = await this.getActionableApprovalStep.execute({
      organizationId: principal.organizationId,
      purchaseRequestId: input.purchaseRequestId,
    });

    if (actionableStep === null) {
      // The ladder is not waiting on anything: it is finished, the request was cancelled, or
      // the next rung is still PENDING behind BR-003's re-evaluation. The caller can see the
      // request's own state through its own routes, so this discloses nothing new.
      throw new ApprovalStepNotActionableError();
    }

    // The step names the responsibility; the principal is checked against *that*. Holding
    // MANAGER does not let anyone decide a Finance step (AUTHZ-006).
    assertMayDecideApprovalStep(principal, actionableStep.role);

    const departmentId = await this.assertWithinResponsibilityBoundary(
      principal,
      existing,
      actionableStep,
    );

    assertNotSelfApproval(principal, existing.requesterId);

    const decidableStatuses = decidableStatusesForStepRole(actionableStep.role);

    if (!decidableStatuses.includes(existing.status)) {
      throw new PurchaseRequestTransitionNotAllowedError(
        existing.status,
        "decided",
      );
    }

    return this.decide(principal, {
      scope,
      purchaseRequestId: input.purchaseRequestId,
      actionableStep,
      decision: input.decision,
      decisionReason: input.decisionReason,
      departmentId,
    });
  }

  /**
   * MT-004 and AUTHZ-004, in the order that leaks least.
   *
   * The request is read under the **narrowest scope this principal could ever act in**: a
   * department for someone who only holds MANAGER, the organization for a Buyer or a Finance
   * user, whose responsibilities the requirements put at organization scope. That is what keeps
   * an unknown identifier, another tenant's and another department's a single 404 for a
   * manager — including the case where the request exists but its ladder is not waiting on
   * anything, which would otherwise answer 409 and quietly confirm the request's existence.
   */
  private async readRequestInReachableScope(
    principal: TrustedPrincipal,
    purchaseRequestId: string,
  ): Promise<PurchaseRequestRecord> {
    const request = organizationScopedDecider(principal)
      ? await this.purchaseRequests.findOrganizationRequest({
          organizationId: principal.organizationId,
          purchaseRequestId,
        })
      : await this.purchaseRequests.findDepartmentRequest({
          organizationId: principal.organizationId,
          departmentId: await this.decidersDepartmentId(principal),
          purchaseRequestId,
        });

    if (request === null) {
      throw new PurchaseRequestNotFoundError();
    }

    return request;
  }

  /**
   * AUTHZ-004's second half, for the case the read above could not settle: a principal who
   * holds BUYER or FINANCE is read at organization scope, so a Manager rung they are also
   * eligible for still has to be inside their own Department.
   *
   * Returns the department to restate inside the conditional write for a Manager decision, and
   * `undefined` for an organization-scoped one — where a department predicate would not widen
   * the write, it would wrongly narrow it.
   */
  private async assertWithinResponsibilityBoundary(
    principal: TrustedPrincipal,
    request: PurchaseRequestRecord,
    step: ApprovalStepRecord,
  ): Promise<string | undefined> {
    if (APPROVAL_STEP_SCOPE[step.role] === "ORGANIZATION") {
      return undefined;
    }

    const departmentId = await this.decidersDepartmentId(principal);

    if (request.departmentId !== departmentId) {
      // BR-042: the boundary is the request's own persisted department, never the requester's
      // current profile, which may have moved since.
      throw new PurchaseRequestNotFoundError();
    }

    return departmentId;
  }

  /**
   * identity-access owns the User table (ADR-001); the decider's own department is read through
   * its published interface rather than by querying users from here.
   */
  private async decidersDepartmentId(
    principal: TrustedPrincipal,
  ): Promise<string> {
    const context = await this.getCurrentOrganizationContext.execute(principal);

    return context.membership.department.id;
  }

  private async decide(
    principal: TrustedPrincipal,
    input: {
      readonly scope: TransactionScope;
      readonly purchaseRequestId: string;
      readonly actionableStep: ApprovalStepRecord;
      readonly decision: ApprovalDecision;
      readonly decisionReason: string | null;
      /** Present only for a Manager decision; organization-scoped rungs have no department. */
      readonly departmentId: string | undefined;
    },
  ): Promise<{
    readonly value: PurchaseRequestRecord;
    readonly outcome: IdempotencyOutcome;
  }> {
    const decidedAt = new Date();
    const decided = await this.decideActionableApprovalStep.execute(
      input.scope,
      {
        organizationId: principal.organizationId,
        purchaseRequestId: input.purchaseRequestId,
        approvalStepId: input.actionableStep.id,
        role: input.actionableStep.role,
        decision: input.decision,
        decisionReason: input.decisionReason,
        decidedById: principal.userId,
        decidedAt,
      },
    );

    if (decided === null) {
      throw new ApprovalStepNotActionableError();
    }

    const toStatus = purchaseRequestStatusAfterApprovalDecision({
      stepRole: decided.step.role,
      decision: input.decision,
      flowState: decided.flowState,
    });

    const permittedFromStatuses = decidableStatusesForStepRole(decided.step.role);

    // AUTHZ-005, checked rather than assumed. The mapping above only produces edges the state
    // machine declares, so this is unreachable through this application — but a status written
    // by anything other than a declared edge is precisely the defect the two tables exist to
    // prevent, and the check costs one array pass.
    if (
      toStatus !== null &&
      !permittedFromStatuses.every((from) =>
        isApprovalTransitionAllowed(from, toStatus),
      )
    ) {
      throw new PurchaseRequestTransitionNotAllowedError(
        permittedFromStatuses[0] ?? "SUBMITTED",
        "decided",
      );
    }

    const transitioned = await this.purchaseRequests.applyApprovalDecision(
      input.scope,
      {
        organizationId: principal.organizationId,
        // AUTHZ-004. Restated inside the write for a Manager decision, and deliberately absent
        // for an organization-scoped one: the responsibility boundary is part of the predicate
        // that decides the row, and Buyer and Finance simply have a different one.
        ...(input.departmentId === undefined
          ? {}
          : { departmentId: input.departmentId }),
        purchaseRequestId: input.purchaseRequestId,
        fromStatuses: permittedFromStatuses,
        toStatus,
      },
    );

    if (transitioned === null) {
      throw new PurchaseRequestConcurrentlyModifiedError();
    }

    await this.recordAuditEvent.execute(input.scope, principal, {
      eventType:
        input.decision === "APPROVED"
          ? "APPROVAL_STEP_APPROVED"
          : "APPROVAL_STEP_REJECTED",
      aggregateType: "PURCHASE_REQUEST",
      aggregateId: transitioned.id,
      occurredAt: decidedAt,
      payload: approvalStepDecidedPayload({
        step: decided.step,
        approvalFlowState: decided.flowState,
        resultingStatus: transitioned.status,
      }),
    });

    await this.recordOutgoingEvent.execute(input.scope, principal, {
      eventType: "PURCHASE_REQUEST_APPROVAL_DECIDED",
      aggregateType: "PURCHASE_REQUEST",
      aggregateId: transitioned.id,
      occurredAt: decidedAt,
      // Deliberately without the decision reason the audit payload above carries: free text a
      // decision maker wrote about a colleague's request stays in tenant-scoped storage.
      payload: purchaseRequestApprovalDecidedEventPayload({
        step: decided.step,
        approvalFlowState: decided.flowState,
        resultingStatus: transitioned.status,
        requesterId: transitioned.requesterId,
        decidedById: principal.userId,
      }),
    });

    return {
      value: transitioned,
      // REL-004. Identifiers and one enum: enough to replay the semantic answer through the
      // authorized read below, and nothing a client could not already see.
      outcome: {
        purchaseRequestId: transitioned.id,
        status: transitioned.status,
        approvalStepId: decided.step.id,
        decision: decided.step.state,
      },
    };
  }

  private async toView(
    principal: TrustedPrincipal,
    request: PurchaseRequestRecord,
  ): Promise<PurchaseRequestView> {
    const [approvalFlow, supplements] = await Promise.all([
      this.getApprovalFlowForRequest.execute({
        organizationId: principal.organizationId,
        purchaseRequestId: request.id,
      }),
      this.readPurchaseRequestSupplements.execute(
        principal.organizationId,
        request,
      ),
    ]);

    return { request, approvalFlow, supplements };
  }
}

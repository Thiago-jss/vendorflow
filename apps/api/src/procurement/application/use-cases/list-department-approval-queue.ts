import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import { GetCurrentOrganizationContext } from "../../../identity-access/application/use-cases/get-current-organization-context";
import { assertMayDecideApprovalStep } from "../../../approval/application/support/approval-authorization";
import { ListActionableApprovalSteps } from "../../../approval/application/use-cases/list-actionable-approval-steps";
import {
  PURCHASE_REQUEST_REPOSITORY,
  type PurchaseRequestListCursor,
  type PurchaseRequestRepository,
} from "../contracts/purchase-request.repository";
import type {
  PurchaseRequestApprovalQueueItem,
  PurchaseRequestApprovalQueuePage,
} from "../contracts/purchase-request-view";
import { MANAGER_APPROVAL_STEP_ROLE } from "../support/purchase-request-approval";
import { MANAGER_DECIDABLE_STATUSES } from "../support/purchase-request-status";
import {
  DEFAULT_PURCHASE_REQUEST_PAGE_SIZE,
  MAXIMUM_PURCHASE_REQUEST_PAGE_SIZE,
} from "./list-own-purchase-requests";

export interface ListDepartmentApprovalQueueInput {
  readonly limit?: number;
  readonly after?: PurchaseRequestListCursor | null;
}

/**
 * FR-030. The requests a Manager is responsible for deciding: `SUBMITTED`, inside their own
 * Department, waiting on a Manager step.
 *
 * The boundary is not a filter applied to a wider result. `organizationId` comes from the
 * trusted principal and the department from the principal's persisted membership, and both
 * are in the database predicate — so a request outside the boundary is never read, and the
 * queue cannot be widened from the query string (AUTHZ-004, MT-003).
 *
 * BR-005 is applied here too: a manager's own request is excluded, because a queue of work
 * they are forbidden to do is not a queue. It is excluded in the predicate rather than after
 * the page is built, so paging stays honest.
 *
 * The two halves are read from the two modules that own them (ADR-001 rule 2): the requests
 * from `procurement`, the actionable steps from `approval`. Both reads carry the tenant.
 */
@Injectable()
export class ListDepartmentApprovalQueue {
  constructor(
    @Inject(PURCHASE_REQUEST_REPOSITORY)
    private readonly purchaseRequests: PurchaseRequestRepository,
    private readonly getCurrentOrganizationContext: GetCurrentOrganizationContext,
    private readonly listActionableApprovalSteps: ListActionableApprovalSteps,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    input: ListDepartmentApprovalQueueInput = {},
  ): Promise<PurchaseRequestApprovalQueuePage> {
    assertMayDecideApprovalStep(principal, MANAGER_APPROVAL_STEP_ROLE);

    const context = await this.getCurrentOrganizationContext.execute(principal);
    const requested = input.limit ?? DEFAULT_PURCHASE_REQUEST_PAGE_SIZE;
    const page = await this.purchaseRequests.listDepartmentRequests({
      organizationId: principal.organizationId,
      departmentId: context.membership.department.id,
      statuses: MANAGER_DECIDABLE_STATUSES,
      excludingRequesterId: principal.userId,
      limit: Math.min(
        Math.max(requested, 1),
        MAXIMUM_PURCHASE_REQUEST_PAGE_SIZE,
      ),
      after: input.after ?? null,
    });
    const pendingSteps = await this.listActionableApprovalSteps.execute({
      organizationId: principal.organizationId,
      purchaseRequestIds: page.items.map((summary) => summary.id),
      role: MANAGER_APPROVAL_STEP_ROLE,
    });

    const items = page.items.reduce<PurchaseRequestApprovalQueueItem[]>(
      (queue, request) => {
        const pendingStep = pendingSteps.get(request.id);

        // A SUBMITTED request always has an actionable Manager step in this phase, because
        // both are written by the same transaction. Skipping the row rather than asserting
        // keeps a future phase's flow shape from turning this queue into a 500.
        return pendingStep === undefined
          ? queue
          : [...queue, { request, pendingStep }];
      },
      [],
    );

    return { items, nextCursor: page.nextCursor };
  }
}

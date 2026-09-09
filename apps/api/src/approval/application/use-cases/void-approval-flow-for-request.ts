import { Inject, Injectable } from "@nestjs/common";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import {
  APPROVAL_FLOW_REPOSITORY,
  type ApprovalFlowRepository,
  type FindApprovalFlowCriteria,
} from "../contracts/approval-flow.repository";

/**
 * FR-025. A cancelled request has nothing left to approve, so its unfinished flow and every
 * undecided step become non-actionable — `VOIDED`, an explicit terminal state.
 *
 * Nothing is deleted. A decision already recorded stays exactly as it was recorded, and a
 * step that will now never be decided says so rather than disappearing (AUD-003). A flow that
 * had already finished is left alone: cancelling a request does not un-decide the approvals
 * that got it there.
 */
@Injectable()
export class VoidApprovalFlowForRequest {
  constructor(
    @Inject(APPROVAL_FLOW_REPOSITORY)
    private readonly approvalFlows: ApprovalFlowRepository,
  ) {}

  execute(
    scope: TransactionScope,
    criteria: FindApprovalFlowCriteria,
  ): Promise<number> {
    return this.approvalFlows.voidUnfinished(scope, criteria);
  }
}

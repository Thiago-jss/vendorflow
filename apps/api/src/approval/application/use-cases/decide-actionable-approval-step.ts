import { Inject, Injectable } from "@nestjs/common";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import {
  APPROVAL_FLOW_REPOSITORY,
  type ApprovalFlowRepository,
  type DecideActionableStepInput,
  type DecidedApprovalStepRecord,
} from "../contracts/approval-flow.repository";

/**
 * FR-031/BR-006. Records one final decision against the step a flow is currently waiting on.
 *
 * It returns `null` rather than throwing when nothing was decided, because "no actionable
 * step of this responsibility" and "someone else decided it half a millisecond ago" are the
 * same answer from here: the conditional write matched no row. The caller turns that into a
 * conflict, and — because it happens inside the caller's transaction — nothing else it wrote
 * survives either.
 */
@Injectable()
export class DecideActionableApprovalStep {
  constructor(
    @Inject(APPROVAL_FLOW_REPOSITORY)
    private readonly approvalFlows: ApprovalFlowRepository,
  ) {}

  execute(
    scope: TransactionScope,
    input: DecideActionableStepInput,
  ): Promise<DecidedApprovalStepRecord | null> {
    return this.approvalFlows.decideActionableStep(scope, input);
  }
}

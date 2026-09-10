import { Inject, Injectable } from "@nestjs/common";
import {
  APPROVAL_FLOW_REPOSITORY,
  type ApprovalFlowRepository,
  type ApprovalStepRecord,
  type FindApprovalFlowCriteria,
} from "../contracts/approval-flow.repository";

/**
 * AUTHZ-006/FR-035. The step a request's flow is currently waiting on.
 *
 * This is what makes the *step* authoritative rather than the caller: the responsibility that
 * may act is read from the ladder, and the principal is then checked against it. The reverse —
 * a caller declaring which responsibility they are acting as — would let a person holding two
 * roles pick whichever one the flow happened to be waiting on.
 *
 * The read is tenant-scoped and knows nothing about ownership or department, so it is never
 * the only check standing between a caller and a request.
 */
@Injectable()
export class GetActionableApprovalStep {
  constructor(
    @Inject(APPROVAL_FLOW_REPOSITORY)
    private readonly approvalFlows: ApprovalFlowRepository,
  ) {}

  execute(
    criteria: FindApprovalFlowCriteria,
  ): Promise<ApprovalStepRecord | null> {
    return this.approvalFlows.findActionableStep(criteria);
  }
}

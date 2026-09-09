import { Inject, Injectable } from "@nestjs/common";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import {
  APPROVAL_FLOW_REPOSITORY,
  type ApprovalFlowRecord,
  type ApprovalFlowRepository,
  type MaterializeApprovalFlowInput,
} from "../contracts/approval-flow.repository";

/**
 * FR-024. Materializes the whole BR-001 ladder for a request that has just been submitted.
 *
 * It takes the transaction its caller opened rather than opening one: the flow and the
 * `DRAFT → SUBMITTED` transition are one fact, and a submitted request without its approval
 * flow is a request nobody can act on (REL-001).
 */
@Injectable()
export class MaterializeApprovalFlow {
  constructor(
    @Inject(APPROVAL_FLOW_REPOSITORY)
    private readonly approvalFlows: ApprovalFlowRepository,
  ) {}

  execute(
    scope: TransactionScope,
    input: MaterializeApprovalFlowInput,
  ): Promise<ApprovalFlowRecord> {
    return this.approvalFlows.materialize(scope, input);
  }
}

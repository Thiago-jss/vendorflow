import { Inject, Injectable } from "@nestjs/common";
import {
  APPROVAL_FLOW_REPOSITORY,
  type ApprovalFlowRecord,
  type ApprovalFlowRepository,
  type FindApprovalFlowCriteria,
} from "../contracts/approval-flow.repository";

/**
 * FR-026's approval half: the flow of one request, with its steps in order.
 *
 * It answers `null` for a request that has no flow — a DRAFT — rather than an empty flow.
 * The caller is responsible for having established that it may see the request at all; this
 * read is tenant-scoped and knows nothing about ownership, so it is never the only check
 * standing between a caller and a request.
 */
@Injectable()
export class GetApprovalFlowForRequest {
  constructor(
    @Inject(APPROVAL_FLOW_REPOSITORY)
    private readonly approvalFlows: ApprovalFlowRepository,
  ) {}

  execute(
    criteria: FindApprovalFlowCriteria,
  ): Promise<ApprovalFlowRecord | null> {
    return this.approvalFlows.findByPurchaseRequest(criteria);
  }
}

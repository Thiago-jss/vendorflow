import { Inject, Injectable } from "@nestjs/common";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import {
  APPROVAL_FLOW_REPOSITORY,
  type ApprovalFlowRepository,
  type ReevaluateApprovalFlowInput,
  type ReevaluatedApprovalFlowRecord,
} from "../contracts/approval-flow.repository";

/**
 * BR-003. The `approval` module's published answer to "a quote was selected; what does the
 * ladder look like now?".
 *
 * It exists so `quotation` can cause an approval flow to change without ever writing to the
 * approval tables (ADR-001 rule 2). It takes the caller's `TransactionScope` rather than
 * opening one, because the re-evaluation, the quote's selection, the request's transition and
 * the audit event are one fact: a ladder that grew a Finance step for a quote that was never
 * selected is exactly the state REL-001 forbids.
 *
 * It returns `null` for a request with no flow. That is not a normal outcome — every request
 * in IN_QUOTATION was submitted, and submission materializes a flow — so the caller treats it
 * as a conflict rather than as "nothing to do".
 */
@Injectable()
export class ReevaluateApprovalFlow {
  constructor(
    @Inject(APPROVAL_FLOW_REPOSITORY)
    private readonly approvalFlows: ApprovalFlowRepository,
  ) {}

  execute(
    scope: TransactionScope,
    input: ReevaluateApprovalFlowInput,
  ): Promise<ReevaluatedApprovalFlowRecord | null> {
    return this.approvalFlows.reevaluateForSelectedQuote(scope, input);
  }
}

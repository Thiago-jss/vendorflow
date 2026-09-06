import { Inject, Injectable } from "@nestjs/common";
import {
  APPROVAL_FLOW_REPOSITORY,
  type ApprovalFlowRepository,
  type ApprovalStepRecord,
  type ListActionableStepsCriteria,
} from "../contracts/approval-flow.repository";

/**
 * FR-030's approval half: of these requests, which ones are waiting on a step of this
 * responsibility, and which step.
 *
 * The caller supplies the requests — already narrowed to its tenant and to the boundary the
 * actor is responsible for — and this adds the step. Splitting it that way keeps each module
 * querying only the tables it owns (ADR-001 rule 2) while leaving the tenant predicate on
 * both halves.
 */
@Injectable()
export class ListActionableApprovalSteps {
  constructor(
    @Inject(APPROVAL_FLOW_REPOSITORY)
    private readonly approvalFlows: ApprovalFlowRepository,
  ) {}

  async execute(
    criteria: ListActionableStepsCriteria,
  ): Promise<ReadonlyMap<string, ApprovalStepRecord>> {
    if (criteria.purchaseRequestIds.length === 0) {
      return new Map();
    }

    const steps = await this.approvalFlows.listActionableSteps(criteria);

    return new Map(steps.map((step) => [step.purchaseRequestId, step]));
  }
}

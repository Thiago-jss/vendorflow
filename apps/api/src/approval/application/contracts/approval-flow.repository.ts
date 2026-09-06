import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import type { ApprovalStepRole } from "../support/approval-policy";
import type {
  ApprovalDecision,
  ApprovalFlowState,
  ApprovalStepState,
} from "../support/approval-step-state";

export const APPROVAL_FLOW_REPOSITORY = Symbol("APPROVAL_FLOW_REPOSITORY");

export interface ApprovalStepRecord {
  readonly id: string;
  readonly approvalFlowId: string;
  readonly purchaseRequestId: string;
  readonly sequence: number;
  readonly role: ApprovalStepRole;
  readonly state: ApprovalStepState;
  /** FR-036. The amount this step was evaluated against, in exact centavos. */
  readonly evaluatedAmountCents: bigint;
  readonly decidedById: string | null;
  readonly decidedAt: Date | null;
  readonly decisionReason: string | null;
}

export interface ApprovalFlowRecord {
  readonly id: string;
  readonly purchaseRequestId: string;
  readonly state: ApprovalFlowState;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Ordered by sequence. The whole history, including voided steps (AUD-003, BR-003). */
  readonly steps: readonly ApprovalStepRecord[];
}

export interface MaterializeApprovalFlowInput {
  readonly organizationId: string;
  readonly purchaseRequestId: string;
  /** BR-002: the estimated total at submission. Every materialized step records it. */
  readonly evaluatedAmountCents: bigint;
}

export interface FindApprovalFlowCriteria {
  readonly organizationId: string;
  readonly purchaseRequestId: string;
}

export interface DecideActionableStepInput extends FindApprovalFlowCriteria {
  readonly role: ApprovalStepRole;
  readonly decision: ApprovalDecision;
  readonly decisionReason: string | null;
  readonly decidedById: string;
  readonly decidedAt: Date;
}

export interface DecidedApprovalStepRecord {
  readonly step: ApprovalStepRecord;
  readonly flowState: ApprovalFlowState;
}

export interface ListActionableStepsCriteria {
  readonly organizationId: string;
  readonly purchaseRequestIds: readonly string[];
  readonly role: ApprovalStepRole;
}

/**
 * Persistence for the approval flow aggregate.
 *
 * Every method is scoped by construction (ADR-002): there is no read by flow or step
 * identifier alone and no optional `organizationId`. The mutating methods take a
 * `TransactionScope` because none of them is a business change on its own — a decided step
 * without its request transition and its audit event is exactly the state REL-001 forbids —
 * so they can only run inside a transaction someone else opened.
 *
 * `decideActionableStep` returns `null` when its conditional write matched no row. That is
 * the concurrency authority: the step's state is re-checked *inside* the UPDATE, never
 * before it.
 */
export interface ApprovalFlowRepository {
  materialize(
    scope: TransactionScope,
    input: MaterializeApprovalFlowInput,
  ): Promise<ApprovalFlowRecord>;

  findByPurchaseRequest(
    criteria: FindApprovalFlowCriteria,
  ): Promise<ApprovalFlowRecord | null>;

  listActionableSteps(
    criteria: ListActionableStepsCriteria,
  ): Promise<readonly ApprovalStepRecord[]>;

  decideActionableStep(
    scope: TransactionScope,
    input: DecideActionableStepInput,
  ): Promise<DecidedApprovalStepRecord | null>;

  /**
   * FR-025. Makes an unfinished flow and its undecided steps non-actionable, preserving every
   * decision already recorded. Returns the number of steps voided, which is zero for a
   * request that never had a flow.
   */
  voidUnfinished(
    scope: TransactionScope,
    criteria: FindApprovalFlowCriteria,
  ): Promise<number>;
}

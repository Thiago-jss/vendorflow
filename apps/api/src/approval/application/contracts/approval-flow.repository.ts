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
  /**
   * The step the caller authorized against, and the step the conditional UPDATE targets. It
   * is named explicitly rather than re-derived inside the write, so a step that became
   * actionable between the authorization read and this write is not decided by someone who
   * was authorized for a different responsibility.
   */
  readonly approvalStepId: string;
  /** Restated inside the predicate: the responsibility is part of what decides the row. */
  readonly role: ApprovalStepRole;
  readonly decision: ApprovalDecision;
  readonly decisionReason: string | null;
  readonly decidedById: string;
  readonly decidedAt: Date;
}

export interface DecidedApprovalStepRecord {
  readonly step: ApprovalStepRecord;
  readonly flowState: ApprovalFlowState;
  /**
   * FR-035. The rung this decision handed the ladder on to, or `null` when the flow finished,
   * was rejected, or is waiting for BR-003's re-evaluation to decide what comes next.
   */
  readonly promotedStep: ApprovalStepRecord | null;
}

/**
 * BR-003. What a selected quote total does to a flow materialized from an estimate.
 *
 * The amount is the selected quote's total, and it arrives from the module that owns the
 * quote — `quotation` — through a published operation, inside the same transaction as the
 * selection itself. There is no overload that re-evaluates a flow outside a transaction: an
 * approval ladder that changed without its quote selection is exactly the state REL-001
 * forbids.
 */
export interface ReevaluateApprovalFlowInput extends FindApprovalFlowCriteria {
  readonly selectedTotalCents: bigint;
}

export interface ReevaluatedApprovalFlowRecord {
  readonly flow: ApprovalFlowRecord;
  /** False when the selected tier asks for exactly the ladder that already existed. */
  readonly changed: boolean;
  readonly voidedStepCount: number;
  readonly repricedStepCount: number;
  readonly appendedStepRoles: readonly ApprovalStepRole[];
  /** The step now awaiting a decision, or `null` when nothing is left to decide. */
  readonly actionableStep: ApprovalStepRecord | null;
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

  /**
   * FR-035/AUTHZ-006. The single step a request's flow is currently waiting on, whatever its
   * responsibility. The role it carries is what the caller authorizes against: the step
   * decides who may act on it, not the other way round.
   */
  findActionableStep(
    criteria: FindApprovalFlowCriteria,
  ): Promise<ApprovalStepRecord | null>;

  decideActionableStep(
    scope: TransactionScope,
    input: DecideActionableStepInput,
  ): Promise<DecidedApprovalStepRecord | null>;

  reevaluateForSelectedQuote(
    scope: TransactionScope,
    input: ReevaluateApprovalFlowInput,
  ): Promise<ReevaluatedApprovalFlowRecord | null>;

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

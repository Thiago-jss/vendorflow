import { Injectable } from "@nestjs/common";
import { DatabaseService, Prisma } from "@vendorflow/database";
import { transactionClient } from "../../../platform/persistence/prisma-transaction-runner";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import type {
  ApprovalFlowRecord,
  ApprovalFlowRepository,
  ApprovalStepRecord,
  DecideActionableStepInput,
  DecidedApprovalStepRecord,
  FindApprovalFlowCriteria,
  ListActionableStepsCriteria,
  MaterializeApprovalFlowInput,
  ReevaluateApprovalFlowInput,
  ReevaluatedApprovalFlowRecord,
} from "../../application/contracts/approval-flow.repository";
import {
  requiredApprovalSteps,
  type ApprovalStepRole,
} from "../../application/support/approval-policy";
import {
  planApprovalFlowReevaluation,
  type ReevaluatedApprovalStep,
} from "../../application/support/approval-reevaluation";
import {
  UNDECIDED_APPROVAL_STEP_STATES,
  approvalFlowStateAfterDecision,
  materializeApprovalSteps,
  shouldPromoteNextStepAfterDecision,
} from "../../application/support/approval-step-state";
import {
  toApprovalFlowState,
  toApprovalStepRole,
  toApprovalStepState,
} from "./approval.mapper";

const STEP_SELECTION = {
  id: true,
  approvalFlowId: true,
  purchaseRequestId: true,
  sequence: true,
  role: true,
  state: true,
  evaluatedAmountCents: true,
  decidedById: true,
  decidedAt: true,
  decisionReason: true,
} satisfies Prisma.ApprovalStepSelect;

const FLOW_SELECTION = {
  id: true,
  purchaseRequestId: true,
  state: true,
  createdAt: true,
  updatedAt: true,
  steps: { orderBy: { sequence: "asc" }, select: STEP_SELECTION },
} satisfies Prisma.ApprovalFlowSelect;

type ApprovalStepRow = Prisma.ApprovalStepGetPayload<{
  select: typeof STEP_SELECTION;
}>;

type ApprovalFlowRow = Prisma.ApprovalFlowGetPayload<{
  select: typeof FLOW_SELECTION;
}>;

@Injectable()
export class PrismaApprovalFlowRepository implements ApprovalFlowRepository {
  constructor(private readonly database: DatabaseService) {}

  async materialize(
    scope: TransactionScope,
    input: MaterializeApprovalFlowInput,
  ): Promise<ApprovalFlowRecord> {
    const transaction = transactionClient(scope);
    const flow = await transaction.approvalFlow.create({
      data: {
        organizationId: input.organizationId,
        purchaseRequestId: input.purchaseRequestId,
      },
      select: { id: true },
    });

    // BR-001 decides the ladder; the sequence is this list's position and no client's field.
    // Exactly the first step is ACTIONABLE, which a partial unique index makes an invariant
    // of the table rather than a habit of this method.
    await transaction.approvalStep.createMany({
      data: materializeApprovalSteps(
        requiredApprovalSteps(input.evaluatedAmountCents),
      ).map((step) => ({
        organizationId: input.organizationId,
        approvalFlowId: flow.id,
        purchaseRequestId: input.purchaseRequestId,
        sequence: step.sequence,
        role: step.role,
        state: step.state,
        evaluatedAmountCents: input.evaluatedAmountCents,
      })),
    });

    const created = await transaction.approvalFlow.findUniqueOrThrow({
      where: {
        organizationId_id: {
          organizationId: input.organizationId,
          id: flow.id,
        },
      },
      select: FLOW_SELECTION,
    });

    return toFlowRecord(created);
  }

  async findByPurchaseRequest(
    criteria: FindApprovalFlowCriteria,
  ): Promise<ApprovalFlowRecord | null> {
    const flow = await this.database.approvalFlow.findUnique({
      where: {
        organizationId_purchaseRequestId: {
          organizationId: criteria.organizationId,
          purchaseRequestId: criteria.purchaseRequestId,
        },
      },
      select: FLOW_SELECTION,
    });

    return flow === null ? null : toFlowRecord(flow);
  }

  async listActionableSteps(
    criteria: ListActionableStepsCriteria,
  ): Promise<readonly ApprovalStepRecord[]> {
    const steps = await this.database.approvalStep.findMany({
      where: {
        organizationId: criteria.organizationId,
        purchaseRequestId: { in: [...criteria.purchaseRequestIds] },
        role: criteria.role,
        state: "ACTIONABLE",
      },
      select: STEP_SELECTION,
    });

    return steps.map((step) => toStepRecord(step));
  }

  async findActionableStep(
    criteria: FindApprovalFlowCriteria,
  ): Promise<ApprovalStepRecord | null> {
    // A partial unique index makes "at most one ACTIONABLE step per flow" an invariant of the
    // table, so this reads the step the flow is waiting on rather than one of several.
    const step = await this.database.approvalStep.findFirst({
      where: {
        organizationId: criteria.organizationId,
        purchaseRequestId: criteria.purchaseRequestId,
        state: "ACTIONABLE",
      },
      select: STEP_SELECTION,
    });

    return step === null ? null : toStepRecord(step);
  }

  async decideActionableStep(
    scope: TransactionScope,
    input: DecideActionableStepInput,
  ): Promise<DecidedApprovalStepRecord | null> {
    const transaction = transactionClient(scope);

    // The caller already read this step to authorize against its responsibility. The UPDATE
    // re-states `state: ACTIONABLE` *and* the step's identity and role, so a decision that
    // arrived a moment earlier — or a promotion that made a different step actionable in the
    // meantime — leaves this one matching no row (REL-005).
    const decided = await transaction.approvalStep.updateMany({
      where: {
        id: input.approvalStepId,
        organizationId: input.organizationId,
        purchaseRequestId: input.purchaseRequestId,
        role: input.role,
        state: "ACTIONABLE",
      },
      data: {
        state: input.decision,
        decidedById: input.decidedById,
        decidedAt: input.decidedAt,
        decisionReason: input.decisionReason,
      },
    });

    if (decided.count !== 1) {
      return null;
    }

    const step = await transaction.approvalStep.findUniqueOrThrow({
      where: {
        organizationId_id: {
          organizationId: input.organizationId,
          id: input.approvalStepId,
        },
      },
      select: STEP_SELECTION,
    });

    // BR-004: a rejection ends the flow, so the steps that will never be decided are voided
    // rather than deleted — the history of what was required survives the refusal.
    if (input.decision === "REJECTED") {
      await transaction.approvalStep.updateMany({
        where: {
          organizationId: input.organizationId,
          approvalFlowId: step.approvalFlowId,
          state: { in: [...UNDECIDED_APPROVAL_STEP_STATES] },
        },
        data: { state: "VOIDED" },
      });
    }

    // FR-035. A Purchasing approval hands the ladder to Finance immediately, because the
    // amount is already the selected quote total. A Manager approval promotes nothing: BR-002
    // says the next rungs are evaluated against a total that does not exist yet, and BR-003's
    // re-evaluation is what makes them actionable.
    let promotedStep: ApprovalStepRecord | null = null;

    if (shouldPromoteNextStepAfterDecision(input.role, input.decision)) {
      promotedStep = await this.promoteEarliestUndecidedStep(
        scope,
        input.organizationId,
        step.approvalFlowId,
      );
    }

    const undecidedStepsRemaining = await transaction.approvalStep.count({
      where: {
        organizationId: input.organizationId,
        approvalFlowId: step.approvalFlowId,
        state: { in: [...UNDECIDED_APPROVAL_STEP_STATES] },
      },
    });
    const flowState = approvalFlowStateAfterDecision(
      input.decision,
      undecidedStepsRemaining,
    );

    await transaction.approvalFlow.updateMany({
      where: {
        id: step.approvalFlowId,
        organizationId: input.organizationId,
        purchaseRequestId: input.purchaseRequestId,
      },
      data: { state: flowState },
    });

    return { step: toStepRecord(step), flowState, promotedStep };
  }

  async reevaluateForSelectedQuote(
    scope: TransactionScope,
    input: ReevaluateApprovalFlowInput,
  ): Promise<ReevaluatedApprovalFlowRecord | null> {
    const transaction = transactionClient(scope);
    const flow = await transaction.approvalFlow.findUnique({
      where: {
        organizationId_purchaseRequestId: {
          organizationId: input.organizationId,
          purchaseRequestId: input.purchaseRequestId,
        },
      },
      select: FLOW_SELECTION,
    });

    if (flow === null) {
      return null;
    }

    const current = toFlowRecord(flow);
    // BR-003 is decided by a pure function of the current ladder and one amount, so all nine
    // estimated-tier to selected-tier combinations are provable without a database (NFR-007).
    // This method only applies what that function decided.
    const plan = planApprovalFlowReevaluation({
      steps: current.steps.map(
        (step): ReevaluatedApprovalStep => ({
          id: step.id,
          sequence: step.sequence,
          role: step.role,
          state: step.state,
          evaluatedAmountCents: step.evaluatedAmountCents,
        }),
      ),
      currentFlowState: current.state,
      selectedTotalCents: input.selectedTotalCents,
    });

    // Order matters: everything that stops being actionable happens before anything is
    // promoted, so the partial unique index that allows one ACTIONABLE step per flow is never
    // momentarily violated mid-transaction.
    if (plan.voidedStepIds.length > 0) {
      await transaction.approvalStep.updateMany({
        where: {
          organizationId: input.organizationId,
          approvalFlowId: current.id,
          id: { in: [...plan.voidedStepIds] },
          state: { in: [...UNDECIDED_APPROVAL_STEP_STATES] },
        },
        data: { state: "VOIDED" },
      });
    }

    // Every step that survives is demoted to PENDING first, for the same reason.
    await transaction.approvalStep.updateMany({
      where: {
        organizationId: input.organizationId,
        approvalFlowId: current.id,
        state: "ACTIONABLE",
      },
      data: { state: "PENDING" },
    });

    if (plan.repricedStepIds.length > 0) {
      await transaction.approvalStep.updateMany({
        where: {
          organizationId: input.organizationId,
          approvalFlowId: current.id,
          id: { in: [...plan.repricedStepIds] },
          state: { in: [...UNDECIDED_APPROVAL_STEP_STATES] },
        },
        data: { evaluatedAmountCents: input.selectedTotalCents },
      });
    }

    if (plan.appendedSteps.length > 0) {
      await transaction.approvalStep.createMany({
        data: plan.appendedSteps.map((step) => ({
          organizationId: input.organizationId,
          approvalFlowId: current.id,
          purchaseRequestId: input.purchaseRequestId,
          sequence: step.sequence,
          role: step.role,
          state: "PENDING" as const,
          evaluatedAmountCents: input.selectedTotalCents,
        })),
      });
    }

    const promotedSequence =
      plan.promotedAppendedSequence ??
      current.steps.find((step) => step.id === plan.promotedStepId)?.sequence ??
      null;

    if (promotedSequence !== null) {
      await transaction.approvalStep.updateMany({
        where: {
          organizationId: input.organizationId,
          approvalFlowId: current.id,
          sequence: promotedSequence,
          state: { in: [...UNDECIDED_APPROVAL_STEP_STATES] },
        },
        data: { state: "ACTIONABLE" },
      });
    }

    await transaction.approvalFlow.updateMany({
      where: {
        id: current.id,
        organizationId: input.organizationId,
        purchaseRequestId: input.purchaseRequestId,
      },
      data: { state: plan.flowState },
    });

    const reevaluated = toFlowRecord(
      await transaction.approvalFlow.findUniqueOrThrow({
        where: {
          organizationId_id: {
            organizationId: input.organizationId,
            id: current.id,
          },
        },
        select: FLOW_SELECTION,
      }),
    );

    return {
      flow: reevaluated,
      changed: plan.changed,
      voidedStepCount: plan.voidedStepIds.length,
      repricedStepCount: plan.repricedStepIds.length,
      appendedStepRoles: plan.appendedSteps.map(
        (step): ApprovalStepRole => step.role,
      ),
      actionableStep:
        reevaluated.steps.find((step) => step.state === "ACTIONABLE") ?? null,
    };
  }

  /**
   * FR-035. Makes the earliest still-undecided rung of a flow the one it is waiting on.
   * Returns `null` when nothing is left, which is how a completed ladder is recognized.
   */
  private async promoteEarliestUndecidedStep(
    scope: TransactionScope,
    organizationId: string,
    approvalFlowId: string,
  ): Promise<ApprovalStepRecord | null> {
    const transaction = transactionClient(scope);
    const next = await transaction.approvalStep.findFirst({
      where: {
        organizationId,
        approvalFlowId,
        state: { in: [...UNDECIDED_APPROVAL_STEP_STATES] },
      },
      orderBy: { sequence: "asc" },
      select: STEP_SELECTION,
    });

    if (next === null) {
      return null;
    }

    await transaction.approvalStep.updateMany({
      where: { id: next.id, organizationId, state: { in: [...UNDECIDED_APPROVAL_STEP_STATES] } },
      data: { state: "ACTIONABLE" },
    });

    return toStepRecord({ ...next, state: "ACTIONABLE" });
  }

  async voidUnfinished(
    scope: TransactionScope,
    criteria: FindApprovalFlowCriteria,
  ): Promise<number> {
    const transaction = transactionClient(scope);
    const voided = await transaction.approvalStep.updateMany({
      where: {
        organizationId: criteria.organizationId,
        purchaseRequestId: criteria.purchaseRequestId,
        state: { in: [...UNDECIDED_APPROVAL_STEP_STATES] },
      },
      data: { state: "VOIDED" },
    });

    // Only an ACTIVE flow is voided. One that already reached COMPLETED or REJECTED keeps the
    // outcome it reached: cancelling a request does not un-decide its approvals.
    await transaction.approvalFlow.updateMany({
      where: {
        organizationId: criteria.organizationId,
        purchaseRequestId: criteria.purchaseRequestId,
        state: "ACTIVE",
      },
      data: { state: "VOIDED" },
    });

    return voided.count;
  }
}

function toStepRecord(row: ApprovalStepRow): ApprovalStepRecord {
  return {
    id: row.id,
    approvalFlowId: row.approvalFlowId,
    purchaseRequestId: row.purchaseRequestId,
    sequence: row.sequence,
    role: toApprovalStepRole(row.role),
    state: toApprovalStepState(row.state),
    evaluatedAmountCents: row.evaluatedAmountCents,
    decidedById: row.decidedById,
    decidedAt: row.decidedAt,
    decisionReason: row.decisionReason,
  };
}

function toFlowRecord(row: ApprovalFlowRow): ApprovalFlowRecord {
  return {
    id: row.id,
    purchaseRequestId: row.purchaseRequestId,
    state: toApprovalFlowState(row.state),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    steps: row.steps.map((step) => toStepRecord(step)),
  };
}

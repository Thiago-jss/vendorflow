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
} from "../../application/contracts/approval-flow.repository";
import { requiredApprovalSteps } from "../../application/support/approval-policy";
import {
  UNDECIDED_APPROVAL_STEP_STATES,
  approvalFlowStateAfterDecision,
  materializeApprovalSteps,
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

  async decideActionableStep(
    scope: TransactionScope,
    input: DecideActionableStepInput,
  ): Promise<DecidedApprovalStepRecord | null> {
    const transaction = transactionClient(scope);

    // The read identifies the step and classifies the failure; it is not what makes the
    // decision safe. The UPDATE below re-states `state: ACTIONABLE`, so a decision that
    // arrived a moment earlier leaves this one matching no row (REL-005).
    const actionable = await transaction.approvalStep.findFirst({
      where: {
        organizationId: input.organizationId,
        purchaseRequestId: input.purchaseRequestId,
        role: input.role,
        state: "ACTIONABLE",
      },
      select: { id: true, approvalFlowId: true },
    });

    if (actionable === null) {
      return null;
    }

    const decided = await transaction.approvalStep.updateMany({
      where: {
        id: actionable.id,
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

    // BR-004: a rejection ends the flow, so the steps that will never be decided are voided
    // rather than deleted — the history of what was required survives the refusal.
    if (input.decision === "REJECTED") {
      await transaction.approvalStep.updateMany({
        where: {
          organizationId: input.organizationId,
          approvalFlowId: actionable.approvalFlowId,
          state: { in: [...UNDECIDED_APPROVAL_STEP_STATES] },
        },
        data: { state: "VOIDED" },
      });
    }

    const undecidedStepsRemaining = await transaction.approvalStep.count({
      where: {
        organizationId: input.organizationId,
        approvalFlowId: actionable.approvalFlowId,
        state: { in: [...UNDECIDED_APPROVAL_STEP_STATES] },
      },
    });
    const flowState = approvalFlowStateAfterDecision(
      input.decision,
      undecidedStepsRemaining,
    );

    await transaction.approvalFlow.updateMany({
      where: {
        id: actionable.approvalFlowId,
        organizationId: input.organizationId,
        purchaseRequestId: input.purchaseRequestId,
      },
      data: { state: flowState },
    });

    const step = await transaction.approvalStep.findUniqueOrThrow({
      where: {
        organizationId_id: {
          organizationId: input.organizationId,
          id: actionable.id,
        },
      },
      select: STEP_SELECTION,
    });

    return { step: toStepRecord(step), flowState };
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

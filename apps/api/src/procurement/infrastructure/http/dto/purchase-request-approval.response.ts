import { ApiProperty } from "@nestjs/swagger";
import type {
  ApprovalFlowRecord,
  ApprovalStepRecord,
} from "../../../../approval/application/contracts/approval-flow.repository";
import {
  approvalStepRoles,
  type ApprovalStepRole,
} from "../../../../approval/application/support/approval-policy";
import {
  approvalFlowStates,
  approvalStepStates,
  type ApprovalFlowState,
  type ApprovalStepState,
} from "../../../../approval/application/support/approval-step-state";
import { formatCents } from "../../../../platform/numeric/centavos";

/**
 * FR-026/FR-036. One rung of the ladder, decided or not.
 *
 * The decision *is* the state: `APPROVED` and `REJECTED` are step states, so there is no
 * separate "decision" field that could disagree with the one the database holds. `VOIDED`
 * says the step will never be decided — a cancelled request, or a flow a rejection ended —
 * which is why the history stays readable after either.
 */
export class ApprovalStepResponse {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({
    description:
      "Server-assigned, 1-based and gap-free. Steps are executed in this order (FR-035).",
  })
  sequence!: number;

  @ApiProperty({
    enum: approvalStepRoles,
    description:
      "The responsibility this step belongs to. A Purchasing step is decided by a BUYER and a Finance step by a FINANCE user (FR-034).",
  })
  role!: ApprovalStepRole;

  @ApiProperty({
    enum: approvalStepStates,
    description:
      "ACTIONABLE is the single step the flow is waiting on; PENDING steps may not be decided before it; APPROVED and REJECTED are final (BR-006); VOIDED will never be decided.",
  })
  state!: ApprovalStepState;

  @ApiProperty({
    description:
      "The amount this step was evaluated against, in integer centavos (FR-036, BR-002).",
    example: "687375",
  })
  evaluatedAmountCents!: string;

  @ApiProperty({
    format: "uuid",
    nullable: true,
    type: String,
    description: "The user who decided the step; null while undecided.",
  })
  decidedById!: string | null;

  @ApiProperty({ format: "date-time", nullable: true, type: String })
  decidedAt!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      "Mandatory on a rejection, at least 10 non-whitespace characters (FR-031); optional on an approval and stored as given when present.",
  })
  decisionReason!: string | null;
}

export class ApprovalFlowResponse {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({
    enum: approvalFlowStates,
    description:
      "ACTIVE while a step may still be decided, COMPLETED once every materialized step has been, REJECTED when a step refused the request, VOIDED when the request was cancelled first.",
  })
  state!: ApprovalFlowState;

  @ApiProperty({
    type: ApprovalStepResponse,
    nullable: true,
    description:
      "The step the flow is currently waiting on, or null when nothing is actionable.",
  })
  pendingStep!: ApprovalStepResponse | null;

  @ApiProperty({
    type: [ApprovalStepResponse],
    description:
      "The full history, ordered by sequence. Nothing is removed on rejection or cancellation.",
  })
  steps!: ApprovalStepResponse[];
}

export function toApprovalStepResponse(
  record: ApprovalStepRecord,
): ApprovalStepResponse {
  return {
    id: record.id,
    sequence: record.sequence,
    role: record.role,
    state: record.state,
    evaluatedAmountCents: formatCents(record.evaluatedAmountCents),
    decidedById: record.decidedById,
    decidedAt: record.decidedAt?.toISOString() ?? null,
    decisionReason: record.decisionReason,
  };
}

export function toApprovalFlowResponse(
  record: ApprovalFlowRecord,
): ApprovalFlowResponse {
  const pendingStep = record.steps.find((step) => step.state === "ACTIONABLE");

  return {
    id: record.id,
    state: record.state,
    pendingStep:
      pendingStep === undefined ? null : toApprovalStepResponse(pendingStep),
    steps: record.steps.map((step) => toApprovalStepResponse(step)),
  };
}

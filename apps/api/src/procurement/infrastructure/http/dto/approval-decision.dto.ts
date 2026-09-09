import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import type { ApprovalDecision } from "../../../../approval/application/support/approval-step-state";
import {
  approvalDecisions,
} from "../../../../approval/application/support/approval-step-state";
import {
  DECISION_REASON_COLUMN_WIDTH,
  MINIMUM_REJECTION_REASON_LENGTH,
} from "../../../../approval/application/support/approval-decision";

/**
 * SEC-004. A closed world of two fields.
 *
 * There is no step identifier, no status, no actor, no amount and no sequence: the step being
 * decided is the one the flow is waiting on, the actor is the authenticated principal, and
 * the resulting state is the policy's, not the caller's (MT-003, AUTHZ-005). The global
 * `ValidationPipe` runs with `forbidNonWhitelisted`, so sending any of them is a 400 rather
 * than a value the server must remember to ignore.
 *
 * The reason's *shape* is checked here; FR-031's ten-character minimum is a domain rule and
 * answers 422, in keeping with the rest of this module — a nine-character string is a
 * perfectly well-formed string.
 */
export class ApprovalDecisionDto {
  @ApiProperty({
    enum: approvalDecisions,
    description:
      "APPROVED moves the request to IN_QUOTATION; REJECTED moves it to REJECTED, which is terminal (FR-032, BR-004).",
  })
  @IsIn(approvalDecisions)
  decision!: ApprovalDecision;

  @ApiPropertyOptional({
    maxLength: DECISION_REASON_COLUMN_WIDTH,
    description: `Mandatory for a rejection, where at least ${MINIMUM_REJECTION_REASON_LENGTH} non-whitespace characters are required (FR-031). Optional for an approval; when given it is validated and stored rather than dropped.`,
  })
  @IsOptional()
  @IsString()
  @MaxLength(DECISION_REASON_COLUMN_WIDTH)
  reason?: string;
}

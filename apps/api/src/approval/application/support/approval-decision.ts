import { ApprovalDecisionValidationError } from "../contracts/approval.errors";
import type { ApprovalDecision } from "./approval-step-state";

/** FR-031, counted after trimming: ten spaces are not a reason. */
export const MINIMUM_REJECTION_REASON_LENGTH = 10;

/** The width of the `decision_reason` column, restated so an over-long value gets a stated
 * domain answer instead of a driver error. */
export const DECISION_REASON_COLUMN_WIDTH = 2000;

/**
 * FR-031/FR-036. A rejection must say why, in at least ten non-whitespace characters. An
 * approval need not — but a reason supplied with one is a fact the trail will keep, so it is
 * validated and stored deliberately rather than dropped: silently discarding text a manager
 * typed is how an approval loses the only explanation anyone recorded.
 *
 * Returns the trimmed reason, or `null` when there is none. Whitespace-only is never `null`:
 * treating it as absent would let a rejection satisfy FR-031 with blanks.
 */
export function normalizeApprovalDecisionReason(
  decision: ApprovalDecision,
  reason: string | undefined,
): string | null {
  const trimmed = (reason ?? "").trim();

  if (trimmed.length === 0) {
    if (decision === "REJECTED") {
      throw new ApprovalDecisionValidationError(
        `A rejection requires a reason of at least ${MINIMUM_REJECTION_REASON_LENGTH} characters`,
      );
    }

    if (reason !== undefined) {
      throw new ApprovalDecisionValidationError(
        "An approval reason, when given, may not be blank",
      );
    }

    return null;
  }

  if (
    decision === "REJECTED" &&
    trimmed.length < MINIMUM_REJECTION_REASON_LENGTH
  ) {
    throw new ApprovalDecisionValidationError(
      `A rejection requires a reason of at least ${MINIMUM_REJECTION_REASON_LENGTH} characters`,
    );
  }

  if (trimmed.length > DECISION_REASON_COLUMN_WIDTH) {
    throw new ApprovalDecisionValidationError(
      `A decision reason may not exceed ${DECISION_REASON_COLUMN_WIDTH} characters`,
    );
  }

  return trimmed;
}

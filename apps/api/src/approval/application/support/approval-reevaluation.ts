import {
  requiredApprovalStepRoles,
  type ApprovalStepRole,
} from "./approval-policy";
import {
  UNDECIDED_APPROVAL_STEP_STATES,
  type ApprovalFlowState,
  type ApprovalStepState,
} from "./approval-step-state";

/**
 * BR-002/BR-003. What a selected quote total does to an approval flow that was materialized
 * from an estimate.
 *
 * This file is a pure function of the flow's current steps and one amount. It touches no
 * database, no clock and no principal, which is what makes all nine estimated-tier to
 * selected-tier combinations testable without infrastructure (NFR-007).
 *
 * The rules, and why each one is the way it is:
 *
 * - **The Manager step is untouchable.** BR-002 evaluates it against the *estimated* total and
 *   it has already gated entry into quotation. Re-pricing a decision someone already made
 *   against a different number would rewrite history; voiding it would un-approve the very
 *   step that authorized the quotation work. It is neither re-executed nor voided, whatever
 *   the selected total turns out to be.
 * - **Post-quotation steps are evaluated against the selected quote total.** Purchasing and
 *   Finance approve what will actually be spent.
 * - **Missing required steps are appended** (BR-003, higher tier), at the end of the ladder, so
 *   `sequence` stays 1-based and gap-free and the order of the existing rungs never shifts.
 * - **Steps the selected tier no longer requires are voided** (BR-003, lower tier) — but only
 *   if they are still undecided. A step that was already APPROVED or REJECTED is history and
 *   stays exactly as recorded (AUD-003).
 * - **A step already decided is never re-appended.** A tier that requires PURCHASING when a
 *   PURCHASING step exists in any state is already satisfied by that step's existence; adding a
 *   second one would ask the same person to approve the same request twice.
 * - **Exactly one step is promoted**: the earliest remaining undecided one, by sequence
 *   (FR-035). If none remains, the flow is complete.
 */
export interface ReevaluatedApprovalStep {
  readonly id: string;
  readonly sequence: number;
  readonly role: ApprovalStepRole;
  readonly state: ApprovalStepState;
  /** FR-036. What the step currently says it is being decided against, in exact centavos. */
  readonly evaluatedAmountCents: bigint;
}

export interface AppendedApprovalStep {
  readonly sequence: number;
  readonly role: ApprovalStepRole;
}

export interface ApprovalFlowReevaluationPlan {
  /** Steps to VOID: undecided, and no longer required by the selected tier. */
  readonly voidedStepIds: readonly string[];
  /** Steps whose `evaluated_amount_cents` becomes the selected quote total. */
  readonly repricedStepIds: readonly string[];
  /** New steps the higher tier requires, already carrying their gap-free sequence. */
  readonly appendedSteps: readonly AppendedApprovalStep[];
  /**
   * The single step to make ACTIONABLE. `null` when the promoted step is one of the appended
   * ones, in which case `promotedAppendedSequence` names it instead — an appended step has no
   * identifier until it is inserted.
   */
  readonly promotedStepId: string | null;
  readonly promotedAppendedSequence: number | null;
  /** No undecided step remains: the ladder is finished and the request is APPROVED. */
  readonly flowState: ApprovalFlowState;
  /**
   * False when the selected tier asks for exactly the ladder that already exists and nothing
   * moves. The caller uses this to decide whether an audit event is a fact worth recording:
   * "the rule was consulted" is not one.
   */
  readonly changed: boolean;
}

/**
 * The roles a *post-quotation* ladder requires for an amount. BR-001's table always starts
 * with the Manager, and the Manager step is not re-evaluated here, so it is removed rather
 * than special-cased at every use.
 */
export function requiredPostQuotationRoles(
  selectedTotalCents: bigint,
): readonly ApprovalStepRole[] {
  return requiredApprovalStepRoles(selectedTotalCents).filter(
    (role) => role !== "MANAGER",
  );
}

export function planApprovalFlowReevaluation(input: {
  readonly steps: readonly ReevaluatedApprovalStep[];
  readonly currentFlowState: ApprovalFlowState;
  readonly selectedTotalCents: bigint;
}): ApprovalFlowReevaluationPlan {
  const required = requiredPostQuotationRoles(input.selectedTotalCents);
  const isUndecided = (step: ReevaluatedApprovalStep): boolean =>
    UNDECIDED_APPROVAL_STEP_STATES.includes(step.state);

  const voidedStepIds: string[] = [];
  const repricedStepIds: string[] = [];
  // The ladder as it will stand after the plan is applied, in sequence order, restricted to
  // the steps that can still be decided. It is what the promotion below chooses from.
  const survivingUndecided: { sequence: number; id: string | null }[] = [];

  for (const step of [...input.steps].sort((a, b) => a.sequence - b.sequence)) {
    if (step.role === "MANAGER") {
      // Untouched in every direction. A Manager step that is somehow still undecided keeps
      // its turn in the ladder rather than being voided by a rule about quote totals.
      if (isUndecided(step)) {
        survivingUndecided.push({ sequence: step.sequence, id: step.id });
      }

      continue;
    }

    if (!isUndecided(step)) {
      // APPROVED, REJECTED or already VOIDED: history, and history does not move (AUD-003).
      continue;
    }

    if (!required.includes(step.role)) {
      voidedStepIds.push(step.id);
      continue;
    }

    // Only when the number actually changes. A selected total that lands on the estimate
    // leaves the step exactly as it was, so `changed` below stays honest and the trail is
    // not filled with re-evaluations that re-evaluated nothing.
    if (step.evaluatedAmountCents !== input.selectedTotalCents) {
      repricedStepIds.push(step.id);
    }

    survivingUndecided.push({ sequence: step.sequence, id: step.id });
  }

  // A role is "already present" when a step of that role exists in any state, decided or not:
  // a decision that has been made is not made again, and an undecided step was just repriced.
  const presentRoles = new Set(
    input.steps
      .filter((step) => step.state !== "VOIDED")
      .map((step) => step.role),
  );
  let nextSequence = input.steps.reduce(
    (highest, step) => Math.max(highest, step.sequence),
    0,
  );
  const appendedSteps: AppendedApprovalStep[] = [];

  for (const role of required) {
    if (presentRoles.has(role)) {
      continue;
    }

    nextSequence += 1;
    appendedSteps.push({ sequence: nextSequence, role });
    survivingUndecided.push({ sequence: nextSequence, id: null });
  }

  survivingUndecided.sort((left, right) => left.sequence - right.sequence);

  const promoted = survivingUndecided.at(0) ?? null;
  const flowState: ApprovalFlowState = promoted === null ? "COMPLETED" : "ACTIVE";
  const currentlyActionableId =
    input.steps.find((step) => step.state === "ACTIONABLE")?.id ?? null;
  // The promotion is a change unless the step already actionable is exactly the one the plan
  // promotes. An appended step is always a change: it did not exist a moment ago.
  const promotionChanges =
    promoted === null
      ? currentlyActionableId !== null
      : promoted.id === null || promoted.id !== currentlyActionableId;

  return {
    voidedStepIds,
    repricedStepIds,
    appendedSteps,
    promotedStepId: promoted?.id ?? null,
    promotedAppendedSequence:
      promoted !== null && promoted.id === null ? promoted.sequence : null,
    flowState,
    changed:
      voidedStepIds.length > 0 ||
      repricedStepIds.length > 0 ||
      appendedSteps.length > 0 ||
      promotionChanges ||
      flowState !== input.currentFlowState,
  };
}

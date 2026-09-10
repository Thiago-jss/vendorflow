import {
  FIRST_TIER_MAXIMUM_CENTS,
  SECOND_TIER_MAXIMUM_CENTS,
  type ApprovalStepRole,
} from "./approval-policy";
import {
  planApprovalFlowReevaluation,
  requiredPostQuotationRoles,
  type ReevaluatedApprovalStep,
} from "./approval-reevaluation";
import type { ApprovalStepState } from "./approval-step-state";

/** One amount inside each BR-001 tier, and the boundary values that define them. */
const TIER_ONE = FIRST_TIER_MAXIMUM_CENTS; // R$ 1,000.00, inclusive
const TIER_TWO = SECOND_TIER_MAXIMUM_CENTS; // R$ 5,000.00, inclusive
const TIER_THREE = SECOND_TIER_MAXIMUM_CENTS + 1n; // one centavo over

/**
 * The ladder a submission materializes for an estimate in each tier, with the Manager step
 * already approved — which is the only state a quote can be selected from, because quotation
 * begins with a Manager approval (FR-032).
 */
function ladderFor(estimatedTotalCents: bigint): ReevaluatedApprovalStep[] {
  const roles: ApprovalStepRole[] =
    estimatedTotalCents <= TIER_ONE
      ? ["MANAGER"]
      : estimatedTotalCents <= TIER_TWO
        ? ["MANAGER", "PURCHASING"]
        : ["MANAGER", "PURCHASING", "FINANCE"];

  return roles.map((role, index) => ({
    id: `step-${index + 1}`,
    sequence: index + 1,
    role,
    state: (role === "MANAGER" ? "APPROVED" : "PENDING") as ApprovalStepState,
    evaluatedAmountCents: estimatedTotalCents,
  }));
}

function planFor(estimated: bigint, selected: bigint) {
  return planApprovalFlowReevaluation({
    steps: ladderFor(estimated),
    // A tier-one estimate completes its flow the moment the Manager approves; the others stay
    // ACTIVE with the post-quotation rungs still standing.
    currentFlowState: estimated <= TIER_ONE ? "COMPLETED" : "ACTIVE",
    selectedTotalCents: selected,
  });
}

describe("BR-001's post-quotation ladder", () => {
  it("drops the Manager, who is evaluated against the estimate and never re-evaluated", () => {
    expect(requiredPostQuotationRoles(TIER_ONE)).toEqual([]);
    expect(requiredPostQuotationRoles(TIER_TWO)).toEqual(["PURCHASING"]);
    expect(requiredPostQuotationRoles(TIER_THREE)).toEqual([
      "PURCHASING",
      "FINANCE",
    ]);
  });

  it("treats the tier boundaries as inclusive upper bounds (assumption A-1)", () => {
    expect(requiredPostQuotationRoles(TIER_ONE)).toEqual([]);
    expect(requiredPostQuotationRoles(TIER_ONE + 1n)).toEqual(["PURCHASING"]);
    expect(requiredPostQuotationRoles(TIER_TWO)).toEqual(["PURCHASING"]);
    expect(requiredPostQuotationRoles(TIER_TWO + 1n)).toEqual([
      "PURCHASING",
      "FINANCE",
    ]);
  });
});

/**
 * BR-003, in all nine directions. Each case states what the ladder looked like after
 * submission, what the selected quote total turned out to be, and what must happen — appended,
 * voided, repriced, promoted, completed.
 */
describe("BR-003 re-evaluation, estimated tier to selected tier", () => {
  it("tier 1 to tier 1: nothing to approve, the flow completes", () => {
    const plan = planFor(TIER_ONE, TIER_ONE);

    expect(plan.appendedSteps).toEqual([]);
    expect(plan.voidedStepIds).toEqual([]);
    expect(plan.promotedStepId).toBeNull();
    expect(plan.promotedAppendedSequence).toBeNull();
    expect(plan.flowState).toBe("COMPLETED");
    // The ladder already said this and still says it: nothing moved, so nothing is audited.
    expect(plan.changed).toBe(false);
  });

  it("tier 1 to tier 2: Purchasing is appended and promoted", () => {
    const plan = planFor(TIER_ONE, TIER_TWO);

    expect(plan.appendedSteps).toEqual([{ sequence: 2, role: "PURCHASING" }]);
    expect(plan.voidedStepIds).toEqual([]);
    // An appended step has no identifier until it is inserted, so the plan names its sequence.
    expect(plan.promotedStepId).toBeNull();
    expect(plan.promotedAppendedSequence).toBe(2);
    expect(plan.flowState).toBe("ACTIVE");
    expect(plan.changed).toBe(true);
  });

  it("tier 1 to tier 3: Purchasing and Finance are appended, Purchasing goes first", () => {
    const plan = planFor(TIER_ONE, TIER_THREE);

    expect(plan.appendedSteps).toEqual([
      { sequence: 2, role: "PURCHASING" },
      { sequence: 3, role: "FINANCE" },
    ]);
    // FR-035: exactly one step is actionable, and it is the earliest.
    expect(plan.promotedAppendedSequence).toBe(2);
    expect(plan.flowState).toBe("ACTIVE");
  });

  it("tier 2 to tier 1: the undecided Purchasing step is voided and the flow completes", () => {
    const plan = planFor(TIER_TWO, TIER_ONE);

    expect(plan.voidedStepIds).toEqual(["step-2"]);
    expect(plan.appendedSteps).toEqual([]);
    expect(plan.repricedStepIds).toEqual([]);
    expect(plan.promotedStepId).toBeNull();
    expect(plan.flowState).toBe("COMPLETED");
    expect(plan.changed).toBe(true);
  });

  it("tier 2 to tier 2: Purchasing is repriced and promoted", () => {
    const plan = planFor(TIER_TWO - 1n, TIER_TWO);

    expect(plan.repricedStepIds).toEqual(["step-2"]);
    expect(plan.voidedStepIds).toEqual([]);
    expect(plan.appendedSteps).toEqual([]);
    expect(plan.promotedStepId).toBe("step-2");
    expect(plan.flowState).toBe("ACTIVE");
    expect(plan.changed).toBe(true);
  });

  it("tier 2 to tier 3: Purchasing is repriced, Finance is appended, Purchasing goes first", () => {
    const plan = planFor(TIER_TWO, TIER_THREE);

    expect(plan.repricedStepIds).toEqual(["step-2"]);
    expect(plan.appendedSteps).toEqual([{ sequence: 3, role: "FINANCE" }]);
    expect(plan.promotedStepId).toBe("step-2");
    expect(plan.flowState).toBe("ACTIVE");
  });

  it("tier 3 to tier 1: both post-quotation steps are voided and the flow completes", () => {
    const plan = planFor(TIER_THREE, TIER_ONE);

    expect(plan.voidedStepIds).toEqual(["step-2", "step-3"]);
    expect(plan.appendedSteps).toEqual([]);
    expect(plan.promotedStepId).toBeNull();
    expect(plan.flowState).toBe("COMPLETED");
  });

  it("tier 3 to tier 2: Finance is voided, Purchasing is repriced and promoted", () => {
    const plan = planFor(TIER_THREE, TIER_TWO);

    expect(plan.voidedStepIds).toEqual(["step-3"]);
    expect(plan.repricedStepIds).toEqual(["step-2"]);
    expect(plan.appendedSteps).toEqual([]);
    expect(plan.promotedStepId).toBe("step-2");
    expect(plan.flowState).toBe("ACTIVE");
  });

  it("tier 3 to tier 3: both are repriced and Purchasing goes first", () => {
    const plan = planFor(TIER_THREE, TIER_THREE + 1n);

    expect(plan.repricedStepIds).toEqual(["step-2", "step-3"]);
    expect(plan.voidedStepIds).toEqual([]);
    expect(plan.appendedSteps).toEqual([]);
    expect(plan.promotedStepId).toBe("step-2");
    expect(plan.flowState).toBe("ACTIVE");
  });
});

describe("what re-evaluation refuses to touch", () => {
  it("never voids, reprices or re-appends the Manager step, in any direction", () => {
    for (const selected of [TIER_ONE, TIER_TWO, TIER_THREE]) {
      for (const estimated of [TIER_ONE, TIER_TWO, TIER_THREE]) {
        const plan = planFor(estimated, selected);

        expect(plan.voidedStepIds).not.toContain("step-1");
        expect(plan.repricedStepIds).not.toContain("step-1");
        expect(
          plan.appendedSteps.map((step) => step.role),
        ).not.toContain("MANAGER");
      }
    }
  });

  it("preserves a decided Purchasing step instead of voiding or duplicating it", () => {
    // A Purchasing approval that was already recorded is history. A drop to tier 1 must not
    // void it, and a stay at tier 2 must not append a second one asking the same person again.
    const decided: ReevaluatedApprovalStep[] = [
      {
        id: "step-1",
        sequence: 1,
        role: "MANAGER",
        state: "APPROVED",
        evaluatedAmountCents: TIER_TWO,
      },
      {
        id: "step-2",
        sequence: 2,
        role: "PURCHASING",
        state: "APPROVED",
        evaluatedAmountCents: TIER_TWO,
      },
    ];

    const droppedTier = planApprovalFlowReevaluation({
      steps: decided,
      currentFlowState: "COMPLETED",
      selectedTotalCents: TIER_ONE,
    });
    expect(droppedTier.voidedStepIds).toEqual([]);
    expect(droppedTier.flowState).toBe("COMPLETED");

    const sameTier = planApprovalFlowReevaluation({
      steps: decided,
      currentFlowState: "COMPLETED",
      selectedTotalCents: TIER_TWO,
    });
    expect(sameTier.appendedSteps).toEqual([]);
    expect(sameTier.repricedStepIds).toEqual([]);
    expect(sameTier.flowState).toBe("COMPLETED");

    // Raising the tier appends only what is genuinely missing.
    const raisedTier = planApprovalFlowReevaluation({
      steps: decided,
      currentFlowState: "COMPLETED",
      selectedTotalCents: TIER_THREE,
    });
    expect(raisedTier.appendedSteps).toEqual([
      { sequence: 3, role: "FINANCE" },
    ]);
    expect(raisedTier.promotedAppendedSequence).toBe(3);
    expect(raisedTier.flowState).toBe("ACTIVE");
  });

  it("leaves a rejected step alone and never resurrects a voided one", () => {
    const plan = planApprovalFlowReevaluation({
      steps: [
        {
          id: "step-1",
          sequence: 1,
          role: "MANAGER",
          state: "APPROVED",
          evaluatedAmountCents: TIER_THREE,
        },
        {
          id: "step-2",
          sequence: 2,
          role: "PURCHASING",
          state: "REJECTED",
          evaluatedAmountCents: TIER_THREE,
        },
        {
          id: "step-3",
          sequence: 3,
          role: "FINANCE",
          state: "VOIDED",
          evaluatedAmountCents: TIER_THREE,
        },
      ],
      currentFlowState: "REJECTED",
      selectedTotalCents: TIER_THREE,
    });

    expect(plan.voidedStepIds).toEqual([]);
    expect(plan.repricedStepIds).toEqual([]);
    // The Finance rung was voided by the rejection, so the tier requires it and it is absent:
    // a *new* one is appended rather than the old one being reopened (AUD-003).
    expect(plan.appendedSteps).toEqual([{ sequence: 4, role: "FINANCE" }]);
  });

  it("does not reprice a step whose evaluated amount is already the selected total", () => {
    // The estimate happened to be exactly right. Nothing about the ladder changes, so the
    // caller has no re-evaluation fact to audit.
    const plan = planFor(TIER_TWO, TIER_TWO);

    expect(plan.repricedStepIds).toEqual([]);
    expect(plan.promotedStepId).toBe("step-2");
    // The promotion itself is still a change: the step was PENDING and is now actionable.
    expect(plan.changed).toBe(true);
  });

  it("keeps sequences gap-free and strictly increasing when it appends", () => {
    const plan = planFor(TIER_ONE, TIER_THREE);
    const sequences = plan.appendedSteps.map((step) => step.sequence);

    expect(sequences).toEqual([2, 3]);
    expect(new Set(sequences).size).toBe(sequences.length);
  });
});

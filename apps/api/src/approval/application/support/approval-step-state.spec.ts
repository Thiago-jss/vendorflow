import { requiredApprovalSteps } from "./approval-policy";
import {
  APPROVAL_STEP_DECIDER_ROLE,
  UNDECIDED_APPROVAL_STEP_STATES,
  approvalDecisions,
  approvalFlowStateAfterDecision,
  approvalFlowStates,
  approvalStepStates,
  materializeApprovalSteps,
} from "./approval-step-state";

describe("approval step materialization", () => {
  it("declares the lifecycle explicitly rather than through nullable timestamps", () => {
    expect(approvalStepStates).toEqual([
      "PENDING",
      "ACTIONABLE",
      "APPROVED",
      "REJECTED",
      "VOIDED",
    ]);
    expect(approvalFlowStates).toEqual([
      "ACTIVE",
      "COMPLETED",
      "REJECTED",
      "VOIDED",
    ]);
    expect(approvalDecisions).toEqual(["APPROVED", "REJECTED"]);
    expect(UNDECIDED_APPROVAL_STEP_STATES).toEqual(["PENDING", "ACTIONABLE"]);
  });

  it("makes exactly the first step actionable, whatever the tier (FR-035)", () => {
    for (const amount of [100_000n, 100_001n, 500_001n]) {
      const steps = materializeApprovalSteps(requiredApprovalSteps(amount));

      expect(steps.filter((step) => step.state === "ACTIONABLE")).toHaveLength(
        1,
      );
      expect(steps[0]?.state).toBe("ACTIONABLE");
      expect(steps.slice(1).every((step) => step.state === "PENDING")).toBe(
        true,
      );
    }
  });

  it("materializes the whole ladder, in order, at once", () => {
    expect(materializeApprovalSteps(requiredApprovalSteps(500_001n))).toEqual([
      { sequence: 1, role: "MANAGER", state: "ACTIONABLE" },
      { sequence: 2, role: "PURCHASING", state: "PENDING" },
      { sequence: 3, role: "FINANCE", state: "PENDING" },
    ]);
  });

  it("never makes a Purchasing or Finance step actionable in this phase (BR-002)", () => {
    // Those steps are evaluated against the selected quote total, which does not exist yet.
    for (const amount of [100_001n, 500_001n]) {
      for (const step of materializeApprovalSteps(
        requiredApprovalSteps(amount),
      )) {
        if (step.role !== "MANAGER") {
          expect(step.state).toBe("PENDING");
        }
      }
    }
  });
});

describe("flow state after a decision", () => {
  it("completes a flow whose last undecided step was just approved", () => {
    expect(approvalFlowStateAfterDecision("APPROVED", 0)).toBe("COMPLETED");
  });

  it("keeps a flow active while later steps remain, and promotes nothing (BR-002)", () => {
    expect(approvalFlowStateAfterDecision("APPROVED", 1)).toBe("ACTIVE");
    expect(approvalFlowStateAfterDecision("APPROVED", 2)).toBe("ACTIVE");
  });

  it("ends the flow on a rejection, whatever is left of it (BR-004)", () => {
    for (const remaining of [0, 1, 2]) {
      expect(approvalFlowStateAfterDecision("REJECTED", remaining)).toBe(
        "REJECTED",
      );
    }
  });
});

describe("who decides which step", () => {
  it("maps each step responsibility to the one principal role that may act on it", () => {
    // FR-034: a Purchasing step is a Buyer's. AUTHZ-007: ADMIN appears nowhere.
    expect(APPROVAL_STEP_DECIDER_ROLE).toEqual({
      MANAGER: "MANAGER",
      PURCHASING: "BUYER",
      FINANCE: "FINANCE",
    });
  });
});

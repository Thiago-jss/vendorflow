import {
  FIRST_TIER_MAXIMUM_CENTS,
  SECOND_TIER_MAXIMUM_CENTS,
  approvalStepRoles,
  requiredApprovalStepRoles,
  requiredApprovalSteps,
} from "./approval-policy";

describe("BR-001 approval policy", () => {
  it("states the thresholds as exact centavo bigints", () => {
    // R$ 1,000.00 and R$ 5,000.00. Written as centavos because that is what the domain holds:
    // a threshold expressed in reais would need a division to compare against a stored amount.
    expect(FIRST_TIER_MAXIMUM_CENTS).toBe(100_000n);
    expect(SECOND_TIER_MAXIMUM_CENTS).toBe(500_000n);
    expect(approvalStepRoles).toEqual(["MANAGER", "PURCHASING", "FINANCE"]);
  });

  it("requires Manager alone up to and including R$ 1,000.00", () => {
    for (const amount of [0n, 1n, 99_999n, 100_000n]) {
      expect(requiredApprovalStepRoles(amount)).toEqual(["MANAGER"]);
    }
  });

  it("adds Purchasing above R$ 1,000.00 and up to R$ 5,000.00", () => {
    for (const amount of [100_001n, 250_000n, 500_000n]) {
      expect(requiredApprovalStepRoles(amount)).toEqual([
        "MANAGER",
        "PURCHASING",
      ]);
    }
  });

  it("adds Finance above R$ 5,000.00", () => {
    for (const amount of [500_001n, 1_000_000n]) {
      expect(requiredApprovalStepRoles(amount)).toEqual([
        "MANAGER",
        "PURCHASING",
        "FINANCE",
      ]);
    }
  });

  it("changes tier at exactly one centavo, on both boundaries (A-1)", () => {
    // The whole point of the assumption register entry: the intervals are continuous and the
    // upper bound is inclusive, so the only value that moves a request up a tier is the next
    // centavo. Anything less exact than integer arithmetic cannot express this test.
    expect(requiredApprovalStepRoles(100_000n)).toHaveLength(1);
    expect(requiredApprovalStepRoles(100_001n)).toHaveLength(2);
    expect(requiredApprovalStepRoles(500_000n)).toHaveLength(2);
    expect(requiredApprovalStepRoles(500_001n)).toHaveLength(3);
  });

  it("stays exact above Number.MAX_SAFE_INTEGER", () => {
    // 2^53 + 1 centavos. Had the comparison gone through a double, this would round to 2^53
    // and still land in the top tier by luck; the test that matters is that no float exists.
    expect(requiredApprovalStepRoles(9_007_199_254_740_993n)).toEqual([
      "MANAGER",
      "PURCHASING",
      "FINANCE",
    ]);
  });

  it("numbers the steps 1..n in execution order, without gaps (FR-035)", () => {
    expect(requiredApprovalSteps(500_001n)).toEqual([
      { sequence: 1, role: "MANAGER" },
      { sequence: 2, role: "PURCHASING" },
      { sequence: 3, role: "FINANCE" },
    ]);
    expect(requiredApprovalSteps(1n)).toEqual([
      { sequence: 1, role: "MANAGER" },
    ]);
  });

  it("always puts the Manager first, whatever the amount", () => {
    for (const amount of [0n, 100_000n, 100_001n, 500_000n, 500_001n]) {
      expect(requiredApprovalSteps(amount)[0]).toEqual({
        sequence: 1,
        role: "MANAGER",
      });
    }
  });
});

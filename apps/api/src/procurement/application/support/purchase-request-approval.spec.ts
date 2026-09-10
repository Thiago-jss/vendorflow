import {
  decidableStatusesForStepRole,
  purchaseRequestStatusAfterApprovalDecision,
} from "./purchase-request-approval";

describe("the request half of an approval decision", () => {
  it("moves a manager-approved request into quotation, never straight to APPROVED (BR-002)", () => {
    // Even when the estimated total falls in BR-001's first tier and the ladder has no rung
    // left, a Manager approval opens quotation: the amount that tier was measured against is
    // an estimate, and the real price is not known until a quote is selected.
    expect(
      purchaseRequestStatusAfterApprovalDecision({
        stepRole: "MANAGER",
        decision: "APPROVED",
        flowState: "COMPLETED",
      }),
    ).toBe("IN_QUOTATION");
  });

  it("ends the request on a rejection from either side of quotation (BR-004)", () => {
    for (const stepRole of ["MANAGER", "PURCHASING", "FINANCE"] as const) {
      expect(
        purchaseRequestStatusAfterApprovalDecision({
          stepRole,
          decision: "REJECTED",
          flowState: "REJECTED",
        }),
      ).toBe("REJECTED");
    }
  });

  it("approves the request only when a post-quotation approval was the last rung", () => {
    expect(
      purchaseRequestStatusAfterApprovalDecision({
        stepRole: "PURCHASING",
        decision: "APPROVED",
        flowState: "COMPLETED",
      }),
    ).toBe("APPROVED");
    expect(
      purchaseRequestStatusAfterApprovalDecision({
        stepRole: "FINANCE",
        decision: "APPROVED",
        flowState: "COMPLETED",
      }),
    ).toBe("APPROVED");
  });

  it("drives no transition while a further rung still stands (FR-035)", () => {
    // Purchasing approved, Finance is next: the request stays in IN_FINAL_APPROVAL and the
    // ladder simply moves on. "No transition" is an answer, not a missing case.
    expect(
      purchaseRequestStatusAfterApprovalDecision({
        stepRole: "PURCHASING",
        decision: "APPROVED",
        flowState: "ACTIVE",
      }),
    ).toBeNull();
  });

  it("permits each rung only from the state its amount actually exists in (AUTHZ-005)", () => {
    expect(decidableStatusesForStepRole("MANAGER")).toEqual(["SUBMITTED"]);
    expect(decidableStatusesForStepRole("PURCHASING")).toEqual([
      "IN_FINAL_APPROVAL",
    ]);
    expect(decidableStatusesForStepRole("FINANCE")).toEqual([
      "IN_FINAL_APPROVAL",
    ]);
  });
});

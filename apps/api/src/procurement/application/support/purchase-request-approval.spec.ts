import {
  DECIDABLE_APPROVAL_STEP_ROLE,
  purchaseRequestStatusAfterApprovalDecision,
} from "./purchase-request-approval";

describe("the request half of an approval decision", () => {
  it("decides only the Manager step in this phase (BR-002)", () => {
    expect(DECIDABLE_APPROVAL_STEP_ROLE).toBe("MANAGER");
  });

  it("moves an approved request into quotation and a rejected one to REJECTED (FR-032)", () => {
    expect(purchaseRequestStatusAfterApprovalDecision("APPROVED")).toBe(
      "IN_QUOTATION",
    );
    expect(purchaseRequestStatusAfterApprovalDecision("REJECTED")).toBe(
      "REJECTED",
    );
  });
});

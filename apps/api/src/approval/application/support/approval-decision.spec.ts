import { ApprovalDecisionValidationError } from "../contracts/approval.errors";
import {
  MINIMUM_REJECTION_REASON_LENGTH,
  DECISION_REASON_COLUMN_WIDTH,
  normalizeApprovalDecisionReason,
} from "./approval-decision";

describe("FR-031 decision reason", () => {
  it("requires at least ten non-whitespace characters to reject", () => {
    expect(MINIMUM_REJECTION_REASON_LENGTH).toBe(10);
    expect(
      normalizeApprovalDecisionReason("REJECTED", "Over budget this quarter"),
    ).toBe("Over budget this quarter");
    // Exactly at the boundary, counted after trimming.
    expect(normalizeApprovalDecisionReason("REJECTED", "  0123456789  ")).toBe(
      "0123456789",
    );
  });

  it("refuses a rejection whose reason is short, blank or missing", () => {
    for (const reason of [
      undefined,
      "",
      "   ",
      "\t\n ",
      "too short",
      "123456789",
      // Ten characters of whitespace are not ten characters of reason.
      "          ",
    ]) {
      expect(() => normalizeApprovalDecisionReason("REJECTED", reason)).toThrow(
        ApprovalDecisionValidationError,
      );
    }
  });

  it("names the rule and never echoes the submitted text (SEC-009)", () => {
    try {
      normalizeApprovalDecisionReason("REJECTED", "nope");
      throw new Error("expected a refusal");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ApprovalDecisionValidationError);
      expect((error as Error).message).toBe(
        "A rejection requires a reason of at least 10 characters",
      );
      expect((error as Error).message).not.toContain("nope");
    }
  });

  it("lets an approval omit a reason", () => {
    expect(normalizeApprovalDecisionReason("APPROVED", undefined)).toBeNull();
  });

  it("keeps an approval's reason when one is given, trimmed", () => {
    expect(normalizeApprovalDecisionReason("APPROVED", "  Fine by me  ")).toBe(
      "Fine by me",
    );
    // Deliberately shorter than a rejection needs: FR-031's minimum is about rejections.
    expect(normalizeApprovalDecisionReason("APPROVED", "ok")).toBe("ok");
  });

  it("refuses a blank approval reason rather than silently dropping it", () => {
    for (const reason of ["", "   "]) {
      expect(() => normalizeApprovalDecisionReason("APPROVED", reason)).toThrow(
        ApprovalDecisionValidationError,
      );
    }
  });

  it("refuses a reason wider than the column stores", () => {
    const tooLong = "x".repeat(DECISION_REASON_COLUMN_WIDTH + 1);

    for (const decision of ["APPROVED", "REJECTED"] as const) {
      expect(() => normalizeApprovalDecisionReason(decision, tooLong)).toThrow(
        ApprovalDecisionValidationError,
      );
    }

    expect(
      normalizeApprovalDecisionReason(
        "REJECTED",
        "y".repeat(DECISION_REASON_COLUMN_WIDTH),
      ),
    ).toHaveLength(DECISION_REASON_COLUMN_WIDTH);
  });
});

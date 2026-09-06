import {
  APPROVAL_DECIDABLE_STATUSES,
  EDITABLE_BY_REQUESTER_STATUSES,
  NON_CANCELLABLE_STATUSES,
  REQUESTER_CANCELLABLE_STATUSES,
  SUBMITTABLE_STATUSES,
  isApprovalTransitionAllowed,
  isEditableByRequester,
  isRequesterTransitionAllowed,
  purchaseRequestStatuses,
  type PurchaseRequestStatus,
} from "./purchase-request-status";

describe("purchase request state machine", () => {
  it("declares every state BR-010 defines", () => {
    expect(purchaseRequestStatuses).toEqual([
      "DRAFT",
      "SUBMITTED",
      "IN_QUOTATION",
      "IN_FINAL_APPROVAL",
      "APPROVED",
      "ORDERED",
      "REJECTED",
      "CANCELLED",
    ]);
  });

  it("allows exactly the four requester transitions this phase implements", () => {
    const allowed = purchaseRequestStatuses.flatMap((from) =>
      purchaseRequestStatuses
        .filter((to) => isRequesterTransitionAllowed(from, to))
        .map((to) => `${from} -> ${to}`),
    );

    // IN_QUOTATION -> CANCELLED joins the list in this phase because a Manager approval can
    // now put a request in IN_QUOTATION. FR-025 did not change; the reachable states did.
    expect(allowed).toEqual([
      "DRAFT -> SUBMITTED",
      "DRAFT -> CANCELLED",
      "SUBMITTED -> CANCELLED",
      "IN_QUOTATION -> CANCELLED",
    ]);
  });

  it("allows exactly the two approval transitions this phase implements", () => {
    const allowed = purchaseRequestStatuses.flatMap((from) =>
      purchaseRequestStatuses
        .filter((to) => isApprovalTransitionAllowed(from, to))
        .map((to) => `${from} -> ${to}`),
    );

    expect(allowed).toEqual([
      "SUBMITTED -> IN_QUOTATION",
      "SUBMITTED -> REJECTED",
    ]);
    expect(APPROVAL_DECIDABLE_STATUSES).toEqual(["SUBMITTED"]);
  });

  it("keeps the two tables separate: neither actor drives the other's edges", () => {
    // A requester never approves their way out of SUBMITTED, and a decision never submits,
    // cancels or edits. Conflating the tables is how a role check comes to stand in for a
    // state check (AUTHZ-005).
    expect(isRequesterTransitionAllowed("SUBMITTED", "IN_QUOTATION")).toBe(false);
    expect(isRequesterTransitionAllowed("SUBMITTED", "REJECTED")).toBe(false);
    expect(isApprovalTransitionAllowed("DRAFT", "SUBMITTED")).toBe(false);
    expect(isApprovalTransitionAllowed("SUBMITTED", "CANCELLED")).toBe(false);
    expect(isApprovalTransitionAllowed("IN_QUOTATION", "REJECTED")).toBe(false);
  });

  it("refuses every other transition, including the ones later phases will add", () => {
    // BR-011 permits these; the actors that drive them do not exist yet, so neither state
    // machine must pretend it can.
    expect(isRequesterTransitionAllowed("IN_QUOTATION", "APPROVED")).toBe(false);
    expect(isRequesterTransitionAllowed("APPROVED", "ORDERED")).toBe(false);
    expect(isApprovalTransitionAllowed("IN_FINAL_APPROVAL", "APPROVED")).toBe(
      false,
    );
    expect(isApprovalTransitionAllowed("APPROVED", "ORDERED")).toBe(false);
  });

  it("refuses to leave a terminal state", () => {
    const terminal: PurchaseRequestStatus[] = [
      "ORDERED",
      "REJECTED",
      "CANCELLED",
    ];

    for (const from of terminal) {
      for (const to of purchaseRequestStatuses) {
        expect(isRequesterTransitionAllowed(from, to)).toBe(false);
        expect(isApprovalTransitionAllowed(from, to)).toBe(false);
      }
    }
  });

  it("never allows a request to be cancelled once ORDERED (BR-013)", () => {
    for (const status of NON_CANCELLABLE_STATUSES) {
      expect(REQUESTER_CANCELLABLE_STATUSES).not.toContain(status);
      expect(isRequesterTransitionAllowed(status, "CANCELLED")).toBe(false);
    }
  });

  it("permits submission only from DRAFT and cancellation from every reachable state", () => {
    expect(SUBMITTABLE_STATUSES).toEqual(["DRAFT"]);
    expect(REQUESTER_CANCELLABLE_STATUSES).toEqual([
      "DRAFT",
      "SUBMITTED",
      "IN_QUOTATION",
    ]);
  });

  it("makes a request immutable to its requester once it leaves DRAFT (FR-023)", () => {
    expect(EDITABLE_BY_REQUESTER_STATUSES).toEqual(["DRAFT"]);
    expect(isEditableByRequester("DRAFT")).toBe(true);

    for (const status of purchaseRequestStatuses.filter(
      (candidate) => candidate !== "DRAFT",
    )) {
      expect(isEditableByRequester(status)).toBe(false);
    }
  });
});

import {
  EDITABLE_BY_REQUESTER_STATUSES,
  MANAGER_DECIDABLE_STATUSES,
  NON_CANCELLABLE_STATUSES,
  ORDERABLE_STATUSES,
  POST_QUOTATION_DECIDABLE_STATUSES,
  QUOTABLE_STATUSES,
  REQUESTER_CANCELLABLE_STATUSES,
  SUBMITTABLE_STATUSES,
  isApprovalTransitionAllowed,
  isEditableByRequester,
  isOrderingTransitionAllowed,
  isQuoteSelectionTransitionAllowed,
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

  it("allows exactly the requester transitions FR-025 and BR-013 describe", () => {
    const allowed = purchaseRequestStatuses.flatMap((from) =>
      purchaseRequestStatuses
        .filter((to) => isRequesterTransitionAllowed(from, to))
        .map((to) => `${from} -> ${to}`),
    );

    // IN_FINAL_APPROVAL and APPROVED join the list in this phase because quote selection can
    // now put a request there. FR-025 did not change; the reachable states did.
    expect(allowed).toEqual([
      "DRAFT -> SUBMITTED",
      "DRAFT -> CANCELLED",
      "SUBMITTED -> CANCELLED",
      "IN_QUOTATION -> CANCELLED",
      "IN_FINAL_APPROVAL -> CANCELLED",
      "APPROVED -> CANCELLED",
    ]);
  });

  it("allows exactly the approval transitions FR-032 and FR-034 describe", () => {
    const allowed = purchaseRequestStatuses.flatMap((from) =>
      purchaseRequestStatuses
        .filter((to) => isApprovalTransitionAllowed(from, to))
        .map((to) => `${from} -> ${to}`),
    );

    expect(allowed).toEqual([
      "SUBMITTED -> IN_QUOTATION",
      "SUBMITTED -> REJECTED",
      "IN_FINAL_APPROVAL -> APPROVED",
      "IN_FINAL_APPROVAL -> REJECTED",
    ]);
    expect(MANAGER_DECIDABLE_STATUSES).toEqual(["SUBMITTED"]);
    expect(POST_QUOTATION_DECIDABLE_STATUSES).toEqual(["IN_FINAL_APPROVAL"]);
  });

  it("lets only a quote selection leave IN_QUOTATION towards approval (FR-045)", () => {
    const allowed = purchaseRequestStatuses.flatMap((from) =>
      purchaseRequestStatuses
        .filter((to) => isQuoteSelectionTransitionAllowed(from, to))
        .map((to) => `${from} -> ${to}`),
    );

    expect(allowed).toEqual([
      "IN_QUOTATION -> IN_FINAL_APPROVAL",
      "IN_QUOTATION -> APPROVED",
    ]);
    expect(QUOTABLE_STATUSES).toEqual(["IN_QUOTATION"]);
    // A selection can never reach ORDERED or REJECTED: those are somebody else's edges.
    expect(isQuoteSelectionTransitionAllowed("IN_QUOTATION", "ORDERED")).toBe(
      false,
    );
    expect(isQuoteSelectionTransitionAllowed("IN_QUOTATION", "REJECTED")).toBe(
      false,
    );
  });

  it("lets only a purchase order issuance reach ORDERED (FR-052)", () => {
    const allowed = purchaseRequestStatuses.flatMap((from) =>
      purchaseRequestStatuses
        .filter((to) => isOrderingTransitionAllowed(from, to))
        .map((to) => `${from} -> ${to}`),
    );

    expect(allowed).toEqual(["APPROVED -> ORDERED"]);
    expect(ORDERABLE_STATUSES).toEqual(["APPROVED"]);
    expect(isOrderingTransitionAllowed("IN_FINAL_APPROVAL", "ORDERED")).toBe(
      false,
    );
  });

  it("keeps the tables separate: no actor drives another's edges", () => {
    // Conflating them is how a role check comes to stand in for a state check (AUTHZ-005).
    expect(isRequesterTransitionAllowed("SUBMITTED", "IN_QUOTATION")).toBe(false);
    expect(isRequesterTransitionAllowed("SUBMITTED", "REJECTED")).toBe(false);
    expect(isRequesterTransitionAllowed("APPROVED", "ORDERED")).toBe(false);
    expect(isApprovalTransitionAllowed("DRAFT", "SUBMITTED")).toBe(false);
    expect(isApprovalTransitionAllowed("SUBMITTED", "CANCELLED")).toBe(false);
    expect(isApprovalTransitionAllowed("IN_QUOTATION", "REJECTED")).toBe(false);
    // A decision never selects a quote's outcome for it, and a selection never approves.
    expect(isApprovalTransitionAllowed("IN_QUOTATION", "APPROVED")).toBe(false);
    expect(isApprovalTransitionAllowed("APPROVED", "ORDERED")).toBe(false);
    expect(isQuoteSelectionTransitionAllowed("SUBMITTED", "IN_FINAL_APPROVAL")).toBe(
      false,
    );
    expect(isOrderingTransitionAllowed("IN_QUOTATION", "ORDERED")).toBe(false);
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
        expect(isQuoteSelectionTransitionAllowed(from, to)).toBe(false);
        expect(isOrderingTransitionAllowed(from, to)).toBe(false);
      }
    }
  });

  it("never allows a request to be cancelled once ORDERED (BR-013)", () => {
    for (const status of NON_CANCELLABLE_STATUSES) {
      expect(REQUESTER_CANCELLABLE_STATUSES).not.toContain(status);
      expect(isRequesterTransitionAllowed(status, "CANCELLED")).toBe(false);
    }
  });

  it("permits submission only from DRAFT and cancellation from every state before ORDERED", () => {
    expect(SUBMITTABLE_STATUSES).toEqual(["DRAFT"]);
    expect(REQUESTER_CANCELLABLE_STATUSES).toEqual([
      "DRAFT",
      "SUBMITTED",
      "IN_QUOTATION",
      "IN_FINAL_APPROVAL",
      "APPROVED",
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

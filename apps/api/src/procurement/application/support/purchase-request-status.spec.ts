import {
  EDITABLE_BY_REQUESTER_STATUSES,
  NON_CANCELLABLE_STATUSES,
  REQUESTER_CANCELLABLE_STATUSES,
  SUBMITTABLE_STATUSES,
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

  it("allows exactly the three requester transitions this phase implements", () => {
    const allowed = purchaseRequestStatuses.flatMap((from) =>
      purchaseRequestStatuses
        .filter((to) => isRequesterTransitionAllowed(from, to))
        .map((to) => `${from} -> ${to}`),
    );

    expect(allowed).toEqual([
      "DRAFT -> SUBMITTED",
      "DRAFT -> CANCELLED",
      "SUBMITTED -> CANCELLED",
    ]);
  });

  it("refuses every other transition, including the ones later phases will add", () => {
    // BR-011 permits these; the actors that drive them do not exist yet, so the requester
    // state machine must not pretend it can.
    expect(isRequesterTransitionAllowed("SUBMITTED", "IN_QUOTATION")).toBe(false);
    expect(isRequesterTransitionAllowed("IN_QUOTATION", "APPROVED")).toBe(false);
    expect(isRequesterTransitionAllowed("APPROVED", "ORDERED")).toBe(false);
    expect(isRequesterTransitionAllowed("SUBMITTED", "REJECTED")).toBe(false);
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
      }
    }
  });

  it("never allows a request to be cancelled once ORDERED (BR-013)", () => {
    for (const status of NON_CANCELLABLE_STATUSES) {
      expect(REQUESTER_CANCELLABLE_STATUSES).not.toContain(status);
      expect(isRequesterTransitionAllowed(status, "CANCELLED")).toBe(false);
    }
  });

  it("permits submission only from DRAFT and cancellation only before quotation", () => {
    expect(SUBMITTABLE_STATUSES).toEqual(["DRAFT"]);
    expect(REQUESTER_CANCELLABLE_STATUSES).toEqual(["DRAFT", "SUBMITTED"]);
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

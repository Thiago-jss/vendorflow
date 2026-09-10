import { supplierQuoteSelectedPayload } from "./quote-audit";
import { purchaseRequestQuoteSelectedEventPayload } from "./quote-events";

const SELECTION_RATIONALE =
  "Lowest total with the shortest lead time of the three offers";

const AUDIT = supplierQuoteSelectedPayload({
  supplierQuoteId: "quote-1",
  supplierId: "supplier-1",
  totalCents: 9_007_199_254_740_993n,
  estimatedTotalCents: 500_001n,
  selectionRationale: SELECTION_RATIONALE,
  resultingStatus: "IN_FINAL_APPROVAL",
});

const EVENT = purchaseRequestQuoteSelectedEventPayload({
  status: "IN_FINAL_APPROVAL",
  supplierQuoteId: "quote-1",
  supplierId: "supplier-1",
  selectedTotalCents: 9_007_199_254_740_993n,
  requesterId: "user-1",
  selectedById: "user-2",
  approvalFlowId: "flow-1",
  approvalFlowState: "ACTIVE",
  actionableStepRole: "PURCHASING",
  actionableStepId: "step-2",
});

describe("what leaves the process when a quote is selected (ADR-003)", () => {
  it("carries every amount as a digit string, never a JSON number (BR-031)", () => {
    // 9,007,199,254,740,993 does not survive a double. It survives a string.
    expect(EVENT.selectedTotalCents).toBe("9007199254740993");
    expect(AUDIT.totalCents).toBe("9007199254740993");
    expect(AUDIT.estimatedTotalCents).toBe("500001");

    for (const value of Object.values({ ...EVENT, ...AUDIT })) {
      expect(typeof value).not.toBe("bigint");
    }
  });

  it("keeps the selection rationale in the audit trail and off the queue", () => {
    // FR-044's text is a buyer's written justification for choosing one supplier over another.
    // It is tenant-scoped and access-controlled in PostgreSQL; a queue is neither.
    expect(AUDIT.selectionRationale).toBe(SELECTION_RATIONALE);
    expect(JSON.stringify(EVENT)).not.toContain(SELECTION_RATIONALE);
    expect(Object.keys(EVENT)).not.toContain("selectionRationale");
  });

  it("names the supplier by identifier and never by name or fiscal identifier", () => {
    // Neither payload carries either, so neither can leak one. A consumer that needs the
    // supplier's details reads PostgreSQL under a tenant-scoped query.
    for (const payload of [EVENT, AUDIT]) {
      const keys = Object.keys(payload);

      expect(keys).toContain("supplierId");
      expect(keys).not.toContain("supplierLegalName");
      expect(keys).not.toContain("supplierTradeName");
      expect(keys).not.toContain("supplierTaxIdentifier");
      expect(keys).not.toContain("contactEmail");
      expect(keys).not.toContain("contactPhone");
    }
  });

  it("carries FR-062's next actor, so a consumer can notify without a second read", () => {
    expect(EVENT.actionableStepRole).toBe("PURCHASING");
    expect(EVENT.actionableStepId).toBe("step-2");
    expect(EVENT.requesterId).toBe("user-1");
  });

  it("reports no next actor when the ladder finished", () => {
    const finished = purchaseRequestQuoteSelectedEventPayload({
      status: "APPROVED",
      supplierQuoteId: "quote-1",
      supplierId: "supplier-1",
      selectedTotalCents: 100_000n,
      requesterId: "user-1",
      selectedById: "user-2",
      approvalFlowId: "flow-1",
      approvalFlowState: "COMPLETED",
      actionableStepRole: null,
      actionableStepId: null,
    });

    expect(finished.status).toBe("APPROVED");
    expect(finished.actionableStepRole).toBeNull();
    expect(finished.actionableStepId).toBeNull();
  });

  it("is scalar throughout, so a consumer's strict envelope schema accepts it", () => {
    for (const payload of [EVENT, AUDIT]) {
      for (const value of Object.values(payload)) {
        expect(["string", "number", "boolean"]).toContain(
          value === null ? "string" : typeof value,
        );
      }
    }
  });
});

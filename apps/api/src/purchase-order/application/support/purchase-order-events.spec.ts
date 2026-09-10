import {
  purchaseOrderCancelledPayload,
  purchaseOrderIssuedPayload,
} from "./purchase-order-audit";
import { purchaseOrderIssuedEventPayload } from "./purchase-order-events";

const CANCELLATION_REASON =
  "Supplier withdrew after a plant fire; reordering elsewhere";

const AUDIT = purchaseOrderIssuedPayload({
  number: "PO-000001",
  purchaseRequestId: "request-1",
  supplierQuoteId: "quote-1",
  supplierId: "supplier-1",
  itemCount: 2,
  itemsTotalCents: 9_007_199_254_740_993n,
  freightCents: 12_500n,
  discountCents: 0n,
  totalCents: 9_007_199_254_753_493n,
  deliveryLeadTimeDays: 15,
});

const EVENT = purchaseOrderIssuedEventPayload({
  number: "PO-000001",
  purchaseRequestId: "request-1",
  supplierQuoteId: "quote-1",
  supplierId: "supplier-1",
  totalCents: 9_007_199_254_753_493n,
  deliveryLeadTimeDays: 15,
  requesterId: "user-1",
  issuedById: "user-2",
});

describe("what leaves the process when a purchase order is issued (ADR-003)", () => {
  it("carries every amount as a digit string, never a JSON number (BR-031)", () => {
    expect(EVENT.totalCents).toBe("9007199254753493");
    expect(AUDIT.itemsTotalCents).toBe("9007199254740993");
    expect(AUDIT.freightCents).toBe("12500");
    expect(AUDIT.discountCents).toBe("0");
  });

  it("never carries the supplier's snapshotted legal name or fiscal identifier", () => {
    // The order row holds both, because FR-051 requires the document to record who it was
    // issued to. Neither goes on a queue, and neither is duplicated into the append-only trail.
    for (const payload of [EVENT, AUDIT]) {
      const keys = Object.keys(payload);

      expect(keys).toContain("supplierId");
      expect(keys).not.toContain("supplierLegalName");
      expect(keys).not.toContain("supplierTaxIdentifier");
      expect(keys).not.toContain("supplierTaxIdentifierType");
    }
  });

  it("names the order by its number, which is what a person will ask about", () => {
    expect(EVENT.number).toBe("PO-000001");
    expect(AUDIT.number).toBe("PO-000001");
  });

  it("carries FR-062's recipient, so a consumer can notify without a second read", () => {
    expect(EVENT.requesterId).toBe("user-1");
    expect(EVENT.issuedById).toBe("user-2");
    expect(EVENT.status).toBe("ISSUED");
  });

  it("keeps the cancellation reason in the audit trail, where the only copy lives", () => {
    // There is deliberately no cancellation event at all: FR-062 names next-actor, approval,
    // rejection and order-issued notifications, and nothing consumes a cancellation. So the
    // reason exists in exactly one place, and that place is tenant-scoped PostgreSQL.
    const cancelled = purchaseOrderCancelledPayload({
      number: "PO-000001",
      purchaseRequestId: "request-1",
      totalCents: 100_000n,
      cancellationReason: CANCELLATION_REASON,
    });

    expect(cancelled.cancellationReason).toBe(CANCELLATION_REASON);
    expect(JSON.stringify(EVENT)).not.toContain(CANCELLATION_REASON);
  });

  it("is scalar throughout, so a consumer's strict envelope schema accepts it", () => {
    for (const payload of [EVENT, AUDIT]) {
      for (const value of Object.values(payload)) {
        expect(["string", "number", "boolean"]).toContain(typeof value);
      }
    }
  });
});

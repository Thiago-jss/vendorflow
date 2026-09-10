import {
  supplierCreatedPayload,
  supplierDeactivatedPayload,
} from "./supplier-audit";

describe("what a Supplier audit payload carries (AUD-002, SEC-009)", () => {
  it("records the decision that was made and none of the supplier's data", () => {
    // The audited fact is "this actor registered a supplier", not "here is a copy of their
    // fiscal and contact data". The supplier is reachable by identifier under a tenant-scoped
    // authorized read; the trail is append-only and never deleted, so duplicating personal and
    // fiscal data into it would be a permanent copy nobody asked for.
    const created = supplierCreatedPayload({ taxIdentifierType: "CNPJ" });
    const keys = Object.keys(created);

    expect(keys).not.toContain("taxIdentifier");
    expect(keys).not.toContain("taxIdentifierNormalized");
    expect(keys).not.toContain("legalName");
    expect(keys).not.toContain("tradeName");
    expect(keys).not.toContain("contactEmail");
    expect(keys).not.toContain("contactPhone");
  });

  it("keeps the identifier *type*, because it says what was actually validated", () => {
    // "Registered as a check-digit validated CNPJ" and "registered as an unvalidated other
    // identifier" are different decisions, and the trail should say which one was made.
    expect(supplierCreatedPayload({ taxIdentifierType: "CNPJ" })).toEqual({
      taxIdentifierType: "CNPJ",
      isActive: true,
    });
    expect(supplierCreatedPayload({ taxIdentifierType: "OTHER" })).toEqual({
      taxIdentifierType: "OTHER",
      isActive: true,
    });
  });

  it("explains the consequence of a deactivation (FR-012)", () => {
    // How much history already points at the supplier is what makes the event readable later:
    // deactivating a supplier with 40 quotes is a different act from deactivating a new one.
    expect(supplierDeactivatedPayload({ registeredQuoteCount: 40 })).toEqual({
      isActive: false,
      registeredQuoteCount: 40,
    });
  });
});

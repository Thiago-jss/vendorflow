import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequestInput, BrowserSession } from "@/session/browser-session";
import { createSessionDouble } from "@/session/session-double";
import { deactivateSupplier, listSuppliers, registerSupplier } from "./api";
import type { SupplierRegistrationInput } from "./contracts";

function sessionRecording(
  handler: (input: AuthenticatedRequestInput) => Promise<unknown>
): { readonly session: BrowserSession; readonly calls: AuthenticatedRequestInput[] } {
  const calls: AuthenticatedRequestInput[] = [];
  const session = createSessionDouble({
    request: vi.fn(async (input: AuthenticatedRequestInput) => {
      calls.push(input);

      return (await handler(input)) as never;
    })
  });

  return { session, calls };
}

describe("supplier transport", () => {
  it("sends only the six declared fields on registration, nothing tenant or lifecycle", async () => {
    const { session, calls } = sessionRecording(async () => ({
      id: "supplier-1",
      legalName: "Papelaria Central Ltda",
      tradeName: "Papelaria Central",
      taxIdentifierType: "CNPJ",
      taxIdentifier: "11222333000181",
      contactEmail: "contato@example.com",
      contactPhone: "+55 11 4002-8922",
      isActive: true,
      deactivatedAt: null,
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z"
    }));

    await registerSupplier(session, {
      legalName: "Papelaria Central Ltda",
      tradeName: "Papelaria Central",
      taxIdentifierType: "CNPJ",
      taxIdentifier: "11.222.333/0001-81",
      contactEmail: "contato@example.com",
      contactPhone: "+55 11 4002-8922"
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/suppliers");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      legalName: "Papelaria Central Ltda",
      tradeName: "Papelaria Central",
      taxIdentifierType: "CNPJ",
      taxIdentifier: "11.222.333/0001-81",
      contactEmail: "contato@example.com",
      contactPhone: "+55 11 4002-8922"
    });
    expect(Object.keys(calls[0]?.body as object)).toHaveLength(6);
    expect(calls[0]?.idempotencyKey).toBeUndefined();
  });

  it("drops an undeclared field even if it rode along on the input object", async () => {
    const { session, calls } = sessionRecording(async () => ({}));

    // Simulates a caller whose draft object carries server-owned state. Cast at the boundary,
    // deliberately, rather than widening `SupplierRegistrationInput` itself.
    const smuggled = {
      legalName: "A",
      tradeName: "B",
      taxIdentifierType: "OTHER",
      taxIdentifier: "X",
      contactEmail: "a@b.com",
      contactPhone: "123",
      organizationId: "org-should-never-travel",
      isActive: true
    } as unknown as SupplierRegistrationInput;

    await registerSupplier(session, smuggled);

    expect(calls[0]?.body).not.toHaveProperty("organizationId");
    expect(calls[0]?.body).not.toHaveProperty("isActive");
  });

  it("forwards the opaque cursor and limit verbatim on list", async () => {
    const { session, calls } = sessionRecording(async () => ({ items: [], nextCursor: null }));

    await listSuppliers(session, { cursor: "cursor-xyz", limit: 25 });

    expect(calls[0]?.path).toBe("/suppliers?limit=25&cursor=cursor-xyz");
    expect(calls[0]?.method).toBeUndefined();
  });

  it("sends isActive=true and isActive=false for the active and inactive filters, and omits it for all", async () => {
    const { session, calls } = sessionRecording(async () => ({ items: [], nextCursor: null }));

    await listSuppliers(session, { activeFilter: "active" });
    await listSuppliers(session, { activeFilter: "inactive" });
    await listSuppliers(session, { activeFilter: "all" });
    await listSuppliers(session);

    expect(calls[0]?.path).toBe("/suppliers?isActive=true");
    expect(calls[1]?.path).toBe("/suppliers?isActive=false");
    expect(calls[2]?.path).toBe("/suppliers");
    expect(calls[3]?.path).toBe("/suppliers");
  });

  it("calls deactivate with no body and no idempotency key", async () => {
    const { session, calls } = sessionRecording(async () => ({
      id: "supplier-1",
      isActive: false
    }));

    await deactivateSupplier(session, "supplier-1");

    expect(calls[0]?.path).toBe("/suppliers/supplier-1/deactivate");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.idempotencyKey).toBeUndefined();
  });
});

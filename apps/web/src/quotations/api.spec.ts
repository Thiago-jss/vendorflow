import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/session/api-error";
import type { AuthenticatedRequestInput } from "@/session/browser-session";
import { createSessionDouble } from "@/session/session-double";
import {
  getQuotationWork,
  listActiveSuppliers,
  listQuotationQueue,
  registerQuote
} from "./api";
import type { QuoteRegistrationInput } from "./contracts";

const REQUEST_A = "1f8b7c62-5a4e-4f39-9a2b-0c6d1e5a7b31";
const ITEM_1 = "2a7c9e10-3b4d-4e5f-8a6b-7c8d9e0f1a2b";
const ITEM_2 = "3b8d0f21-4c5e-4f60-9b7c-8d9e0f1a2b3c";
const SUPPLIER_1 = "4c9e1a32-5d6f-4a71-8c8d-9e0f1a2b3c4d";

function recordingSession() {
  const calls: AuthenticatedRequestInput[] = [];
  const session = createSessionDouble({
    request: vi.fn(async (input: AuthenticatedRequestInput) => {
      calls.push(input);

      return {} as never;
    })
  });

  return { calls, session };
}

describe("quotation transport", () => {
  it("asks for the quotation queue without inventing a scope", async () => {
    const { calls, session } = recordingSession();

    await listQuotationQueue(session);

    expect(calls[0]).toEqual({ path: "/purchase-requests/awaiting-quotation" });
  });

  it("forwards the opaque queue cursor verbatim", async () => {
    const { calls, session } = recordingSession();

    await listQuotationQueue(session, { cursor: "opaque cursor/1", limit: 20 });

    expect(calls[0]?.path).toBe(
      "/purchase-requests/awaiting-quotation?limit=20&cursor=opaque+cursor%2F1"
    );
  });

  it("reads quotation work through the buyer route, never the requester's own read", async () => {
    const { calls, session } = recordingSession();

    await getQuotationWork(session, REQUEST_A);

    expect(calls[0]).toEqual({
      path: `/purchase-requests/awaiting-quotation/${REQUEST_A}`
    });
  });

  it("lists active suppliers through the supplier registry's own client", async () => {
    const { calls, session } = recordingSession();

    await listActiveSuppliers(session);
    await listActiveSuppliers(session, "supplier-cursor");

    expect(calls[0]?.path).toBe("/suppliers?limit=100&isActive=true");
    expect(calls[1]?.path).toBe("/suppliers?limit=100&cursor=supplier-cursor&isActive=true");
    expect(calls.every((call) => call.method === undefined)).toBe(true);
  });

  it("sends exactly the registration fields, with no idempotency key", async () => {
    const { calls, session } = recordingSession();

    await registerQuote(session, REQUEST_A, {
      supplierId: SUPPLIER_1,
      freightCents: "12500",
      discountCents: "0",
      validUntil: "2026-12-31",
      deliveryLeadTimeDays: 15,
      lines: [
        { purchaseRequestItemId: ITEM_1, unitPriceCents: "549900" },
        { purchaseRequestItemId: ITEM_2, unitPriceCents: "0" }
      ]
    });

    expect(calls).toEqual([
      {
        path: `/purchase-requests/${REQUEST_A}/quotes`,
        method: "POST",
        body: {
          supplierId: SUPPLIER_1,
          freightCents: "12500",
          discountCents: "0",
          validUntil: "2026-12-31",
          deliveryLeadTimeDays: 15,
          lines: [
            { purchaseRequestItemId: ITEM_1, unitPriceCents: "549900" },
            { purchaseRequestItemId: ITEM_2, unitPriceCents: "0" }
          ]
        }
      }
    ]);
    expect(calls[0]?.idempotencyKey).toBeUndefined();
  });

  it("drops quantities, totals, status, tenant and ui fields that ride along on the input", async () => {
    const { calls, session } = recordingSession();

    // A caller whose draft carries server-owned and presentation state. Cast at the boundary,
    // deliberately, rather than widening `QuoteRegistrationInput` itself.
    const smuggled = {
      supplierId: SUPPLIER_1,
      freightCents: "100",
      discountCents: "0",
      validUntil: "2026-12-31",
      deliveryLeadTimeDays: 3,
      organizationId: "organization-should-never-travel",
      status: "ACTIVE",
      totalCents: "999",
      itemsTotalCents: "899",
      supplierLabel: "Papelaria Central",
      lines: [
        {
          purchaseRequestItemId: ITEM_1,
          unitPriceCents: "899",
          quantity: "1.000",
          position: 1,
          description: "Papel A4",
          unitOfMeasure: "resma",
          lineTotalCents: "899"
        }
      ]
    } as unknown as QuoteRegistrationInput;

    await registerQuote(session, REQUEST_A, smuggled);

    const body = calls[0]?.body as { lines: object[] } & Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([
      "deliveryLeadTimeDays",
      "discountCents",
      "freightCents",
      "lines",
      "supplierId",
      "validUntil"
    ]);
    expect(body.lines).toEqual([{ purchaseRequestItemId: ITEM_1, unitPriceCents: "899" }]);
  });

  it("refuses an identifier that is not the route's uuid, before anything leaves", async () => {
    const { calls, session } = recordingSession();
    const input: QuoteRegistrationInput = {
      supplierId: SUPPLIER_1,
      freightCents: "0",
      discountCents: "0",
      validUntil: "2026-12-31",
      deliveryLeadTimeDays: 0,
      lines: []
    };

    await expect(getQuotationWork(session, "../purchase-requests")).rejects.toBeInstanceOf(
      ApiRequestError
    );
    await expect(getQuotationWork(session, `${REQUEST_A}/quotes`)).rejects.toBeInstanceOf(
      ApiRequestError
    );
    await expect(registerQuote(session, "awaiting-quotation", input)).rejects.toBeInstanceOf(
      ApiRequestError
    );
    await expect(registerQuote(session, `${REQUEST_A}?x=1`, input)).rejects.toBeInstanceOf(
      ApiRequestError
    );
    expect(calls).toHaveLength(0);
  });
});

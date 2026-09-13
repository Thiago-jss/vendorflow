import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ApiRequestError,
  networkFailure,
  normalizeApiFailure
} from "@/session/api-error";
import type { AuthenticatedRequestInput, BrowserSession } from "@/session/browser-session";
import { SessionProvider } from "@/session/session-context";
import { createSessionDouble, currentContextFixture } from "@/session/session-double";
import type { Supplier } from "@/suppliers/contracts";
import { QuotationWorkflow } from "./quotation-workflow";

const REQUEST_A = "1f8b7c62-5a4e-4f39-9a2b-0c6d1e5a7b31";
const REQUEST_B = "5d0f2b43-6e7a-4b82-9d9e-0f1a2b3c4d5e";
const ITEM_1 = "2a7c9e10-3b4d-4e5f-8a6b-7c8d9e0f1a2b";
const ITEM_2 = "3b8d0f21-4c5e-4f60-9b7c-8d9e0f1a2b3c";
const SUPPLIER_1 = "4c9e1a32-5d6f-4a71-8c8d-9e0f1a2b3c4d";

const QUEUE_PATH = "/purchase-requests/awaiting-quotation";
const SUPPLIERS_PATH = "/suppliers?limit=100&isActive=true";

/** A wire row, including the fields the queue deliberately does not render. */
function queueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_A,
    status: "IN_QUOTATION",
    neededBy: "2026-10-15",
    estimatedTotalCents: "687375",
    itemCount: 2,
    submittedAt: "2026-09-01T10:00:00.000Z",
    cancelledAt: null,
    createdAt: "2026-09-01T09:00:00.000Z",
    updatedAt: "2026-09-02T09:00:00.000Z",
    ...overrides
  };
}

function quotationWork(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_A,
    neededBy: "2026-10-15",
    items: [
      {
        id: ITEM_1,
        position: 1,
        description: "Papel sulfite A4",
        unitOfMeasure: "resma",
        quantity: "1.250"
      },
      {
        id: ITEM_2,
        position: 2,
        description: "Caneta esferográfica azul",
        unitOfMeasure: "unidade",
        quantity: "1000"
      }
    ],
    ...overrides
  };
}

function supplierFixture(overrides: Partial<Supplier> = {}): Supplier {
  return {
    id: SUPPLIER_1,
    legalName: "Papelaria Central Ltda",
    tradeName: "Papelaria Central",
    taxIdentifierType: "CNPJ",
    taxIdentifier: "11.222.333/0001-81",
    contactEmail: "contato@papelaria.example.com",
    contactPhone: "+55 11 4002-8922",
    isActive: true,
    deactivatedAt: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides
  };
}

function registeredQuote() {
  return {
    id: "6e1a3c54-7f8b-4c93-8e0f-1a2b3c4d5e6f",
    purchaseRequestId: REQUEST_A,
    supplierId: SUPPLIER_1,
    status: "ACTIVE",
    freightCents: "12500",
    discountCents: "1000",
    itemsTotalCents: "687375",
    totalCents: "698875",
    itemCount: 2,
    validUntil: "2026-12-31",
    deliveryLeadTimeDays: 15,
    registeredById: "user-1",
    selectionRationale: null,
    selectedById: null,
    selectedAt: null,
    withdrawnAt: null,
    createdAt: "2026-09-12T10:00:00.000Z",
    updatedAt: "2026-09-12T10:00:00.000Z",
    items: []
  };
}

/** A promise this test controls from the outside, to force a deterministic response order. */
function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function sessionWith(
  handler: (input: AuthenticatedRequestInput) => Promise<unknown>
): BrowserSession {
  return createSessionDouble({
    request: vi.fn(async (input: AuthenticatedRequestInput) => {
      if (input.path === "/me/organization") {
        return { ...currentContextFixture, membership: { ...currentContextFixture.membership, roles: ["BUYER"] } } as never;
      }

      return (await handler(input)) as never;
    })
  });
}

/** The ordinary happy backend. `onPost` decides what registration answers. */
function standardBackend(
  calls: AuthenticatedRequestInput[],
  onPost: (input: AuthenticatedRequestInput) => Promise<unknown> = async () => registeredQuote()
) {
  return async (input: AuthenticatedRequestInput): Promise<unknown> => {
    calls.push(input);

    if (input.method === "POST") {
      return onPost(input);
    }

    if (input.path === QUEUE_PATH) {
      return { items: [queueRow()], nextCursor: null };
    }

    if (input.path === `${QUEUE_PATH}/${REQUEST_A}`) {
      return quotationWork();
    }

    if (input.path === SUPPLIERS_PATH) {
      return { items: [supplierFixture()], nextCursor: null };
    }

    throw new Error(`unexpected path ${input.path}`);
  };
}

function renderWorkflow(session: BrowserSession) {
  render(
    <SessionProvider session={session}>
      <QuotationWorkflow />
    </SessionProvider>
  );
}

async function openFirstRow() {
  const buttons = await screen.findAllByRole("button", { name: /^Cotar/u });
  await userEvent.click(buttons[0] as HTMLElement);
  await screen.findByLabelText("Fornecedor");
}

async function fillQuoteForm() {
  await userEvent.selectOptions(screen.getByLabelText("Fornecedor"), SUPPLIER_1);
  await userEvent.type(screen.getByLabelText("Preço unitário do item 1"), "549900");
  await userEvent.type(screen.getByLabelText("Preço unitário do item 2"), "0");
  await userEvent.type(screen.getByLabelText("Frete (centavos)"), "12500");
  await userEvent.type(screen.getByLabelText("Desconto (centavos)"), "1000");
  fireEvent.change(screen.getByLabelText("Válida até"), { target: { value: "2026-12-31" } });
  await userEvent.type(screen.getByLabelText("Prazo de entrega (dias)"), "15");
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("quotation queue", () => {
  it("announces that it is loading before the first page arrives", async () => {
    renderWorkflow(sessionWith(async () => new Promise(() => {})));

    const loading = await screen.findByText("Carregando a fila de cotação...");

    expect(loading.getAttribute("aria-busy")).toBe("true");
  });

  it("shows an empty state when nothing awaits quotation", async () => {
    renderWorkflow(sessionWith(async () => ({ items: [], nextCursor: null })));

    expect(await screen.findByText("Nenhuma solicitação aguarda cotação.")).toBeDefined();
  });

  it("renders a failed load as normalized feedback and retries only when asked", async () => {
    let attempts = 0;
    renderWorkflow(
      sessionWith(async () => {
        attempts += 1;

        if (attempts === 1) {
          throw new ApiRequestError(
            normalizeApiFailure(503, { message: "<h1>upstream exploded</h1>" })
          );
        }

        return { items: [queueRow()], nextCursor: null };
      })
    );

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain("O servidor não conseguiu concluir a operação");
    expect(alert.textContent).not.toContain("upstream exploded");
    await flush();
    expect(attempts).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(await screen.findByText("15/10/2026")).toBeDefined();
    expect(attempts).toBe(2);
  });

  it("renders the summary without estimates or requester data", async () => {
    renderWorkflow(sessionWith(async () => ({ items: [queueRow()], nextCursor: null })));

    await screen.findByText("15/10/2026");

    expect(screen.queryByText(/6\.873,75/u)).toBeNull();
    expect(screen.queryByText(/estimad/iu)).toBeNull();
    expect(screen.getByText("Fim da fila.")).toBeDefined();
  });

  it("walks forward with the opaque cursor the api returned", async () => {
    const paths: string[] = [];
    renderWorkflow(
      sessionWith(async (input) => {
        paths.push(input.path);

        return paths.length === 1
          ? { items: [queueRow()], nextCursor: "opaque/cursor+2" }
          : { items: [queueRow({ id: REQUEST_B, neededBy: "2026-11-20" })], nextCursor: null };
      })
    );

    await userEvent.click(await screen.findByRole("button", { name: "Carregar mais" }));

    expect(await screen.findByText("20/11/2026")).toBeDefined();
    expect(screen.getByText("15/10/2026")).toBeDefined();
    expect(paths).toEqual([QUEUE_PATH, `${QUEUE_PATH}?cursor=opaque%2Fcursor%2B2`]);
  });

  it("ignores a stale page that resolves after a fresh reload", async () => {
    const secondPage = deferred<unknown>();
    let firstPageReads = 0;

    renderWorkflow(
      sessionWith(async (input) => {
        if (input.path === QUEUE_PATH) {
          firstPageReads += 1;

          return firstPageReads === 1
            ? { items: [queueRow()], nextCursor: "cursor-2" }
            : { items: [queueRow({ neededBy: "2026-12-01" })], nextCursor: null };
        }

        return secondPage.promise;
      })
    );

    await userEvent.click(await screen.findByRole("button", { name: "Carregar mais" }));
    await userEvent.click(screen.getByRole("button", { name: "Atualizar fila" }));

    expect(await screen.findByText("01/12/2026")).toBeDefined();
    expect(screen.getByText("Fim da fila.")).toBeDefined();

    secondPage.resolve({
      items: [queueRow({ id: REQUEST_B, neededBy: "2027-01-05" })],
      nextCursor: "cursor-3"
    });
    await flush();

    expect(screen.queryByText("05/01/2027")).toBeNull();
    expect(screen.getByText("Fim da fila.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Carregar mais" })).toBeNull();
  });
});

describe("quotation workspace", () => {
  it("reads only the quotation-work route and active suppliers, and renders exact quantities", async () => {
    const calls: AuthenticatedRequestInput[] = [];
    renderWorkflow(sessionWith(standardBackend(calls)));

    await openFirstRow();

    const paths = calls.map((call) => call.path);

    expect(paths).toContain(`${QUEUE_PATH}/${REQUEST_A}`);
    expect(paths).toContain(SUPPLIERS_PATH);
    // Never the requester-owned read, and never a single-supplier read.
    expect(paths).not.toContain(`/purchase-requests/${REQUEST_A}`);
    expect(paths.some((path) => /^\/purchase-requests\/[0-9a-f-]{36}(?:\?|$)/u.test(path))).toBe(false);
    expect(paths.some((path) => /^\/suppliers\/[^/?]+/u.test(path))).toBe(false);

    const table = screen.getByRole("table", { name: "Preço unitário por item da solicitação" });

    expect(within(table).getByText("Papel sulfite A4")).toBeDefined();
    expect(within(table).getByText("1,250")).toBeDefined();
    expect(within(table).getByText("1.000")).toBeDefined();
    expect(within(table).getByText("resma")).toBeDefined();
    expect(screen.getByText(REQUEST_A)).toBeDefined();
    // Item identifiers are operational, not content.
    expect(screen.queryByText(ITEM_1)).toBeNull();
    expect(
      screen.getByRole("option", { name: "Papelaria Central — Papelaria Central Ltda" })
    ).toBeDefined();
  });

  it("refuses an incomplete form locally before any registration leaves", async () => {
    const calls: AuthenticatedRequestInput[] = [];
    renderWorkflow(sessionWith(standardBackend(calls)));

    await openFirstRow();
    await userEvent.type(screen.getByLabelText("Frete (centavos)"), "12,50");
    await userEvent.click(screen.getByRole("button", { name: "Registrar cotação" }));

    const supplier = screen.getByLabelText("Fornecedor");

    expect(screen.getByText("Selecione um fornecedor ativo.")).toBeDefined();
    expect(screen.getByText("Use apenas dígitos, sem sinal, separador ou zeros à esquerda.")).toBeDefined();
    expect(screen.getAllByText("Informe o preço unitário deste item.")).toHaveLength(2);
    expect(supplier.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(supplier);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("refuses a lead time outside the declared bounds", async () => {
    const calls: AuthenticatedRequestInput[] = [];
    renderWorkflow(sessionWith(standardBackend(calls)));

    await openFirstRow();
    await fillQuoteForm();
    await userEvent.clear(screen.getByLabelText("Prazo de entrega (dias)"));
    await userEvent.type(screen.getByLabelText("Prazo de entrega (dias)"), "731");
    await userEvent.click(screen.getByRole("button", { name: "Registrar cotação" }));

    expect(screen.getByText("Use um número inteiro de dias, de 0 a 730.")).toBeDefined();
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("sends the exact registration body, confirms with server totals and reconciles the queue", async () => {
    const calls: AuthenticatedRequestInput[] = [];
    let registeredOnce = false;
    const backend = standardBackend(calls, async () => {
      registeredOnce = true;

      return registeredQuote();
    });

    renderWorkflow(
      sessionWith(async (input) => {
        if (input.path === QUEUE_PATH && registeredOnce) {
          calls.push(input);

          return { items: [], nextCursor: null };
        }

        return backend(input);
      })
    );

    await openFirstRow();
    await fillQuoteForm();
    await userEvent.click(screen.getByRole("button", { name: "Registrar cotação" }));

    const status = await screen.findByRole("status");

    expect(status.textContent).toContain("R$ 6.988,75");
    expect(status.textContent).toContain("itens R$ 6.873,75");
    expect(status.textContent).toContain("frete R$ 125,00");
    expect(status.textContent).toContain("desconto R$ 10,00");
    expect(status.textContent).toContain("válida até 31/12/2026");
    expect(status.textContent).toContain("entrega em 15 dias");

    const posts = calls.filter((call) => call.method === "POST");

    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({
      path: `/purchase-requests/${REQUEST_A}/quotes`,
      method: "POST",
      body: {
        supplierId: SUPPLIER_1,
        freightCents: "12500",
        discountCents: "1000",
        validUntil: "2026-12-31",
        deliveryLeadTimeDays: 15,
        lines: [
          { purchaseRequestItemId: ITEM_1, unitPriceCents: "549900" },
          { purchaseRequestItemId: ITEM_2, unitPriceCents: "0" }
        ]
      }
    });
    expect(posts[0]?.idempotencyKey).toBeUndefined();

    const body = JSON.stringify(posts[0]?.body);

    for (const forbidden of [
      "quantity",
      "position",
      "description",
      "unitOfMeasure",
      "Total",
      "status",
      "organizationId",
      "estimated"
    ]) {
      expect(body).not.toContain(forbidden);
    }

    // Workspace closed, and the queue re-read from its first page after the POST.
    await waitFor(() => {
      expect(screen.getByText("Nenhuma solicitação aguarda cotação.")).toBeDefined();
    });
    expect(screen.queryByLabelText("Fornecedor")).toBeNull();

    const postIndex = calls.findIndex((call) => call.method === "POST");
    const reloadIndex = calls.findLastIndex((call) => call.path === QUEUE_PATH);

    expect(reloadIndex).toBeGreaterThan(postIndex);
  });

  it("cannot send a duplicate registration while one is in flight", async () => {
    const calls: AuthenticatedRequestInput[] = [];
    const pending = deferred<unknown>();
    renderWorkflow(sessionWith(standardBackend(calls, () => pending.promise)));

    await openFirstRow();
    await fillQuoteForm();

    const submit = screen.getByRole("button", { name: "Registrar cotação" });
    const form = submit.closest("form") as HTMLFormElement;

    // Two submissions in the same tick, before React can re-render the disabled button.
    fireEvent.submit(form);
    fireEvent.submit(form);
    await flush();

    expect(screen.getByRole("button", { name: "Enviando..." })).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByRole("button", { name: "Enviando..." }));
    fireEvent.submit(form);
    await flush();

    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    // Nor can another request's workspace be opened under it.
    expect(screen.getByRole("button", { name: /^Cotar/u })).toHaveProperty("disabled", true);

    pending.resolve(registeredQuote());

    expect(await screen.findByRole("status")).toBeDefined();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("treats a network failure as unconfirmed, keeps the draft and never retries on its own", async () => {
    const calls: AuthenticatedRequestInput[] = [];
    renderWorkflow(
      sessionWith(
        standardBackend(calls, async () => {
          throw new ApiRequestError(networkFailure());
        })
      )
    );

    await openFirstRow();
    await fillQuoteForm();
    await userEvent.click(screen.getByRole("button", { name: "Registrar cotação" }));

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain("Não foi possível falar com o servidor");
    expect(alert.textContent).toContain("Não é possível saber se a operação foi concluída");
    expect(screen.getByLabelText("Preço unitário do item 1")).toHaveProperty("value", "549900");
    expect(screen.getByLabelText("Fornecedor")).toHaveProperty("value", SUPPLIER_1);

    await flush();
    await flush();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);

    // The explicit reload looks at the queue; it does not resend the registration.
    await userEvent.click(within(alert).getByRole("button", { name: "Recarregar fila" }));
    await flush();

    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(screen.getByLabelText("Preço unitário do item 1")).toHaveProperty("value", "549900");

    // Only a deliberate click sends a second attempt.
    await userEvent.click(screen.getByRole("button", { name: "Tentar registrar novamente" }));
    await waitFor(() => {
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
    });
  });

  it.each([
    [429, "Muitas tentativas em pouco tempo"],
    [500, "O servidor não conseguiu concluir a operação"]
  ])("treats a %i registration answer as unconfirmed without retrying", async (status, message) => {
    const calls: AuthenticatedRequestInput[] = [];
    renderWorkflow(
      sessionWith(
        standardBackend(calls, async () => {
          throw new ApiRequestError(normalizeApiFailure(status, { message: "raw backend text" }));
        })
      )
    );

    await openFirstRow();
    await fillQuoteForm();
    await userEvent.click(screen.getByRole("button", { name: "Registrar cotação" }));

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toContain("Não é possível saber se a operação foi concluída");
    expect(alert.textContent).not.toContain("raw backend text");
    await flush();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("renders a definitive conflict through the normalized failure, without raw text", async () => {
    const calls: AuthenticatedRequestInput[] = [];
    renderWorkflow(
      sessionWith(
        standardBackend(calls, async () => {
          throw new ApiRequestError(
            normalizeApiFailure(409, { message: "supplier already has an active quote" })
          );
        })
      )
    );

    await openFirstRow();
    await fillQuoteForm();
    await userEvent.click(screen.getByRole("button", { name: "Registrar cotação" }));

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain("O estado atual do registro não permite esta ação");
    expect(alert.textContent).not.toContain("supplier already has an active quote");
    expect(alert.textContent).not.toContain("Não é possível saber");
    expect(screen.getByRole("button", { name: "Registrar cotação" })).toBeDefined();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("never lets an earlier request's detail populate a newer workspace", async () => {
    const detailA = deferred<unknown>();

    renderWorkflow(
      sessionWith(async (input) => {
        if (input.path === QUEUE_PATH) {
          return {
            items: [queueRow(), queueRow({ id: REQUEST_B, neededBy: "2026-11-20" })],
            nextCursor: null
          };
        }

        if (input.path === `${QUEUE_PATH}/${REQUEST_A}`) {
          return detailA.promise;
        }

        if (input.path === `${QUEUE_PATH}/${REQUEST_B}`) {
          return quotationWork({
            id: REQUEST_B,
            neededBy: "2026-11-20",
            items: [
              {
                id: ITEM_2,
                position: 1,
                description: "Grampeador de mesa",
                unitOfMeasure: "unidade",
                quantity: "3"
              }
            ]
          });
        }

        if (input.path === SUPPLIERS_PATH) {
          return { items: [supplierFixture()], nextCursor: null };
        }

        throw new Error(`unexpected path ${input.path}`);
      })
    );

    const buttons = await screen.findAllByRole("button", { name: /^Cotar/u });

    await userEvent.click(buttons[0] as HTMLElement);
    expect(screen.getByText("Carregando itens da solicitação...")).toBeDefined();
    await userEvent.click(buttons[1] as HTMLElement);

    expect(await screen.findByText("Grampeador de mesa")).toBeDefined();

    detailA.resolve(quotationWork());
    await flush();

    expect(screen.queryByText("Papel sulfite A4")).toBeNull();
    expect(screen.getByText("Grampeador de mesa")).toBeDefined();
    expect(screen.getByText(REQUEST_B)).toBeDefined();
  });

  it("never lets an earlier request's failed read replace a newer workspace", async () => {
    const detailA = deferred<unknown>();

    renderWorkflow(
      sessionWith(async (input) => {
        if (input.path === QUEUE_PATH) {
          return {
            items: [queueRow(), queueRow({ id: REQUEST_B, neededBy: "2026-11-20" })],
            nextCursor: null
          };
        }

        if (input.path === `${QUEUE_PATH}/${REQUEST_A}`) {
          return detailA.promise;
        }

        if (input.path === `${QUEUE_PATH}/${REQUEST_B}`) {
          return quotationWork({ id: REQUEST_B });
        }

        return { items: [supplierFixture()], nextCursor: null };
      })
    );

    const buttons = await screen.findAllByRole("button", { name: /^Cotar/u });

    await userEvent.click(buttons[0] as HTMLElement);
    await userEvent.click(buttons[1] as HTMLElement);
    await screen.findByText(REQUEST_B);

    detailA.reject(new ApiRequestError(normalizeApiFailure(404, {})));
    await flush();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Fornecedor")).toBeDefined();
  });

  it("renders a failed quotation-work read as normalized feedback and retries when asked", async () => {
    let reads = 0;

    renderWorkflow(
      sessionWith(async (input) => {
        if (input.path === QUEUE_PATH) {
          return { items: [queueRow()], nextCursor: null };
        }

        if (input.path === `${QUEUE_PATH}/${REQUEST_A}`) {
          reads += 1;

          if (reads === 1) {
            throw new ApiRequestError(normalizeApiFailure(404, { message: "not in quotation" }));
          }

          return quotationWork();
        }

        return { items: [supplierFixture()], nextCursor: null };
      })
    );

    await userEvent.click(await screen.findByRole("button", { name: /^Cotar/u }));

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain("Registro não encontrado.");
    expect(alert.textContent).not.toContain("not in quotation");

    await userEvent.click(within(alert).getByRole("button", { name: "Tentar novamente" }));

    expect(await screen.findByText("Papel sulfite A4")).toBeDefined();
    expect(reads).toBe(2);
  });
});

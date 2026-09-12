import { render, screen, waitFor } from "@testing-library/react";
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
import type { Supplier } from "./contracts";
import { SupplierRegistry } from "./supplier-registry";

function supplierFixture(overrides: Partial<Supplier> = {}): Supplier {
  return {
    id: "supplier-1",
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
        return currentContextFixture as never;
      }

      return (await handler(input)) as never;
    })
  });
}

function renderRegistry(session: BrowserSession) {
  render(
    <SessionProvider session={session}>
      <SupplierRegistry />
    </SessionProvider>
  );
}

async function fillRegistrationForm(overrides: Partial<Record<string, string>> = {}) {
  const values = {
    legalName: "Papelaria Central Ltda",
    tradeName: "Papelaria Central",
    taxIdentifier: "11.222.333/0001-81",
    contactEmail: "contato@papelaria.example.com",
    contactPhone: "+55 11 4002-8922",
    ...overrides
  };

  await userEvent.type(screen.getByLabelText("Razão social"), values.legalName);
  await userEvent.type(screen.getByLabelText("Nome fantasia"), values.tradeName);
  await userEvent.type(screen.getByLabelText("Identificador fiscal"), values.taxIdentifier);
  await userEvent.type(screen.getByLabelText("E-mail de contato"), values.contactEmail);
  await userEvent.type(screen.getByLabelText("Telefone de contato"), values.contactPhone);
}

describe("supplier registry list", () => {
  it("announces that it is loading before the first page arrives", async () => {
    renderRegistry(sessionWith(async () => new Promise(() => {})));

    const loading = await screen.findByText("Carregando fornecedores...");

    expect(loading.getAttribute("aria-busy")).toBe("true");
  });

  it("renders exactly what the list contract publishes", async () => {
    const paths: string[] = [];
    renderRegistry(
      sessionWith(async (input) => {
        paths.push(input.path);

        return { items: [supplierFixture()], nextCursor: null };
      })
    );

    expect(await screen.findByText("Papelaria Central Ltda")).toBeDefined();
    expect(screen.getByText("Papelaria Central")).toBeDefined();
    expect(screen.getByText("CNPJ · 11.222.333/0001-81")).toBeDefined();
    expect(screen.getByText("contato@papelaria.example.com")).toBeDefined();
    expect(screen.getByText("+55 11 4002-8922")).toBeDefined();
    expect(screen.getByText("Ativo")).toBeDefined();
    expect(screen.getByText("Fim da lista.")).toBeDefined();
    expect(paths).toEqual(["/suppliers"]);
  });

  it("shows an empty state when the filter returns nothing", async () => {
    renderRegistry(sessionWith(async () => ({ items: [], nextCursor: null })));

    expect(
      await screen.findByText("Nenhum fornecedor encontrado para este filtro.")
    ).toBeDefined();
  });

  it("walks forward with the opaque cursor the api returned", async () => {
    const paths: string[] = [];
    renderRegistry(
      sessionWith(async (input) => {
        paths.push(input.path);

        return paths.length === 1
          ? { items: [supplierFixture({ id: "supplier-1" })], nextCursor: "cursor-2" }
          : {
              items: [supplierFixture({ id: "supplier-2", tradeName: "Distribuidora Sul" })],
              nextCursor: null
            };
      })
    );

    await userEvent.click(await screen.findByRole("button", { name: "Carregar mais" }));

    await waitFor(() => {
      expect(screen.getByText("Distribuidora Sul")).toBeDefined();
    });
    expect(screen.getByText("Papelaria Central")).toBeDefined();
    expect(paths).toEqual(["/suppliers", "/suppliers?cursor=cursor-2"]);
  });

  it("resets to a fresh first page instead of mixing pages when the filter changes", async () => {
    const paths: string[] = [];
    renderRegistry(
      sessionWith(async (input) => {
        paths.push(input.path);

        if (input.path === "/suppliers?isActive=false") {
          return {
            items: [supplierFixture({ id: "supplier-2", tradeName: "Inativa Ltda", isActive: false })],
            nextCursor: null
          };
        }

        return { items: [supplierFixture()], nextCursor: null };
      })
    );

    await screen.findByText("Papelaria Central");

    await userEvent.click(screen.getByRole("button", { name: "Inativos" }));

    await waitFor(() => {
      expect(screen.getByText("Inativa Ltda")).toBeDefined();
    });
    // The active-filter's row must not survive into the inactive-filter's page.
    expect(screen.queryByText("Papelaria Central")).toBeNull();
    expect(paths).toEqual(["/suppliers", "/suppliers?isActive=false"]);
  });

  it("ignores a stale filter response that resolves after a newer filter's response", async () => {
    const activeRequest = deferred<{ items: Supplier[]; nextCursor: string | null }>();
    const inactiveRequest = deferred<{ items: Supplier[]; nextCursor: string | null }>();
    const paths: string[] = [];

    renderRegistry(
      sessionWith(async (input) => {
        paths.push(input.path);

        if (input.path === "/suppliers") {
          return { items: [], nextCursor: null };
        }

        if (input.path === "/suppliers?isActive=true") {
          return activeRequest.promise;
        }

        if (input.path === "/suppliers?isActive=false") {
          return inactiveRequest.promise;
        }

        throw new Error(`unexpected path ${input.path}`);
      })
    );

    await screen.findByText("Nenhum fornecedor encontrado para este filtro.");

    // The first filter is chosen, and its request is left pending...
    await userEvent.click(screen.getByRole("button", { name: "Ativos" }));
    // ...then the user changes their mind before it resolves, starting a second, newer query.
    await userEvent.click(screen.getByRole("button", { name: "Inativos" }));

    // The newer query settles first.
    inactiveRequest.resolve({
      items: [supplierFixture({ id: "supplier-2", tradeName: "Inativa Ltda", isActive: false })],
      nextCursor: "cursor-inactive"
    });

    await waitFor(() => {
      expect(screen.getByText("Inativa Ltda")).toBeDefined();
    });
    expect(screen.getByRole("button", { name: "Carregar mais" })).toBeDefined();

    // The stale, superseded query for the old filter resolves afterwards, with a different
    // row and a different (here, exhausted) cursor.
    activeRequest.resolve({
      items: [supplierFixture({ id: "supplier-1", tradeName: "Ativa Antiga" })],
      nextCursor: null
    });

    // Let the resolved-but-stale promise's continuation run, if the guard failed to stop it.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The stale rows never appear, and the newer filter's own rows and cursor still stand:
    // if the stale response had won, this row would be gone and "Carregar mais" would have
    // been replaced by "Fim da lista.".
    expect(screen.queryByText("Ativa Antiga")).toBeNull();
    expect(screen.getByText("Inativa Ltda")).toBeDefined();
    expect(screen.getByRole("button", { name: "Carregar mais" })).toBeDefined();
    expect(screen.queryByText("Fim da lista.")).toBeNull();
  });

  it("ignores a stale filter failure that arrives after a newer filter already succeeded", async () => {
    const activeRequest = deferred<{ items: Supplier[]; nextCursor: string | null }>();

    renderRegistry(
      sessionWith(async (input) => {
        if (input.path === "/suppliers?isActive=true") {
          return activeRequest.promise;
        }

        return { items: [], nextCursor: null };
      })
    );

    await screen.findByText("Nenhum fornecedor encontrado para este filtro.");

    await userEvent.click(screen.getByRole("button", { name: "Ativos" }));
    // A newer filter switch supersedes the pending request above before it ever resolves.
    await userEvent.click(screen.getByRole("button", { name: "Todos" }));
    await waitFor(() => {
      expect(screen.getByText("Nenhum fornecedor encontrado para este filtro.")).toBeDefined();
    });

    // The stale request now fails. It must not resurrect the load-failure banner once a newer
    // query has already moved the screen on.
    activeRequest.reject(new ApiRequestError(normalizeApiFailure(500, { message: "boom" })));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Nenhum fornecedor encontrado para este filtro.")).toBeDefined();
  });

  it("never lets a switched-away-from filter's late answer become visible, even resolved right at the click", async () => {
    const activeRequest = deferred<{ items: Supplier[]; nextCursor: string | null }>();

    renderRegistry(
      sessionWith(async (input) => {
        if (input.path === "/suppliers") {
          return { items: [], nextCursor: null };
        }

        if (input.path === "/suppliers?isActive=true") {
          return activeRequest.promise;
        }

        return { items: [supplierFixture({ id: "supplier-2", tradeName: "Inativa Ltda", isActive: false })], nextCursor: null };
      })
    );

    await screen.findByText("Nenhum fornecedor encontrado para este filtro.");

    await userEvent.click(screen.getByRole("button", { name: "Ativos" }));

    // Resolve the about-to-be-superseded request and switch filters immediately afterwards,
    // with no intervening `await` — the closest a test can force the old answer to land as
    // early as possible relative to the filter switch.
    activeRequest.resolve({
      items: [supplierFixture({ id: "supplier-1", tradeName: "Ativa Antiga" })],
      nextCursor: null
    });
    await userEvent.click(screen.getByRole("button", { name: "Inativos" }));

    expect(screen.getByText("Inativa Ltda")).toBeDefined();
    expect(screen.queryByText("Ativa Antiga")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not issue a redundant request when the already-selected filter is clicked again", async () => {
    const paths: string[] = [];

    renderRegistry(
      sessionWith(async (input) => {
        paths.push(input.path);

        return { items: [supplierFixture()], nextCursor: null };
      })
    );

    await screen.findByText("Papelaria Central");
    expect(paths).toEqual(["/suppliers"]);

    await userEvent.click(screen.getByRole("button", { name: "Todos" }));

    // "Todos" is already selected: no new request, and nothing gets re-fetched.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(paths).toEqual(["/suppliers"]);
  });

  it("does not invalidate its own in-flight request when the active filter is clicked again", async () => {
    const activeRequest = deferred<{ items: Supplier[]; nextCursor: string | null }>();

    renderRegistry(
      sessionWith(async (input) => {
        if (input.path === "/suppliers") {
          return { items: [], nextCursor: null };
        }

        if (input.path === "/suppliers?isActive=true") {
          return activeRequest.promise;
        }

        throw new Error(`unexpected path ${input.path}`);
      })
    );

    await screen.findByText("Nenhum fornecedor encontrado para este filtro.");

    await userEvent.click(screen.getByRole("button", { name: "Ativos" }));
    // Re-selecting the filter that is already active must be a no-op: in particular, it must
    // not invalidate the generation of the request already in flight for that same filter —
    // there is no new `loadPage` call to mint a fresh one, since React does not re-run the
    // effect for a state value that did not change.
    await userEvent.click(screen.getByRole("button", { name: "Ativos" }));

    activeRequest.resolve({
      items: [supplierFixture({ tradeName: "Ainda Ativa" })],
      nextCursor: null
    });

    await waitFor(() => {
      expect(screen.getByText("Ainda Ativa")).toBeDefined();
    });
  });

  it("renders a forbidden load as controlled feedback", async () => {
    renderRegistry(
      sessionWith(async () => {
        throw new ApiRequestError(normalizeApiFailure(403, { message: "Not allowed" }));
      })
    );

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain("Você não tem permissão para executar esta ação");
  });

  it("renders a rate-limited load as recoverable and retries only when asked", async () => {
    let attempts = 0;
    renderRegistry(
      sessionWith(async () => {
        attempts += 1;

        if (attempts === 1) {
          throw new ApiRequestError(normalizeApiFailure(429, {}));
        }

        return { items: [supplierFixture()], nextCursor: null };
      })
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Muitas tentativas em pouco tempo"
    );
    expect(attempts).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(await screen.findByText("Papelaria Central")).toBeDefined();
  });

  it("never calls the single-supplier detail route", async () => {
    const paths: string[] = [];
    renderRegistry(
      sessionWith(async (input) => {
        paths.push(input.path);

        return { items: [supplierFixture()], nextCursor: null };
      })
    );

    await screen.findByText("Papelaria Central");

    expect(paths.some((path) => /^\/suppliers\/[^/?]+(?:\?|$)/u.test(path))).toBe(false);
  });
});

describe("supplier registration", () => {
  it("refuses an empty form accessibly and moves focus to the first invalid field", async () => {
    renderRegistry(sessionWith(async () => ({ items: [], nextCursor: null })));

    await userEvent.click(await screen.findByRole("button", { name: "Novo fornecedor" }));
    await userEvent.click(screen.getByRole("button", { name: "Cadastrar fornecedor" }));

    const field = screen.getByLabelText("Razão social");
    const error = screen.getByText("Informe a razão social.");

    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(error.getAttribute("id"));
    expect(document.activeElement).toBe(field);
  });

  it("rejects a malformed e-mail locally before any request leaves", async () => {
    const calls: AuthenticatedRequestInput[] = [];
    renderRegistry(
      sessionWith(async (input) => {
        calls.push(input);

        return { items: [], nextCursor: null };
      })
    );

    await userEvent.click(await screen.findByRole("button", { name: "Novo fornecedor" }));
    await fillRegistrationForm({ contactEmail: "not-an-email" });
    await userEvent.click(screen.getByRole("button", { name: "Cadastrar fornecedor" }));

    expect(screen.getByText("Informe um e-mail válido.")).toBeDefined();
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("sends exactly the six declared fields and renders the server's own response on success", async () => {
    const calls: AuthenticatedRequestInput[] = [];
    renderRegistry(
      sessionWith(async (input) => {
        calls.push(input);

        if (input.method === "POST") {
          return supplierFixture({ id: "supplier-9", tradeName: "Nova Fornecedora" });
        }

        return calls.filter((call) => call.method === "POST").length === 0
          ? { items: [], nextCursor: null }
          : { items: [supplierFixture({ id: "supplier-9", tradeName: "Nova Fornecedora" })], nextCursor: null };
      })
    );

    await userEvent.click(await screen.findByRole("button", { name: "Novo fornecedor" }));
    await fillRegistrationForm();
    await userEvent.selectOptions(screen.getByLabelText("Tipo de identificador fiscal"), "CNPJ");
    await userEvent.click(screen.getByRole("button", { name: "Cadastrar fornecedor" }));

    expect(await screen.findByRole("status")).toBeDefined();
    expect(screen.getByRole("status").textContent).toContain("Nova Fornecedora");
    expect(screen.getByText("Nova Fornecedora")).toBeDefined();
    expect(screen.queryByLabelText("Razão social")).toBeNull();

    const registration = calls.find((call) => call.method === "POST");

    expect(registration?.path).toBe("/suppliers");
    expect(registration?.body).toEqual({
      legalName: "Papelaria Central Ltda",
      tradeName: "Papelaria Central",
      taxIdentifierType: "CNPJ",
      taxIdentifier: "11.222.333/0001-81",
      contactEmail: "contato@papelaria.example.com",
      contactPhone: "+55 11 4002-8922"
    });
    expect(registration?.idempotencyKey).toBeUndefined();
  });

  it("does not normalize an OTHER identifier locally", async () => {
    const calls: AuthenticatedRequestInput[] = [];
    renderRegistry(
      sessionWith(async (input) => {
        calls.push(input);

        return input.method === "POST"
          ? supplierFixture({ taxIdentifierType: "OTHER", taxIdentifier: " abc-123 " })
          : { items: [], nextCursor: null };
      })
    );

    await userEvent.click(await screen.findByRole("button", { name: "Novo fornecedor" }));
    await fillRegistrationForm({ taxIdentifier: "  abc-123  " });
    await userEvent.selectOptions(screen.getByLabelText("Tipo de identificador fiscal"), "OTHER");
    await userEvent.click(screen.getByRole("button", { name: "Cadastrar fornecedor" }));

    await screen.findByRole("status");

    const registration = calls.find((call) => call.method === "POST");

    expect(registration?.body).toMatchObject({
      taxIdentifierType: "OTHER",
      taxIdentifier: "  abc-123  "
    });
  });

  it("treats a network failure as ambiguous, does not retry automatically, and offers a reload", async () => {
    let attempts = 0;
    renderRegistry(
      sessionWith(async (input) => {
        if (input.method !== "POST") {
          return { items: [], nextCursor: null };
        }

        attempts += 1;
        throw new ApiRequestError(networkFailure());
      })
    );

    await userEvent.click(await screen.findByRole("button", { name: "Novo fornecedor" }));
    await fillRegistrationForm();
    await userEvent.click(screen.getByRole("button", { name: "Cadastrar fornecedor" }));

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain("Não foi possível falar com o servidor");
    expect(alert.textContent).toContain("Não é possível saber se a operação foi concluída");
    // The form stays open: nothing was auto-retried, and the person still has their draft.
    expect(screen.getByLabelText("Razão social")).toBeDefined();
    expect(attempts).toBe(1);

    await userEvent.click(
      screen.getByRole("button", { name: "Recarregar lista antes de tentar de novo" })
    );

    await waitFor(() => {
      expect(attempts).toBe(1);
    });
  });

  it("renders a 409 registration conflict through the normalized failure path", async () => {
    renderRegistry(
      sessionWith(async (input) => {
        if (input.method !== "POST") {
          return { items: [], nextCursor: null };
        }

        throw new ApiRequestError(
          normalizeApiFailure(409, { message: "tax identifier already registered" })
        );
      })
    );

    await userEvent.click(await screen.findByRole("button", { name: "Novo fornecedor" }));
    await fillRegistrationForm();
    await userEvent.click(screen.getByRole("button", { name: "Cadastrar fornecedor" }));

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain("O estado atual do registro não permite esta ação");
    expect(alert.textContent).not.toContain("tax identifier already registered");
  });
});

describe("supplier deactivation", () => {
  it("cancels on Escape without deactivating and returns focus to the opener", async () => {
    const calls: AuthenticatedRequestInput[] = [];
    renderRegistry(
      sessionWith(async (input) => {
        calls.push(input);

        return { items: [supplierFixture()], nextCursor: null };
      })
    );

    const opener = await screen.findByRole("button", { name: /^Desativar/u });
    await userEvent.click(opener);

    const dialog = screen.getByRole("dialog");

    expect(dialog.textContent).toContain("continua vinculado às cotações");

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(calls.some((call) => call.path.endsWith("/deactivate"))).toBe(false);
  });

  it("confirms through a bodyless, key-less route and shows the returned inactive state", async () => {
    const calls: AuthenticatedRequestInput[] = [];
    let deactivated = false;
    renderRegistry(
      sessionWith(async (input) => {
        calls.push(input);

        if (input.path.endsWith("/deactivate")) {
          deactivated = true;

          return supplierFixture({ isActive: false, deactivatedAt: "2026-09-11T09:00:00.000Z" });
        }

        // The reconciliation reload after a successful deactivation must see the server's own
        // post-deactivation state, exactly as a real backend would.
        return {
          items: [
            deactivated
              ? supplierFixture({ isActive: false, deactivatedAt: "2026-09-11T09:00:00.000Z" })
              : supplierFixture()
          ],
          nextCursor: null
        };
      })
    );

    await userEvent.click(await screen.findByRole("button", { name: /^Desativar/u }));
    await userEvent.click(screen.getByRole("button", { name: "Desativar fornecedor" }));

    expect(await screen.findByRole("status")).toBeDefined();
    await waitFor(() => {
      expect(screen.getByText("Inativo")).toBeDefined();
    });
    expect(screen.getByText("Sem ação disponível.")).toBeDefined();

    const deactivation = calls.find((call) => call.path.endsWith("/deactivate"));

    expect(deactivation?.path).toBe("/suppliers/supplier-1/deactivate");
    expect(deactivation?.method).toBe("POST");
    expect(deactivation?.body).toBeUndefined();
    expect(deactivation?.idempotencyKey).toBeUndefined();

    // The success message rests on the server's own response and is not reclassified by the
    // follow-up reconciliation read.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("treats an ambiguous deactivation as recoverable and only retries when the person asks", async () => {
    let attempts = 0;
    renderRegistry(
      sessionWith(async (input) => {
        if (!input.path.endsWith("/deactivate")) {
          return { items: [supplierFixture()], nextCursor: null };
        }

        attempts += 1;

        if (attempts === 1) {
          throw new ApiRequestError(normalizeApiFailure(500, { message: "db timeout" }));
        }

        return supplierFixture({ isActive: false, deactivatedAt: "2026-09-11T09:00:00.000Z" });
      })
    );

    await userEvent.click(await screen.findByRole("button", { name: /^Desativar/u }));
    await userEvent.click(screen.getByRole("button", { name: "Desativar fornecedor" }));

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain("O servidor não conseguiu concluir a operação");
    expect(alert.textContent).toContain("Não é possível saber se a operação foi concluída");
    expect(alert.textContent).not.toContain("db timeout");
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(attempts).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(await screen.findByRole("status")).toBeDefined();
    expect(attempts).toBe(2);
  });

  it("renders a 409 (already inactive) as a definitive, server-authoritative refusal", async () => {
    renderRegistry(
      sessionWith(async (input) => {
        if (!input.path.endsWith("/deactivate")) {
          return { items: [supplierFixture()], nextCursor: null };
        }

        throw new ApiRequestError(normalizeApiFailure(409, { message: "already inactive" }));
      })
    );

    await userEvent.click(await screen.findByRole("button", { name: /^Desativar/u }));
    await userEvent.click(screen.getByRole("button", { name: "Desativar fornecedor" }));

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain("O estado atual do registro não permite esta ação");
    expect(alert.textContent).not.toContain("already inactive");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Recarregar lista" })).toBeDefined();
  });

  it("reconciles the Active filter with a fresh first page after a successful deactivation", async () => {
    const paths: string[] = [];

    renderRegistry(
      sessionWith(async (input) => {
        paths.push(input.path);

        if (input.path.endsWith("/deactivate")) {
          return supplierFixture({ isActive: false, deactivatedAt: "2026-09-11T09:00:00.000Z" });
        }

        if (input.path === "/suppliers?isActive=true") {
          // First call seeds the Active-filtered page; every call after the deactivation
          // route was hit is the reconciliation reload, which the server now answers without
          // the deactivated supplier.
          const alreadyDeactivated = paths.some((path) => path.endsWith("/deactivate"));

          return alreadyDeactivated
            ? { items: [], nextCursor: null }
            : { items: [supplierFixture()], nextCursor: null };
        }

        return { items: [supplierFixture()], nextCursor: null };
      })
    );

    await userEvent.click(await screen.findByRole("button", { name: "Ativos" }));
    await screen.findByText("Papelaria Central");

    await userEvent.click(screen.getByRole("button", { name: /^Desativar/u }));
    await userEvent.click(screen.getByRole("button", { name: "Desativar fornecedor" }));

    await screen.findByRole("status");

    // The Active filter must never keep showing a supplier the server now reports inactive.
    await waitFor(() => {
      expect(screen.queryByText("Papelaria Central")).toBeNull();
    });
    expect(
      screen.getByText("Nenhum fornecedor encontrado para este filtro.")
    ).toBeDefined();

    // Reconciliation went through a real, fresh first-page query for the selected filter —
    // not just a local patch: the same "isActive=true" path was requested a second time, with
    // no cursor, after the deactivation route was called.
    const activeFilterCalls = paths.filter((path) => path === "/suppliers?isActive=true");

    expect(activeFilterCalls).toHaveLength(2);
    const deactivateIndex = paths.findIndex((path) => path.endsWith("/deactivate"));
    const secondActiveCallIndex = paths.lastIndexOf("/suppliers?isActive=true");

    expect(deactivateIndex).toBeGreaterThan(-1);
    expect(secondActiveCallIndex).toBeGreaterThan(deactivateIndex);
  });
});

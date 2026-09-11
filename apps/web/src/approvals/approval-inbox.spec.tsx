import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ApiRequestError,
  networkFailure,
  normalizeApiFailure
} from "@/session/api-error";
import type {
  AuthenticatedRequestInput,
  BrowserSession
} from "@/session/browser-session";
import { SessionProvider } from "@/session/session-context";
import {
  createSessionDouble,
  currentContextFixture
} from "@/session/session-double";
import { ApprovalInbox } from "./approval-inbox";
import type { ApprovalQueueItem } from "./contracts";

/** Version 4 UUIDs, because the decision route's contract is one and the client checks. */
const REQUEST_A = "1f8b7c62-5a4e-4f39-9a2b-0c6d1e5a7b31";
const REQUEST_B = "2c9d4e71-6b3f-4a28-8d5c-1e7f2a9b4c60";
const STEP_A = "7a1c3d55-2e4f-4b6a-ab8d-9f0e1c2d3a4b";
const STEP_B = "3e6f9a12-7b0c-4d8e-b1f2-6a3c9d0e4b57";

const QUEUE_PATH = "/purchase-requests/awaiting-my-approval";

function queueItem(
  purchaseRequestId: string,
  approvalStepId: string,
  overrides: {
    readonly stepState?: ApprovalQueueItem["pendingStep"]["state"];
    readonly stepRole?: ApprovalQueueItem["pendingStep"]["role"];
  } = {}
): ApprovalQueueItem {
  return {
    request: {
      id: purchaseRequestId,
      status: "SUBMITTED",
      neededBy: "2026-11-30",
      estimatedTotalCents: "687375",
      itemCount: 3,
      submittedAt: "2026-09-10T13:00:00.000Z",
      cancelledAt: null,
      createdAt: "2026-09-10T12:00:00.000Z",
      updatedAt: "2026-09-10T13:00:00.000Z"
    },
    pendingStep: {
      id: approvalStepId,
      sequence: 1,
      role: overrides.stepRole ?? "MANAGER",
      state: overrides.stepState ?? "ACTIONABLE",
      evaluatedAmountCents: "687375",
      decidedById: null,
      decidedAt: null,
      decisionReason: null
    }
  };
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

function renderInbox(session: BrowserSession) {
  render(
    <SessionProvider session={session}>
      <ApprovalInbox />
    </SessionProvider>
  );
}

function decisionOutcome(purchaseRequestId: string, status: string) {
  return { id: purchaseRequestId, status };
}

/** The row control, as opposed to the dialog's confirm button of a similar name. */
function rowButton(prefix: "Aprovar" | "Rejeitar"): HTMLElement {
  const match = screen
    .getAllByRole("button", { name: new RegExp(`^${prefix}`, "u") })
    .find((button) => button.textContent?.includes("solicitação enviada em"));

  if (match === undefined) {
    throw new Error(`No queue row control named ${prefix}`);
  }

  return match;
}

describe("manager approval inbox", () => {
  it("announces that it is loading before the first page arrives", async () => {
    renderInbox(sessionWith(async () => new Promise(() => {})));

    const loading = await screen.findByText("Carregando a fila de aprovações...");

    expect(loading.getAttribute("aria-busy")).toBe("true");
  });

  it("renders only what the queue contract publishes", async () => {
    const paths: string[] = [];
    renderInbox(
      sessionWith(async (input) => {
        paths.push(input.path);

        return { items: [queueItem(REQUEST_A, STEP_A)], nextCursor: null };
      })
    );

    expect(await screen.findByText("Enviada")).toBeDefined();
    expect(screen.getAllByText("R$ 6.873,75")).toHaveLength(2);
    expect(screen.getByText("Gestor")).toBeDefined();
    expect(screen.getByText("Aguardando decisão")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("30/11/2026")).toBeDefined();
    expect(screen.getByText("Fim da fila.")).toBeDefined();
    expect(paths).toEqual([QUEUE_PATH]);
  });

  it("walks forward with the opaque cursor the api returned", async () => {
    const paths: string[] = [];
    renderInbox(
      sessionWith(async (input) => {
        paths.push(input.path);

        return paths.length === 1
          ? { items: [queueItem(REQUEST_A, STEP_A)], nextCursor: "cursor-2" }
          : { items: [queueItem(REQUEST_B, STEP_B)], nextCursor: null };
      })
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Carregar mais" })
    );

    await waitFor(() => {
      expect(screen.getAllByText("Gestor")).toHaveLength(2);
    });
    expect(paths).toEqual([QUEUE_PATH, `${QUEUE_PATH}?cursor=cursor-2`]);
  });

  it("explains an empty queue in words", async () => {
    renderInbox(sessionWith(async () => ({ items: [], nextCursor: null })));

    expect(
      await screen.findByText("Nenhuma solicitação aguarda a sua aprovação.")
    ).toBeDefined();
  });

  it("offers a retry after a failed load and never shows the server body", async () => {
    let attempts = 0;
    renderInbox(
      sessionWith(async () => {
        attempts += 1;

        if (attempts === 1) {
          throw new ApiRequestError(
            normalizeApiFailure(500, { message: "relation pr does not exist" })
          );
        }

        return { items: [queueItem(REQUEST_A, STEP_A)], nextCursor: null };
      })
    );

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain("O servidor não conseguiu concluir a operação");
    expect(alert.textContent).not.toContain("relation pr");

    await userEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(await screen.findByText("Gestor")).toBeDefined();
  });

  it("renders a rate-limited queue as recoverable and retries only when asked", async () => {
    let attempts = 0;
    renderInbox(
      sessionWith(async () => {
        attempts += 1;

        throw new ApiRequestError(normalizeApiFailure(429, {}));
      })
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Muitas tentativas em pouco tempo"
    );
    expect(attempts).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));

    await waitFor(() => {
      expect(attempts).toBe(2);
    });
  });

  it("renders a refused queue without naming a resource", async () => {
    renderInbox(
      sessionWith(async () => {
        throw new ApiRequestError(
          normalizeApiFailure(403, { message: "Not allowed to perform this action" })
        );
      })
    );

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain("Você não tem permissão para executar esta ação");
    expect(alert.textContent).not.toContain(REQUEST_A);
  });

  it("offers no decision for a step the server did not make actionable", async () => {
    renderInbox(
      sessionWith(async () => ({
        items: [queueItem(REQUEST_A, STEP_A, { stepState: "PENDING" })],
        nextCursor: null
      }))
    );

    expect(
      await screen.findByText("Sem decisão disponível para você nesta etapa.")
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Aprovar/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Rejeitar/u })).toBeNull();
  });

  it("offers no decision for a rung that belongs to another responsibility", async () => {
    renderInbox(
      sessionWith(async () => ({
        items: [queueItem(REQUEST_A, STEP_A, { stepRole: "PURCHASING" })],
        nextCursor: null
      }))
    );

    expect(await screen.findByText("Compras")).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Aprovar/u })).toBeNull();
  });

  it("approves through a dialog that states the action is irreversible", async () => {
    const calls: AuthenticatedRequestInput[] = [];
    renderInbox(
      sessionWith(async (input) => {
        calls.push(input);

        return input.path.endsWith("/approval-decision")
          ? decisionOutcome(REQUEST_A, "IN_QUOTATION")
          : { items: [queueItem(REQUEST_A, STEP_A)], nextCursor: null };
      })
    );

    await userEvent.click(await screen.findByRole("button", { name: /^Aprovar/u }));

    const dialog = screen.getByRole("dialog");

    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain("A aprovação é definitiva");
    expect(dialog.textContent).toContain("R$ 6.873,75");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Voltar para a fila" })
    );

    await userEvent.click(screen.getByRole("button", { name: "Aprovar solicitação" }));

    expect(await screen.findByRole("status")).toBeDefined();
    expect(screen.getByRole("status").textContent).toContain("Solicitação aprovada");
    expect(screen.getByRole("status").textContent).toContain("Em cotação");
    expect(
      screen.getByText("Nenhuma solicitação aguarda a sua aprovação.")
    ).toBeDefined();

    const decision = calls.find((call) => call.path.endsWith("/approval-decision"));

    expect(decision?.path).toBe(`/purchase-requests/${REQUEST_A}/approval-decision`);
    expect(decision?.method).toBe("POST");
    expect(decision?.body).toEqual({ decision: "APPROVED" });
    expect(decision?.idempotencyKey).toMatch(/^\S{8,200}$/u);
  });

  it("refuses a rejection with no usable reason and moves focus to the field", async () => {
    const calls: AuthenticatedRequestInput[] = [];
    renderInbox(
      sessionWith(async (input) => {
        calls.push(input);

        return { items: [queueItem(REQUEST_A, STEP_A)], nextCursor: null };
      })
    );

    await userEvent.click(await screen.findByRole("button", { name: /^Rejeitar/u }));
    await userEvent.click(screen.getByRole("button", { name: "Rejeitar solicitação" }));

    const field = screen.getByLabelText("Motivo da rejeição");
    const error = screen.getByText(
      "Descreva o motivo da rejeição com pelo menos 10 caracteres."
    );

    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(error.getAttribute("id"));
    expect(document.activeElement).toBe(field);
    expect(calls.some((call) => call.path.endsWith("/approval-decision"))).toBe(false);

    await userEvent.type(field, "   curto  ");
    await userEvent.click(screen.getByRole("button", { name: "Rejeitar solicitação" }));

    expect(calls.some((call) => call.path.endsWith("/approval-decision"))).toBe(false);
  });

  it("sends a rejection with the trimmed reason and removes the row", async () => {
    const calls: AuthenticatedRequestInput[] = [];
    renderInbox(
      sessionWith(async (input) => {
        calls.push(input);

        return input.path.endsWith("/approval-decision")
          ? decisionOutcome(REQUEST_A, "REJECTED")
          : { items: [queueItem(REQUEST_A, STEP_A)], nextCursor: null };
      })
    );

    await userEvent.click(await screen.findByRole("button", { name: /^Rejeitar/u }));
    await userEvent.type(
      screen.getByLabelText("Motivo da rejeição"),
      "  Fora do orçamento do trimestre  "
    );
    await userEvent.click(screen.getByRole("button", { name: "Rejeitar solicitação" }));

    expect((await screen.findByRole("status")).textContent).toContain(
      "Solicitação rejeitada"
    );

    const decision = calls.find((call) => call.path.endsWith("/approval-decision"));

    expect(decision?.body).toEqual({
      decision: "REJECTED",
      reason: "Fora do orçamento do trimestre"
    });
  });

  it("cancels on Escape without deciding and gives focus back to the opener", async () => {
    const calls: AuthenticatedRequestInput[] = [];
    renderInbox(
      sessionWith(async (input) => {
        calls.push(input);

        return { items: [queueItem(REQUEST_A, STEP_A)], nextCursor: null };
      })
    );

    const opener = await screen.findByRole("button", { name: /^Aprovar/u });
    await userEvent.click(opener);
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(calls.some((call) => call.path.endsWith("/approval-decision"))).toBe(false);
  });

  const DEFINITIVE_REFUSALS: [number, string][] = [
    [409, "O estado atual do registro não permite esta ação"],
    [403, "Você não tem permissão para executar esta ação"],
    [404, "Registro não encontrado"]
  ];

  it.each(DEFINITIVE_REFUSALS)(
    "renders a definitive %s as controlled feedback",
    async (status, message) => {
      renderInbox(
        sessionWith(async (input) => {
          if (!input.path.endsWith("/approval-decision")) {
            return { items: [queueItem(REQUEST_A, STEP_A)], nextCursor: null };
          }

          throw new ApiRequestError(
            normalizeApiFailure(status, { message: "step 9f0e already decided" })
          );
        })
      );

      await userEvent.click(await screen.findByRole("button", { name: /^Aprovar/u }));
      await userEvent.click(
        screen.getByRole("button", { name: "Aprovar solicitação" })
      );

      const alert = await screen.findByRole("alert");

      expect(alert.textContent).toContain(message);
      expect(alert.textContent).not.toContain("step 9f0e already decided");
      expect(alert.textContent).not.toContain("ApiRequestError");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("button", { name: "Recarregar fila" })).toBeDefined();
      // The row stays: only the server may retire it, and it refused.
      expect(rowButton("Aprovar")).toBeDefined();
    }
  );

  it("shows the api's own validation details for a 422 and nothing else", async () => {
    renderInbox(
      sessionWith(async (input) => {
        if (!input.path.endsWith("/approval-decision")) {
          return { items: [queueItem(REQUEST_A, STEP_A)], nextCursor: null };
        }

        throw new ApiRequestError(
          normalizeApiFailure(422, {
            message: ["A rejection requires a reason of at least 10 characters"]
          })
        );
      })
    );

    await userEvent.click(await screen.findByRole("button", { name: /^Rejeitar/u }));
    await userEvent.type(
      screen.getByLabelText("Motivo da rejeição"),
      "dez caracteres exatos"
    );
    await userEvent.click(screen.getByRole("button", { name: "Rejeitar solicitação" }));

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain(
      "Os dados enviados não atendem a uma regra do sistema"
    );
    expect(alert.textContent).toContain(
      "A rejection requires a reason of at least 10 characters"
    );
  });

  it("never asks for another employee's purchase request detail", async () => {
    const paths: string[] = [];
    renderInbox(
      sessionWith(async (input) => {
        paths.push(input.path);

        return input.path.endsWith("/approval-decision")
          ? decisionOutcome(REQUEST_A, "IN_QUOTATION")
          : { items: [queueItem(REQUEST_A, STEP_A)], nextCursor: null };
      })
    );

    await userEvent.click(await screen.findByRole("button", { name: /^Aprovar/u }));
    await userEvent.click(screen.getByRole("button", { name: "Aprovar solicitação" }));
    await screen.findByRole("status");

    expect(paths).toEqual([
      QUEUE_PATH,
      `/purchase-requests/${REQUEST_A}/approval-decision`
    ]);
    // The requester's own-read route, which a manager has no business calling.
    expect(
      paths.some((path) =>
        /^\/purchase-requests\/[0-9a-fA-F-]{36}(?:\?|$)/u.test(path)
      )
    ).toBe(false);
  });
});

describe("approval decision idempotency, from the browser", () => {
  function keyRecordingSession(
    decide: (attempt: number) => unknown
  ): { readonly session: BrowserSession; readonly keys: (string | undefined)[] } {
    const keys: (string | undefined)[] = [];
    let attempts = 0;

    const session = sessionWith(async (input) => {
      if (!input.path.endsWith("/approval-decision")) {
        return { items: [queueItem(REQUEST_A, STEP_A)], nextCursor: null };
      }

      attempts += 1;
      keys.push(input.idempotencyKey);

      const answer = decide(attempts);

      if (answer instanceof Error) {
        throw answer;
      }

      return answer;
    });

    return { session, keys };
  }

  it("keeps one key across an explicit retry of an ambiguous decision", async () => {
    const { session, keys } = keyRecordingSession((attempt) =>
      attempt === 1
        ? new ApiRequestError(networkFailure())
        : decisionOutcome(REQUEST_A, "IN_QUOTATION")
    );

    renderInbox(session);
    await userEvent.click(await screen.findByRole("button", { name: /^Aprovar/u }));
    await userEvent.click(screen.getByRole("button", { name: "Aprovar solicitação" }));

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain(
      "Não foi possível falar com o servidor"
    );
    expect(alert.textContent).toContain(
      "Não é possível saber se a operação foi concluída"
    );
    // The dialog stays, so the same decision can be repeated with the same key.
    expect(screen.getByRole("dialog")).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect((await screen.findByRole("status")).textContent).toContain(
      "Solicitação aprovada"
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("keeps one key across an explicit retry after a 429", async () => {
    const { session, keys } = keyRecordingSession((attempt) =>
      attempt === 1
        ? new ApiRequestError(normalizeApiFailure(429, {}))
        : decisionOutcome(REQUEST_A, "IN_QUOTATION")
    );

    renderInbox(session);
    await userEvent.click(await screen.findByRole("button", { name: /^Aprovar/u }));
    await userEvent.click(screen.getByRole("button", { name: "Aprovar solicitação" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Muitas tentativas em pouco tempo"
    );

    await userEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));

    await waitFor(() => {
      expect(keys).toHaveLength(2);
    });
    expect(keys[0]).toBe(keys[1]);
  });

  it("mints a new key once the decision direction changes", async () => {
    const { session, keys } = keyRecordingSession((attempt) =>
      attempt === 1
        ? new ApiRequestError(networkFailure())
        : decisionOutcome(REQUEST_A, "REJECTED")
    );

    renderInbox(session);
    await userEvent.click(await screen.findByRole("button", { name: /^Aprovar/u }));
    await userEvent.click(screen.getByRole("button", { name: "Aprovar solicitação" }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Voltar para a fila" }));

    await userEvent.click(rowButton("Rejeitar"));
    await userEvent.type(
      screen.getByLabelText("Motivo da rejeição"),
      "Fora do orçamento do trimestre"
    );
    await userEvent.click(screen.getByRole("button", { name: "Rejeitar solicitação" }));

    await waitFor(() => {
      expect(keys).toHaveLength(2);
    });
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("mints a new key once the reason changes", async () => {
    const { session, keys } = keyRecordingSession(
      () => new ApiRequestError(networkFailure())
    );

    renderInbox(session);
    await userEvent.click(await screen.findByRole("button", { name: /^Rejeitar/u }));

    const field = screen.getByLabelText("Motivo da rejeição");

    await userEvent.type(field, "Fora do orçamento");
    await userEvent.click(screen.getByRole("button", { name: "Rejeitar solicitação" }));
    await screen.findByRole("alert");

    await userEvent.type(field, " deste trimestre");
    await userEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));

    await waitFor(() => {
      expect(keys).toHaveLength(2);
    });
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("discards the key after a definitive refusal", async () => {
    const { session, keys } = keyRecordingSession(
      () => new ApiRequestError(normalizeApiFailure(409, { message: "conflict" }))
    );

    renderInbox(session);
    await userEvent.click(await screen.findByRole("button", { name: /^Aprovar/u }));
    await userEvent.click(screen.getByRole("button", { name: "Aprovar solicitação" }));
    await screen.findByRole("alert");

    await userEvent.click(rowButton("Aprovar"));
    await userEvent.click(screen.getByRole("button", { name: "Aprovar solicitação" }));

    await waitFor(() => {
      expect(keys).toHaveLength(2);
    });
    expect(keys[0]).not.toBe(keys[1]);
  });
});

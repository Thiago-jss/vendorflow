import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
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
import { createSessionDouble, currentContextFixture } from "@/session/session-double";
import type { PurchaseRequest, PurchaseRequestStatus } from "./contracts";
import { RequestDetail } from "./request-detail";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className
  }: {
    readonly href: string;
    readonly children: ReactNode;
    readonly className?: string;
  }) => createElement("a", { href, className }, children)
}));

const OTHER_USER_ID = "3f4a6c0e-9a52-4b58-9b1e-2c7b5e1c8a11";

const draft: PurchaseRequest = {
  id: "request-1",
  status: "DRAFT",
  requesterId: currentContextFixture.membership.userId,
  departmentId: "department-1",
  justification: "Reposição de notebooks",
  neededBy: "2026-11-30",
  estimatedTotalCents: "687375",
  submittedAt: null,
  cancelledAt: null,
  createdAt: "2026-09-10T12:00:00.000Z",
  updatedAt: "2026-09-10T12:00:00.000Z",
  items: [
    {
      id: "item-1",
      position: 1,
      description: "Notebook 16 GB",
      unitOfMeasure: "UN",
      quantity: "1.250",
      estimatedUnitPriceCents: "549900",
      estimatedLineTotalCents: "687375"
    }
  ],
  approval: null,
  selectedQuote: null,
  purchaseOrder: null
};

const submitted: PurchaseRequest = {
  ...draft,
  status: "SUBMITTED",
  submittedAt: "2026-09-10T13:00:00.000Z",
  approval: {
    id: "flow-1",
    state: "ACTIVE",
    pendingStep: null,
    steps: [
      {
        id: "step-1",
        sequence: 1,
        role: "MANAGER",
        state: "APPROVED",
        evaluatedAmountCents: "687375",
        decidedById: currentContextFixture.membership.userId,
        decidedAt: "2026-09-10T14:00:00.000Z",
        decisionReason: "De acordo com o orçamento"
      },
      {
        id: "step-2",
        sequence: 2,
        role: "PURCHASING",
        state: "ACTIONABLE",
        evaluatedAmountCents: "687375",
        decidedById: OTHER_USER_ID,
        decidedAt: null,
        decisionReason: null
      }
    ]
  }
};

function renderDetail(session: BrowserSession) {
  render(
    <SessionProvider session={session}>
      <RequestDetail purchaseRequestId="request-1" />
    </SessionProvider>
  );
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

describe("purchase request detail", () => {
  it("confirms cancellation in a dialog that states the action is irreversible", async () => {
    const calls: AuthenticatedRequestInput[] = [];
    const session = sessionWith(async (input) => {
      calls.push(input);

      return input.path.endsWith("/cancel")
        ? { ...draft, status: "CANCELLED", cancelledAt: "2026-09-10T15:00:00.000Z" }
        : draft;
    });

    renderDetail(session);

    const opener = await screen.findByRole("button", { name: "Cancelar solicitação" });
    await userEvent.click(opener);

    const dialog = screen.getByRole("dialog");

    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain("não pode ser desfeita");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Manter solicitação" })
    );

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(calls.some((call) => call.path.endsWith("/cancel"))).toBe(false);

    await userEvent.click(
      screen.getByRole("button", { name: "Cancelar solicitação" })
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: "Cancelar solicitação" }).at(-1) as HTMLElement
    );

    await waitFor(() => {
      expect(screen.getByText("Cancelada")).toBeDefined();
    });
    expect(
      calls.filter((call) => call.path === "/purchase-requests/request-1/cancel")
    ).toHaveLength(1);
    expect(
      calls.find((call) => call.path.endsWith("/cancel"))?.idempotencyKey
    ).toBeUndefined();
  });

  it("keeps one idempotency key while a submission is retried, and drops it once answered", async () => {
    const keys: (string | undefined)[] = [];
    let failNext = true;
    const session = sessionWith(async (input) => {
      if (!input.path.endsWith("/submit")) {
        return draft;
      }

      keys.push(input.idempotencyKey);

      if (failNext) {
        failNext = false;

        throw new ApiRequestError(networkFailure());
      }

      return submitted;
    });

    renderDetail(session);
    await userEvent.click(
      await screen.findByRole("button", { name: "Enviar para aprovação" })
    );

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain("Não é possível saber se a operação foi concluída");

    await userEvent.click(
      screen.getByRole("button", { name: "Tentar enviar novamente" })
    );

    await waitFor(() => {
      expect(screen.getByText("Enviada")).toBeDefined();
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^\S{8,200}$/);
  });

  it("discards the key after a definitive refusal", async () => {
    const keys: (string | undefined)[] = [];
    const session = sessionWith(async (input) => {
      if (!input.path.endsWith("/submit")) {
        return draft;
      }

      keys.push(input.idempotencyKey);

      throw new ApiRequestError(normalizeApiFailure(409, { message: "conflict" }));
    });

    renderDetail(session);
    await userEvent.click(
      await screen.findByRole("button", { name: "Enviar para aprovação" })
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "O estado atual do registro não permite esta ação"
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Enviar para aprovação" })
    );

    await waitFor(() => {
      expect(keys).toHaveLength(2);
    });
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("names a decision as the reader's own without ever showing an identifier", async () => {
    const session = sessionWith(async () => submitted);

    renderDetail(session);

    expect(await screen.findByText("Você")).toBeDefined();
    expect(document.body.textContent).not.toContain(OTHER_USER_ID);
    expect(document.body.textContent).toContain("Responsável por Compras");
  });

  /**
   * The states the API accepts a cancellation from, per REQUESTER_TRANSITIONS.CANCELLED. The
   * two lists are exhaustive over the lifecycle on purpose: a status added to the contract
   * without a decision here fails to compile against `PurchaseRequestStatus`.
   */
  const CANCELLABLE: readonly PurchaseRequestStatus[] = [
    "DRAFT",
    "SUBMITTED",
    "IN_QUOTATION",
    "IN_FINAL_APPROVAL",
    "APPROVED"
  ];

  const NOT_CANCELLABLE: readonly PurchaseRequestStatus[] = [
    "REJECTED",
    "CANCELLED",
    "ORDERED"
  ];

  it.each(CANCELLABLE)("offers cancellation while the request is %s", async (status) => {
    const session = sessionWith(async () => ({ ...draft, status }));

    renderDetail(session);

    expect(
      await screen.findByRole("button", { name: "Cancelar solicitação" })
    ).toBeDefined();
  });

  it.each(NOT_CANCELLABLE)("offers no cancellation once the request is %s", async (status) => {
    const session = sessionWith(async () => ({ ...draft, status }));

    renderDetail(session);

    await screen.findByRole("heading", { name: "Resumo" });

    expect(screen.queryByRole("button", { name: "Cancelar solicitação" })).toBeNull();
  });

  it("leaves the api as the authority when a cancellable state changed underneath", async () => {
    const session = sessionWith(async (input) => {
      if (!input.path.endsWith("/cancel")) {
        return { ...draft, status: "APPROVED" };
      }

      throw new ApiRequestError(normalizeApiFailure(409, { message: "conflict" }));
    });

    renderDetail(session);

    // The affordance is offered, because the contract accepts APPROVED...
    await userEvent.click(
      await screen.findByRole("button", { name: "Cancelar solicitação" })
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: "Cancelar solicitação" }).at(-1) as HTMLElement
    );

    // ...and the refusal is rendered rather than pre-empted.
    expect((await screen.findByRole("alert")).textContent).toContain(
      "O estado atual do registro não permite esta ação"
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers no cancellation to a reader who is not the requester", async () => {
    const session = sessionWith(async () => ({
      ...draft,
      requesterId: OTHER_USER_ID
    }));

    renderDetail(session);

    await screen.findByRole("heading", { name: "Resumo" });

    expect(screen.queryByRole("button", { name: "Cancelar solicitação" })).toBeNull();
  });

  it("offers no draft-only action once the api reports another status", async () => {
    const session = sessionWith(async () => submitted);

    renderDetail(session);

    expect(await screen.findByText("Enviada")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Enviar para aprovação" })
    ).toBeNull();
    expect(screen.queryByRole("link", { name: "Editar rascunho" })).toBeNull();
  });
});

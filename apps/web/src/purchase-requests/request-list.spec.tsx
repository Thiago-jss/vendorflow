import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError, normalizeApiFailure } from "@/session/api-error";
import type { AuthenticatedRequestInput, BrowserSession } from "@/session/browser-session";
import { SessionProvider } from "@/session/session-context";
import {
  createSessionDouble,
  currentContextFixture
} from "@/session/session-double";
import { RequestList } from "./request-list";

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

function summary(id: string) {
  return {
    id,
    status: "DRAFT",
    neededBy: "2026-11-30",
    estimatedTotalCents: "687375",
    itemCount: 2,
    submittedAt: null,
    cancelledAt: null,
    createdAt: "2026-09-10T12:00:00.000Z",
    updatedAt: "2026-09-10T12:00:00.000Z"
  };
}

function renderList(session: BrowserSession) {
  render(
    <SessionProvider session={session}>
      <RequestList />
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

describe("purchase request list", () => {
  it("announces that it is loading before the first page arrives", async () => {
    const session = sessionWith(async () => new Promise(() => {}));

    renderList(session);

    const loading = await screen.findByText("Carregando solicitações...");

    expect(loading.getAttribute("aria-busy")).toBe("true");
  });

  it("explains an empty list in words", async () => {
    const session = sessionWith(async () => ({ items: [], nextCursor: null }));

    renderList(session);

    expect(
      await screen.findByText("Você ainda não tem solicitações de compra.")
    ).toBeDefined();
  });

  it("shows the api totals and status without recomputing them", async () => {
    const session = sessionWith(async () => ({
      items: [summary("request-1")],
      nextCursor: null
    }));

    renderList(session);

    expect(await screen.findByText("R$ 6.873,75")).toBeDefined();
    expect(screen.getByText("Rascunho")).toBeDefined();
    expect(screen.getByText("Fim da lista.")).toBeDefined();
  });

  it("walks forward with the opaque cursor the api returned", async () => {
    const paths: string[] = [];
    const session = sessionWith(async (input) => {
      paths.push(input.path);

      return paths.length === 1
        ? { items: [summary("request-1")], nextCursor: "cursor-2" }
        : { items: [summary("request-2")], nextCursor: null };
    });

    renderList(session);
    await userEvent.click(
      await screen.findByRole("button", { name: "Carregar mais" })
    );

    await waitFor(() => {
      expect(screen.getAllByText("R$ 6.873,75")).toHaveLength(2);
    });
    expect(paths).toEqual([
      "/purchase-requests",
      "/purchase-requests?cursor=cursor-2"
    ]);
  });

  it("offers a retry after a failure and never shows the server body", async () => {
    let attempts = 0;
    const session = sessionWith(async () => {
      attempts += 1;

      if (attempts === 1) {
        throw new ApiRequestError(
          normalizeApiFailure(500, { message: "column pr.foo does not exist" })
        );
      }

      return { items: [summary("request-1")], nextCursor: null };
    });

    renderList(session);

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain("O servidor não conseguiu concluir a operação");
    expect(alert.textContent).not.toContain("column pr.foo");

    await userEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));

    expect(await screen.findByText("R$ 6.873,75")).toBeDefined();
  });
});

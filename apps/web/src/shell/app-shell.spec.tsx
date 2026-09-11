import { render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MembershipRole } from "@/session/current-context";
import { SessionProvider } from "@/session/session-context";
import {
  createSessionDouble,
  currentContextFixture
} from "@/session/session-double";
import { AppShell } from "./app-shell";

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

function renderShellFor(roles: readonly MembershipRole[]) {
  const session = createSessionDouble({
    request: vi.fn(
      async () =>
        ({
          ...currentContextFixture,
          membership: { ...currentContextFixture.membership, roles }
        }) as never
    )
  });

  render(
    <SessionProvider session={session}>
      <AppShell>
        <p>conteúdo</p>
      </AppShell>
    </SessionProvider>
  );
}

describe("authenticated shell navigation", () => {
  it("links the approval inbox for a manager", async () => {
    renderShellFor(["EMPLOYEE", "MANAGER"]);

    const link = await screen.findByRole("link", { name: "Aprovações pendentes" });

    expect(link.getAttribute("href")).toBe("/approvals");
    expect(screen.getByText("Colaborador · Gestor")).toBeDefined();
  });

  it("offers no approval link to someone the queue would refuse", async () => {
    renderShellFor(["EMPLOYEE", "ADMIN"]);

    await screen.findByRole("link", { name: "Minhas solicitações" });

    expect(screen.queryByRole("link", { name: "Aprovações pendentes" })).toBeNull();
  });
});

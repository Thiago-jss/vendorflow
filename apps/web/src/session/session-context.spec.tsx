import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError, failureOfKind } from "./api-error";
import { SessionProvider, useSession } from "./session-context";
import { createSessionDouble, currentContextFixture } from "./session-double";

function Probe() {
  const { status, context } = useSession();

  return (
    <p>
      {`${status}:${context === null ? "sem contexto" : context.organization.name}`}
    </p>
  );
}

describe("session provider", () => {
  it("bootstraps a reload by refreshing and then reading the current context", async () => {
    const bootstrap = vi.fn(async () => true);
    const request = vi.fn(async () => currentContextFixture as never);

    render(
      <SessionProvider session={createSessionDouble({ bootstrap, request })}>
        <Probe />
      </SessionProvider>
    );

    expect(await screen.findByText("authenticated:Indústrias Acme")).toBeDefined();
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ path: "/me/organization" });
  });

  it("is anonymous when the refresh cookie buys nothing, without saying why", async () => {
    render(
      <SessionProvider
        session={createSessionDouble({ bootstrap: vi.fn(async () => false) })}
      >
        <Probe />
      </SessionProvider>
    );

    expect(await screen.findByText("anonymous:sem contexto")).toBeDefined();
  });

  it("drops the local context as soon as the session ends", async () => {
    const listeners: (() => void)[] = [];
    const session = createSessionDouble({
      request: vi.fn(async () => currentContextFixture as never),
      onSessionEnded: (listener: () => void) => {
        listeners.push(listener);

        return () => {};
      }
    });

    render(
      <SessionProvider session={session}>
        <Probe />
      </SessionProvider>
    );

    await screen.findByText("authenticated:Indústrias Acme");

    act(() => {
      for (const listener of listeners) {
        listener();
      }
    });

    await waitFor(() => {
      expect(screen.getByText("anonymous:sem contexto")).toBeDefined();
    });
  });

  it("gives the token back when the current context cannot be read after signing in", async () => {
    const logout = vi.fn(async () => {});
    const session = createSessionDouble({
      bootstrap: vi.fn(async () => false),
      logout,
      request: vi.fn(async () => {
        throw new ApiRequestError(failureOfKind("forbidden"));
      })
    });

    function SignIn() {
      const { signIn } = useSession();

      return (
        <button type="button" onClick={() => void signIn("a@b.test", "secret").catch(() => {})}>
          Entrar
        </button>
      );
    }

    render(
      <SessionProvider session={session}>
        <SignIn />
      </SessionProvider>
    );

    (await screen.findByRole("button", { name: "Entrar" })).click();

    await waitFor(() => {
      expect(logout).toHaveBeenCalledTimes(1);
    });
  });
});

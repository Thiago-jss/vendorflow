import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError, normalizeApiFailure } from "./api-error";
import { LoginForm } from "./login-form";
import { createSessionDouble, currentContextFixture } from "./session-double";
import { SessionProvider } from "./session-context";
import type { BrowserSession } from "./browser-session";

function renderLogin(session: BrowserSession) {
  return render(
    <SessionProvider session={session}>
      <LoginForm />
    </SessionProvider>
  );
}

describe("login form", () => {
  it("refuses to call the api until both fields are filled", async () => {
    const login = vi.fn(async () => {});
    const session = createSessionDouble({
      bootstrap: vi.fn(async () => false),
      login
    });

    renderLogin(session);
    await userEvent.click(screen.getByRole("button", { name: "Entrar" }));

    const emailField = screen.getByLabelText("E-mail corporativo");

    expect(login).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(emailField);
    expect(emailField.getAttribute("aria-invalid")).toBe("true");
    expect(
      screen.getByText("Informe o e-mail corporativo.").getAttribute("id")
    ).toBe(emailField.getAttribute("aria-describedby"));
  });

  it("signs in and loads the current context", async () => {
    const request = vi.fn(async () => currentContextFixture as never);
    const login = vi.fn(async () => {});
    const session = createSessionDouble({
      bootstrap: vi.fn(async () => false),
      login,
      request
    });

    renderLogin(session);
    await userEvent.type(
      screen.getByLabelText("E-mail corporativo"),
      "employee@acme.test"
    );
    await userEvent.type(screen.getByLabelText("Senha"), "correct horse");
    await userEvent.click(screen.getByRole("button", { name: "Entrar" }));

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith({
        email: "employee@acme.test",
        password: "correct horse"
      });
    });
    expect(request).toHaveBeenCalledWith({ path: "/me/organization" });
  });

  it("reports a refusal without repeating what the server said", async () => {
    const session = createSessionDouble({
      bootstrap: vi.fn(async () => false),
      login: vi.fn(async () => {
        throw new ApiRequestError(
          normalizeApiFailure(401, { statusCode: 401, message: "Invalid credentials" })
        );
      })
    });

    renderLogin(session);
    await userEvent.type(
      screen.getByLabelText("E-mail corporativo"),
      "employee@acme.test"
    );
    await userEvent.type(screen.getByLabelText("Senha"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Entrar" }));

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain("Sua sessão não está mais ativa");
    expect(alert.textContent).not.toContain("Invalid credentials");
    expect((screen.getByLabelText("Senha") as HTMLInputElement).value).toBe("");
  });
});

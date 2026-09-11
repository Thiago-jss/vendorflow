"use client";

import { useId, useState, type FormEvent } from "react";
import { FailureAlert } from "@/ui/feedback";
import { toApiFailure, type ApiFailure } from "./api-error";
import { useSession } from "./session-context";

/**
 * The only unauthenticated form in the application.
 *
 * A refusal is rendered exactly as the API phrased the category — unknown address, wrong
 * password and deactivated user are one answer there and stay one answer here.
 */
export function LoginForm() {
  const { signIn } = useSession();
  const prefix = useId();
  const emailId = `${prefix}-email`;
  const passwordId = `${prefix}-password`;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const found: Record<string, string> = {};

    if (email.trim().length === 0) {
      found[emailId] = "Informe o e-mail corporativo.";
    }

    if (password.length === 0) {
      found[passwordId] = "Informe a senha.";
    }

    setErrors(found);

    const firstInvalid = Object.keys(found).at(0);

    if (firstInvalid !== undefined) {
      document.getElementById(firstInvalid)?.focus();

      return;
    }

    setPending(true);
    setFailure(null);

    try {
      await signIn(email.trim(), password);
    } catch (error: unknown) {
      setFailure(toApiFailure(error));
    } finally {
      // The password never leaves this component and never survives an attempt.
      setPassword("");
      setPending(false);
    }
  }

  return (
    <form className="form form-narrow" noValidate onSubmit={(event) => void handleSubmit(event)}>
      <h1>Entrar no VendorFlow</h1>

      {failure === null ? null : <FailureAlert failure={failure} />}

      <div className="field">
        <label htmlFor={emailId}>E-mail corporativo</label>
        <input
          id={emailId}
          type="email"
          autoComplete="username"
          value={email}
          aria-invalid={errors[emailId] === undefined ? undefined : true}
          aria-describedby={
            errors[emailId] === undefined ? undefined : `${emailId}-error`
          }
          onChange={(event) => setEmail(event.target.value)}
        />
        {errors[emailId] === undefined ? null : (
          <p className="field-error" id={`${emailId}-error`}>
            {errors[emailId]}
          </p>
        )}
      </div>

      <div className="field">
        <label htmlFor={passwordId}>Senha</label>
        <input
          id={passwordId}
          type="password"
          autoComplete="current-password"
          value={password}
          aria-invalid={errors[passwordId] === undefined ? undefined : true}
          aria-describedby={
            errors[passwordId] === undefined ? undefined : `${passwordId}-error`
          }
          onChange={(event) => setPassword(event.target.value)}
        />
        {errors[passwordId] === undefined ? null : (
          <p className="field-error" id={`${passwordId}-error`}>
            {errors[passwordId]}
          </p>
        )}
      </div>

      <button type="submit" className="button button-primary" disabled={pending}>
        {pending ? "Entrando..." : "Entrar"}
      </button>
    </form>
  );
}

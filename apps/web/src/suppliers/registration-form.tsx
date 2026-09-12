"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { ApiFailure } from "@/session/api-error";
import { FailureAlert } from "@/ui/feedback";
import { supplierTaxIdentifierTypes, type SupplierRegistrationInput } from "./contracts";
import { taxIdentifierTypeLabel } from "./formatting";

/**
 * The checks below are courtesy: they catch an empty field, an obviously wrong shape or a
 * length the API would reject, before a round trip. They are not authority. The server
 * validates the same payload again — normalizing and check-digit-validating a CNPJ, enforcing
 * uniqueness — and a refusal it returns is rendered exactly as it comes back rather than
 * second-guessed here. In particular, an `OTHER` identifier is never normalized locally: it is
 * sent exactly as typed.
 */
const LEGAL_NAME_MAX_LENGTH = 200;
const TRADE_NAME_MAX_LENGTH = 200;
const TAX_IDENTIFIER_MAX_LENGTH = 40;
const CONTACT_EMAIL_MAX_LENGTH = 320;
const CONTACT_PHONE_MAX_LENGTH = 40;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PHONE_SHAPE = /^[0-9+()\-. ]+$/u;

export interface RegistrationFormProps {
  readonly pending: boolean;
  readonly failure: ApiFailure | null;
  /** True when a failed registration may still have created the supplier server-side. */
  readonly ambiguous?: boolean;
  readonly onSubmit: (input: SupplierRegistrationInput) => void;
  readonly onCancel: () => void;
}

interface Fields {
  legalName: string;
  tradeName: string;
  taxIdentifierType: SupplierRegistrationInput["taxIdentifierType"];
  taxIdentifier: string;
  contactEmail: string;
  contactPhone: string;
}

function emptyFields(): Fields {
  return {
    legalName: "",
    tradeName: "",
    taxIdentifierType: "CNPJ",
    taxIdentifier: "",
    contactEmail: "",
    contactPhone: ""
  };
}

function validate(fields: Fields, fieldId: (name: string) => string): Record<string, string> {
  const errors: Record<string, string> = {};

  if (fields.legalName.trim().length === 0) {
    errors[fieldId("legal-name")] = "Informe a razão social.";
  } else if (fields.legalName.length > LEGAL_NAME_MAX_LENGTH) {
    errors[fieldId("legal-name")] = `A razão social deve ter até ${LEGAL_NAME_MAX_LENGTH} caracteres.`;
  }

  if (fields.tradeName.trim().length === 0) {
    errors[fieldId("trade-name")] = "Informe o nome fantasia.";
  } else if (fields.tradeName.length > TRADE_NAME_MAX_LENGTH) {
    errors[fieldId("trade-name")] = `O nome fantasia deve ter até ${TRADE_NAME_MAX_LENGTH} caracteres.`;
  }

  if (fields.taxIdentifier.trim().length === 0) {
    errors[fieldId("tax-identifier")] = "Informe o identificador fiscal.";
  } else if (fields.taxIdentifier.length > TAX_IDENTIFIER_MAX_LENGTH) {
    errors[fieldId("tax-identifier")] =
      `O identificador fiscal deve ter até ${TAX_IDENTIFIER_MAX_LENGTH} caracteres.`;
  }

  if (fields.contactEmail.length > CONTACT_EMAIL_MAX_LENGTH) {
    errors[fieldId("contact-email")] = `O e-mail deve ter até ${CONTACT_EMAIL_MAX_LENGTH} caracteres.`;
  } else if (!EMAIL_SHAPE.test(fields.contactEmail)) {
    errors[fieldId("contact-email")] = "Informe um e-mail válido.";
  }

  if (fields.contactPhone.trim().length === 0) {
    errors[fieldId("contact-phone")] = "Informe o telefone de contato.";
  } else if (fields.contactPhone.length > CONTACT_PHONE_MAX_LENGTH) {
    errors[fieldId("contact-phone")] = `O telefone deve ter até ${CONTACT_PHONE_MAX_LENGTH} caracteres.`;
  } else if (!PHONE_SHAPE.test(fields.contactPhone)) {
    errors[fieldId("contact-phone")] =
      "Use apenas dígitos e pontuação de telefone: + ( ) - . e espaço.";
  }

  return errors;
}

export function RegistrationForm({
  pending,
  failure,
  ambiguous = false,
  onSubmit,
  onCancel
}: RegistrationFormProps) {
  const prefix = useId();
  const fieldId = (name: string) => `${prefix}-${name}`;

  const [fields, setFields] = useState<Fields>(emptyFields());
  const [errors, setErrors] = useState<Record<string, string>>({});

  function update(patch: Partial<Fields>): void {
    setFields((current) => ({ ...current, ...patch }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const found = validate(fields, fieldId);
    setErrors(found);

    const firstInvalid = Object.keys(found).at(0);

    if (firstInvalid !== undefined) {
      document.getElementById(firstInvalid)?.focus();

      return;
    }

    onSubmit({
      legalName: fields.legalName.trim(),
      tradeName: fields.tradeName.trim(),
      taxIdentifierType: fields.taxIdentifierType,
      // Sent exactly as typed. Neither type is normalized here: a CNPJ's normalization and
      // check-digit validation is the server's, and an OTHER identifier gets none at all.
      taxIdentifier: fields.taxIdentifier,
      contactEmail: fields.contactEmail.trim(),
      contactPhone: fields.contactPhone.trim()
    });
  }

  function fieldProps(name: string) {
    const id = fieldId(name);
    const error = errors[id];

    return {
      id,
      "aria-invalid": error === undefined ? undefined : true,
      "aria-describedby": error === undefined ? undefined : `${id}-error`
    } as const;
  }

  // A helper rather than a nested component: a component declared during render is a new
  // type on every render, and React would remount the node each time.
  function fieldError(name: string): ReactNode {
    const id = fieldId(name);
    const error = errors[id];

    return error === undefined ? null : (
      <p className="field-error" id={`${id}-error`}>
        {error}
      </p>
    );
  }

  return (
    <form className="form" noValidate onSubmit={handleSubmit}>
      {failure === null ? null : <FailureAlert failure={failure} ambiguous={ambiguous} />}

      <div className="field">
        <label htmlFor={fieldId("legal-name")}>Razão social</label>
        <input
          {...fieldProps("legal-name")}
          type="text"
          maxLength={LEGAL_NAME_MAX_LENGTH}
          value={fields.legalName}
          onChange={(event) => update({ legalName: event.target.value })}
        />
        {fieldError("legal-name")}
      </div>

      <div className="field">
        <label htmlFor={fieldId("trade-name")}>Nome fantasia</label>
        <input
          {...fieldProps("trade-name")}
          type="text"
          maxLength={TRADE_NAME_MAX_LENGTH}
          value={fields.tradeName}
          onChange={(event) => update({ tradeName: event.target.value })}
        />
        {fieldError("trade-name")}
      </div>

      <div className="field field-narrow">
        <label htmlFor={fieldId("tax-identifier-type")}>Tipo de identificador fiscal</label>
        <select
          id={fieldId("tax-identifier-type")}
          value={fields.taxIdentifierType}
          onChange={(event) =>
            update({
              taxIdentifierType: event.target.value as SupplierRegistrationInput["taxIdentifierType"]
            })
          }
        >
          {supplierTaxIdentifierTypes.map((type) => (
            <option key={type} value={type}>
              {taxIdentifierTypeLabel(type)}
            </option>
          ))}
        </select>
      </div>

      <div className="field field-narrow">
        <label htmlFor={fieldId("tax-identifier")}>Identificador fiscal</label>
        <input
          {...fieldProps("tax-identifier")}
          type="text"
          maxLength={TAX_IDENTIFIER_MAX_LENGTH}
          value={fields.taxIdentifier}
          onChange={(event) => update({ taxIdentifier: event.target.value })}
        />
        <p className="field-hint">
          {fields.taxIdentifierType === "CNPJ"
            ? "O servidor normaliza e valida os dígitos verificadores do CNPJ."
            : "Registrado exatamente como digitado, sem validação nacional."}
        </p>
        {fieldError("tax-identifier")}
      </div>

      <div className="field field-narrow">
        <label htmlFor={fieldId("contact-email")}>E-mail de contato</label>
        <input
          {...fieldProps("contact-email")}
          type="email"
          maxLength={CONTACT_EMAIL_MAX_LENGTH}
          value={fields.contactEmail}
          onChange={(event) => update({ contactEmail: event.target.value })}
        />
        {fieldError("contact-email")}
      </div>

      <div className="field field-narrow">
        <label htmlFor={fieldId("contact-phone")}>Telefone de contato</label>
        <input
          {...fieldProps("contact-phone")}
          type="text"
          maxLength={CONTACT_PHONE_MAX_LENGTH}
          value={fields.contactPhone}
          onChange={(event) => update({ contactPhone: event.target.value })}
        />
        {fieldError("contact-phone")}
      </div>

      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={pending}>
          {pending ? "Enviando..." : "Cadastrar fornecedor"}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

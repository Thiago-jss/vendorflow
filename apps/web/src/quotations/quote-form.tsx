"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { formatQuantity } from "@/purchase-requests/formatting";
import type { ApiFailure } from "@/session/api-error";
import type { Supplier } from "@/suppliers/contracts";
import { FailureAlert } from "@/ui/feedback";
import type { QuotationWorkItem, QuoteRegistrationInput } from "./contracts";

/**
 * The checks below are courtesy: an empty field, a shape the API's DTO would refuse with 400,
 * or a lead time outside its declared bounds, caught before a round trip. They are not
 * authority. The server still decides whether an amount is storable, whether the discount fits
 * the goods, whether the validity date is a real day, whether the supplier is active and
 * whether the lines cover the request exactly — and a refusal it returns is rendered as it
 * comes back rather than second-guessed here.
 *
 * Nothing in this file adds, multiplies or rounds money.
 */
const CENTS_SHAPE = /^(0|[1-9]\d*)$/u;
const CALENDAR_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/u;
const WHOLE_DAYS_SHAPE = /^(0|[1-9]\d{0,2})$/u;
/** `RegisterSupplierQuoteDto`'s own bound. */
const MAXIMUM_DELIVERY_LEAD_TIME_DAYS = 730;

const CENTS_HINT = "Valor em centavos, apenas dígitos. Ex.: 12500 para R$ 125,00.";

export interface QuoteFormProps {
  readonly items: readonly QuotationWorkItem[];
  readonly suppliers: readonly Supplier[];
  readonly hasMoreSuppliers: boolean;
  readonly loadingSuppliers: boolean;
  readonly supplierFailure: ApiFailure | null;
  readonly onLoadMoreSuppliers: () => void;
  readonly pending: boolean;
  readonly failure: ApiFailure | null;
  /** True when a failed registration may still have created the quote server-side. */
  readonly ambiguous: boolean;
  readonly onReloadQueue: () => void;
  readonly onSubmit: (input: QuoteRegistrationInput) => void;
  readonly onCancel: () => void;
}

interface Fields {
  readonly supplierId: string;
  readonly freightCents: string;
  readonly discountCents: string;
  readonly validUntil: string;
  readonly deliveryLeadTimeDays: string;
  /** Keyed by persisted item identifier. A Map, so no remote key can reach a prototype. */
  readonly unitPrices: ReadonlyMap<string, string>;
}

function emptyFields(): Fields {
  return {
    supplierId: "",
    freightCents: "",
    discountCents: "",
    validUntil: "",
    deliveryLeadTimeDays: "",
    unitPrices: new Map()
  };
}

function centsError(value: string, missing: string): string | undefined {
  if (value.length === 0) {
    return missing;
  }

  return CENTS_SHAPE.test(value)
    ? undefined
    : "Use apenas dígitos, sem sinal, separador ou zeros à esquerda.";
}

function validate(
  fields: Fields,
  items: readonly QuotationWorkItem[],
  fieldId: (name: string) => string
): Record<string, string> {
  const errors: Record<string, string> = {};
  const record = (name: string, error: string | undefined) => {
    if (error !== undefined) {
      errors[fieldId(name)] = error;
    }
  };

  record("supplier", fields.supplierId.length === 0 ? "Selecione um fornecedor ativo." : undefined);
  record("freight", centsError(fields.freightCents.trim(), "Informe o frete, ou 0."));
  record("discount", centsError(fields.discountCents.trim(), "Informe o desconto, ou 0."));

  if (!CALENDAR_DATE_SHAPE.test(fields.validUntil)) {
    record("valid-until", "Informe a data de validade da cotação.");
  }

  const leadTime = fields.deliveryLeadTimeDays.trim();

  if (leadTime.length === 0) {
    record("lead-time", "Informe o prazo de entrega em dias.");
  } else if (
    !WHOLE_DAYS_SHAPE.test(leadTime) ||
    Number.parseInt(leadTime, 10) > MAXIMUM_DELIVERY_LEAD_TIME_DAYS
  ) {
    record(
      "lead-time",
      `Use um número inteiro de dias, de 0 a ${MAXIMUM_DELIVERY_LEAD_TIME_DAYS}.`
    );
  }

  for (const item of items) {
    record(
      `price-${item.position}`,
      centsError(
        (fields.unitPrices.get(item.id) ?? "").trim(),
        "Informe o preço unitário deste item."
      )
    );
  }

  return errors;
}

function supplierLabel(supplier: Supplier): string {
  return supplier.tradeName === supplier.legalName
    ? supplier.tradeName
    : `${supplier.tradeName} — ${supplier.legalName}`;
}

/**
 * One supplier quote over every line the quotation-work read published.
 *
 * The line inputs are generated from the server's own item list, one per persisted item, and
 * the payload is assembled from them in that order. The browser does not decide which lines a
 * quote must cover; it just offers no way to leave one out or add one that is not there.
 */
export function QuoteForm({
  items,
  suppliers,
  hasMoreSuppliers,
  loadingSuppliers,
  supplierFailure,
  onLoadMoreSuppliers,
  pending,
  failure,
  ambiguous,
  onReloadQueue,
  onSubmit,
  onCancel
}: QuoteFormProps) {
  const prefix = useId();
  const fieldId = (name: string) => `${prefix}-${name}`;

  const [fields, setFields] = useState<Fields>(emptyFields);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function update(patch: Partial<Omit<Fields, "unitPrices">>): void {
    setFields((current) => ({ ...current, ...patch }));
  }

  function updatePrice(itemId: string, value: string): void {
    setFields((current) => {
      const unitPrices = new Map(current.unitPrices);
      unitPrices.set(itemId, value);

      return { ...current, unitPrices };
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    if (pending) {
      return;
    }

    const found = validate(fields, items, fieldId);
    setErrors(found);

    const firstInvalid = Object.keys(found).at(0);

    if (firstInvalid !== undefined) {
      document.getElementById(firstInvalid)?.focus();

      return;
    }

    onSubmit({
      supplierId: fields.supplierId,
      freightCents: fields.freightCents.trim(),
      discountCents: fields.discountCents.trim(),
      validUntil: fields.validUntil,
      // Already proven to be one to three digits: a count of days, not an amount.
      deliveryLeadTimeDays: Number.parseInt(fields.deliveryLeadTimeDays.trim(), 10),
      lines: items.map((item) => ({
        purchaseRequestItemId: item.id,
        unitPriceCents: (fields.unitPrices.get(item.id) ?? "").trim()
      }))
    });
  }

  function fieldProps(name: string, hinted = false) {
    const id = fieldId(name);
    const error = errors[id];

    return {
      id,
      "aria-invalid": error === undefined ? undefined : true,
      "aria-describedby":
        error === undefined ? (hinted ? `${id}-hint` : undefined) : `${id}-error`
    } as const;
  }

  // A helper rather than a nested component: a component declared during render is a new type
  // on every render, and React would remount the node each time.
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
      <div className="field field-narrow">
        <label htmlFor={fieldId("supplier")}>Fornecedor</label>
        <select
          {...fieldProps("supplier")}
          value={fields.supplierId}
          onChange={(event) => update({ supplierId: event.target.value })}
        >
          <option value="">Selecione um fornecedor ativo</option>
          {suppliers.map((supplier) => (
            <option key={supplier.id} value={supplier.id}>
              {supplierLabel(supplier)}
            </option>
          ))}
        </select>
        {suppliers.length === 0 && !loadingSuppliers ? (
          <p className="field-hint">
            Nenhum fornecedor ativo encontrado. Cadastre ou reative um fornecedor antes de cotar.
          </p>
        ) : null}
        {fieldError("supplier")}
        {supplierFailure === null ? null : (
          <FailureAlert
            failure={supplierFailure}
            onRetry={onLoadMoreSuppliers}
            retryLabel="Tentar carregar mais fornecedores"
          />
        )}
        {hasMoreSuppliers ? (
          <button
            type="button"
            className="button button-secondary"
            disabled={loadingSuppliers}
            onClick={onLoadMoreSuppliers}
          >
            {loadingSuppliers ? "Carregando..." : "Carregar mais fornecedores"}
          </button>
        ) : null}
      </div>

      <div className="table-scroll">
        <table className="data-table">
          <caption>Preço unitário por item da solicitação</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Descrição</th>
              <th scope="col">Quantidade</th>
              <th scope="col">Unidade</th>
              <th scope="col">Preço unitário (centavos)</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const name = `price-${item.position}`;

              return (
                <tr key={item.id}>
                  <td className="numeric">{item.position}</td>
                  <td>{item.description}</td>
                  <td className="numeric">{formatQuantity(item.quantity)}</td>
                  <td>{item.unitOfMeasure}</td>
                  <td>
                    <label className="visually-hidden" htmlFor={fieldId(name)}>
                      {`Preço unitário do item ${item.position}`}
                    </label>
                    <input
                      {...fieldProps(name)}
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={fields.unitPrices.get(item.id) ?? ""}
                      onChange={(event) => updatePrice(item.id, event.target.value)}
                    />
                    {fieldError(name)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="field field-narrow">
        <label htmlFor={fieldId("freight")}>Frete (centavos)</label>
        <input
          {...fieldProps("freight", true)}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={fields.freightCents}
          onChange={(event) => update({ freightCents: event.target.value })}
        />
        <p className="field-hint" id={`${fieldId("freight")}-hint`}>
          {CENTS_HINT}
        </p>
        {fieldError("freight")}
      </div>

      <div className="field field-narrow">
        <label htmlFor={fieldId("discount")}>Desconto (centavos)</label>
        <input
          {...fieldProps("discount", true)}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={fields.discountCents}
          onChange={(event) => update({ discountCents: event.target.value })}
        />
        <p className="field-hint" id={`${fieldId("discount")}-hint`}>
          {CENTS_HINT}
        </p>
        {fieldError("discount")}
      </div>

      <div className="field field-narrow">
        <label htmlFor={fieldId("valid-until")}>Válida até</label>
        <input
          {...fieldProps("valid-until")}
          type="date"
          value={fields.validUntil}
          onChange={(event) => update({ validUntil: event.target.value })}
        />
        {fieldError("valid-until")}
      </div>

      <div className="field field-narrow">
        <label htmlFor={fieldId("lead-time")}>Prazo de entrega (dias)</label>
        <input
          {...fieldProps("lead-time")}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          maxLength={3}
          value={fields.deliveryLeadTimeDays}
          onChange={(event) => update({ deliveryLeadTimeDays: event.target.value })}
        />
        {fieldError("lead-time")}
      </div>

      <p className="form-note">
        Os totais por item, o subtotal e o total da cotação são calculados pelo servidor a partir
        das quantidades registradas na solicitação.
      </p>

      {failure === null ? null : (
        <FailureAlert
          failure={failure}
          ambiguous={ambiguous}
          onRetry={onReloadQueue}
          retryLabel="Recarregar fila"
        />
      )}

      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={pending}>
          {pending
            ? "Enviando..."
            : ambiguous
              ? "Tentar registrar novamente"
              : "Registrar cotação"}
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={pending}
          onClick={onCancel}
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}

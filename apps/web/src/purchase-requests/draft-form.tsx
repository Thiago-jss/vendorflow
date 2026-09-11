"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { ApiFailure } from "@/session/api-error";
import { FailureAlert } from "@/ui/feedback";
import type { PurchaseRequestDraftInput } from "./contracts";
import { formatCents, formatQuantity } from "./formatting";

/**
 * The editable content of a draft, and nothing else.
 *
 * The checks below are courtesy: they catch an empty field or a value in the wrong shape
 * before a round trip. They are not authority. The API validates the same payload again, and
 * a refusal it returns is rendered exactly as it comes back rather than second-guessed here.
 *
 * The form submits `justification`, `neededBy` and the item lines. It never submits a total,
 * a line total, an item position, a status, an organization or a requester: those are the
 * server's, and sending one is a 400 by design.
 */
export interface DraftItemFields {
  description: string;
  unitOfMeasure: string;
  quantity: string;
  estimatedUnitPriceCents: string;
}

export interface DraftFormProps {
  readonly submitLabel: string;
  readonly pending: boolean;
  readonly failure: ApiFailure | null;
  /** True when a failed mutation may still have been applied by the server. */
  readonly ambiguous?: boolean;
  readonly initialValue?: PurchaseRequestDraftInput;
  readonly onSubmit: (draft: PurchaseRequestDraftInput) => void;
  readonly onCancel: () => void;
}

const QUANTITY_PATTERN = /^(0|[1-9]\d*)(?:\.\d{1,3})?$/;
const CENTS_PATTERN = /^(0|[1-9]\d*)$/;
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function emptyItem(): DraftItemFields {
  return {
    description: "",
    unitOfMeasure: "",
    quantity: "",
    estimatedUnitPriceCents: ""
  };
}

function initialItems(
  initialValue: PurchaseRequestDraftInput | undefined
): DraftItemFields[] {
  if (initialValue === undefined || initialValue.items.length === 0) {
    return [emptyItem()];
  }

  return initialValue.items.map((item) => ({
    description: item.description,
    unitOfMeasure: item.unitOfMeasure,
    quantity: item.quantity,
    estimatedUnitPriceCents: item.estimatedUnitPriceCents
  }));
}

function validate(
  justification: string,
  neededBy: string,
  items: readonly DraftItemFields[],
  fieldId: (name: string) => string
): Record<string, string> {
  const errors: Record<string, string> = {};

  if (justification.trim().length === 0) {
    errors[fieldId("justification")] = "Informe a justificativa da solicitação.";
  } else if (justification.length > 2000) {
    errors[fieldId("justification")] = "A justificativa deve ter até 2000 caracteres.";
  }

  if (!CALENDAR_DATE_PATTERN.test(neededBy)) {
    errors[fieldId("needed-by")] = "Informe a data desejada de entrega.";
  }

  items.forEach((item, index) => {
    if (item.description.trim().length === 0) {
      errors[fieldId(`item-${index}-description`)] = "Descreva o item.";
    }

    if (item.unitOfMeasure.trim().length === 0) {
      errors[fieldId(`item-${index}-unit`)] = "Informe a unidade de medida.";
    }

    if (!QUANTITY_PATTERN.test(item.quantity)) {
      errors[fieldId(`item-${index}-quantity`)] =
        "Use um número com até três casas decimais, como 1.250.";
    }

    if (!CENTS_PATTERN.test(item.estimatedUnitPriceCents)) {
      errors[fieldId(`item-${index}-price`)] =
        "Informe o preço unitário estimado em centavos, apenas dígitos.";
    }
  });

  return errors;
}

export function DraftForm({
  submitLabel,
  pending,
  failure,
  ambiguous = false,
  initialValue,
  onSubmit,
  onCancel
}: DraftFormProps) {
  const prefix = useId();
  const fieldId = (name: string) => `${prefix}-${name}`;

  const [justification, setJustification] = useState(
    initialValue?.justification ?? ""
  );
  const [neededBy, setNeededBy] = useState(initialValue?.neededBy ?? "");
  const [items, setItems] = useState<DraftItemFields[]>(() =>
    initialItems(initialValue)
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  function updateItem(index: number, patch: Partial<DraftItemFields>): void {
    setItems((current) =>
      current.map((item, position) =>
        position === index ? { ...item, ...patch } : item
      )
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const found = validate(justification, neededBy, items, fieldId);
    setErrors(found);

    const firstInvalid = Object.keys(found).at(0);

    if (firstInvalid !== undefined) {
      document.getElementById(firstInvalid)?.focus();

      return;
    }

    onSubmit({
      justification: justification.trim(),
      neededBy,
      items: items.map((item) => ({
        description: item.description.trim(),
        unitOfMeasure: item.unitOfMeasure.trim(),
        quantity: item.quantity,
        estimatedUnitPriceCents: item.estimatedUnitPriceCents
      }))
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
      {failure === null ? null : (
        <FailureAlert failure={failure} ambiguous={ambiguous} />
      )}

      <div className="field">
        <label htmlFor={fieldId("justification")}>Justificativa</label>
        <textarea
          {...fieldProps("justification")}
          rows={4}
          maxLength={2000}
          value={justification}
          onChange={(event) => setJustification(event.target.value)}
        />
        {fieldError("justification")}
      </div>

      <div className="field field-narrow">
        <label htmlFor={fieldId("needed-by")}>Data desejada de entrega</label>
        <input
          {...fieldProps("needed-by")}
          type="date"
          value={neededBy}
          onChange={(event) => setNeededBy(event.target.value)}
        />
        {fieldError("needed-by")}
      </div>

      <fieldset className="items">
        <legend>Itens</legend>

        {items.map((item, index) => (
          <div className="item-row" key={fieldId(`item-${index}`)}>
            <p className="item-row-title">Item {index + 1}</p>

            <div className="field">
              <label htmlFor={fieldId(`item-${index}-description`)}>Descrição</label>
              <input
                {...fieldProps(`item-${index}-description`)}
                type="text"
                maxLength={500}
                value={item.description}
                onChange={(event) =>
                  updateItem(index, { description: event.target.value })
                }
              />
              {fieldError(`item-${index}-description`)}
            </div>

            <div className="field field-narrow">
              <label htmlFor={fieldId(`item-${index}-unit`)}>Unidade de medida</label>
              <input
                {...fieldProps(`item-${index}-unit`)}
                type="text"
                maxLength={20}
                value={item.unitOfMeasure}
                onChange={(event) =>
                  updateItem(index, { unitOfMeasure: event.target.value })
                }
              />
              {fieldError(`item-${index}-unit`)}
            </div>

            <div className="field field-narrow">
              <label htmlFor={fieldId(`item-${index}-quantity`)}>Quantidade</label>
              <input
                {...fieldProps(`item-${index}-quantity`)}
                type="text"
                inputMode="decimal"
                value={item.quantity}
                onChange={(event) =>
                  updateItem(index, { quantity: event.target.value })
                }
              />
              <p className="field-hint">
                Até três casas decimais, com ponto. Exemplo: 1.250
                {QUANTITY_PATTERN.test(item.quantity)
                  ? ` (${formatQuantity(item.quantity)})`
                  : ""}
              </p>
              {fieldError(`item-${index}-quantity`)}
            </div>

            <div className="field field-narrow">
              <label htmlFor={fieldId(`item-${index}-price`)}>
                Preço unitário estimado, em centavos
              </label>
              <input
                {...fieldProps(`item-${index}-price`)}
                type="text"
                inputMode="numeric"
                value={item.estimatedUnitPriceCents}
                onChange={(event) =>
                  updateItem(index, { estimatedUnitPriceCents: event.target.value })
                }
              />
              <p className="field-hint">
                Somente dígitos. Exemplo: 549900
                {CENTS_PATTERN.test(item.estimatedUnitPriceCents)
                  ? ` (${formatCents(item.estimatedUnitPriceCents)})`
                  : ""}
              </p>
              {fieldError(`item-${index}-price`)}
            </div>

            {items.length > 1 ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() =>
                  setItems((current) =>
                    current.filter((_unused, position) => position !== index)
                  )
                }
              >
                Remover item {index + 1}
              </button>
            ) : null}
          </div>
        ))}

        <button
          type="button"
          className="button button-secondary"
          onClick={() => setItems((current) => [...current, emptyItem()])}
        >
          Adicionar item
        </button>
      </fieldset>

      <p className="form-note">
        O total estimado, a posição de cada item e a situação da solicitação são calculados
        pelo servidor.
      </p>

      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={pending}>
          {pending ? "Enviando..." : submitLabel}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel}>
          Voltar
        </button>
      </div>
    </form>
  );
}

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DraftForm } from "./draft-form";

function renderForm(onSubmit = vi.fn()) {
  render(
    <DraftForm
      submitLabel="Salvar rascunho"
      pending={false}
      failure={null}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
    />
  );

  return onSubmit;
}

async function fillValidDraft(): Promise<void> {
  await userEvent.type(
    screen.getByLabelText("Justificativa"),
    "  Reposição de notebooks  "
  );
  await userEvent.type(screen.getByLabelText("Data desejada de entrega"), "2026-11-30");
  await userEvent.type(screen.getByLabelText("Descrição"), "Notebook 16 GB");
  await userEvent.type(screen.getByLabelText("Unidade de medida"), "UN");
  await userEvent.type(screen.getByLabelText("Quantidade"), "1.250");
  await userEvent.type(
    screen.getByLabelText("Preço unitário estimado, em centavos"),
    "549900"
  );
}

describe("purchase request draft form", () => {
  it("reports every empty field and focuses the first one", async () => {
    const onSubmit = renderForm();

    await userEvent.click(screen.getByRole("button", { name: "Salvar rascunho" }));

    expect(onSubmit).not.toHaveBeenCalled();

    const justification = screen.getByLabelText("Justificativa");

    expect(document.activeElement).toBe(justification);
    expect(justification.getAttribute("aria-invalid")).toBe("true");
    expect(
      screen.getByText("Informe a justificativa da solicitação.").getAttribute("id")
    ).toBe(justification.getAttribute("aria-describedby"));
    expect(screen.getByText("Descreva o item.")).toBeDefined();
    expect(screen.getByText("Informe a unidade de medida.")).toBeDefined();
  });

  it("refuses a quantity or an amount that is not canonical", async () => {
    const onSubmit = renderForm();

    await userEvent.type(screen.getByLabelText("Justificativa"), "Reposição");
    await userEvent.type(screen.getByLabelText("Data desejada de entrega"), "2026-11-30");
    await userEvent.type(screen.getByLabelText("Descrição"), "Notebook");
    await userEvent.type(screen.getByLabelText("Unidade de medida"), "UN");
    await userEvent.type(screen.getByLabelText("Quantidade"), "1.2345");
    await userEvent.type(
      screen.getByLabelText("Preço unitário estimado, em centavos"),
      "5499,00"
    );
    await userEvent.click(screen.getByRole("button", { name: "Salvar rascunho" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByText("Use um número com até três casas decimais, como 1.250.")
    ).toBeDefined();
    expect(
      screen.getByText(
        "Informe o preço unitário estimado em centavos, apenas dígitos."
      )
    ).toBeDefined();
  });

  it("submits only the fields the api accepts", async () => {
    const onSubmit = renderForm();

    await fillValidDraft();
    await userEvent.click(screen.getByRole("button", { name: "Salvar rascunho" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      justification: "Reposição de notebooks",
      neededBy: "2026-11-30",
      items: [
        {
          description: "Notebook 16 GB",
          unitOfMeasure: "UN",
          quantity: "1.250",
          estimatedUnitPriceCents: "549900"
        }
      ]
    });

    const payload = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;

    for (const forbidden of [
      "estimatedTotalCents",
      "status",
      "organizationId",
      "requesterId",
      "departmentId"
    ]) {
      expect(payload[forbidden]).toBeUndefined();
    }
  });

  it("adds and removes item rows", async () => {
    renderForm();

    await userEvent.click(screen.getByRole("button", { name: "Adicionar item" }));

    expect(screen.getAllByLabelText("Descrição")).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Remover item 2" }));

    expect(screen.getAllByLabelText("Descrição")).toHaveLength(1);
  });

  it("disables the action while a mutation is in flight", () => {
    render(
      <DraftForm
        submitLabel="Salvar rascunho"
        pending
        failure={null}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Enviando..." })).toHaveProperty(
      "disabled",
      true
    );
  });

  it("shows an ambiguous outcome as recoverable without retrying", () => {
    render(
      <DraftForm
        submitLabel="Salvar rascunho"
        pending={false}
        ambiguous
        failure={{
          kind: "network",
          status: null,
          message: "Não foi possível falar com o servidor.",
          details: []
        }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const alert = screen.getByRole("alert");

    expect(alert.textContent).toContain("Não é possível saber se a operação foi concluída");
    expect(alert.querySelector("button")).toBeNull();
  });
});

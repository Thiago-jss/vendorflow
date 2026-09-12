import type { SupplierTaxIdentifierType } from "./contracts";

const TAX_IDENTIFIER_TYPE_LABELS: Readonly<Record<SupplierTaxIdentifierType, string>> = {
  CNPJ: "CNPJ",
  OTHER: "Outro"
};

export function taxIdentifierTypeLabel(type: SupplierTaxIdentifierType): string {
  return TAX_IDENTIFIER_TYPE_LABELS[type] ?? type;
}

/** An instant, shown in the reader's own time zone. */
export function formatTimestamp(value: string | null): string {
  if (value === null) {
    return "—";
  }

  const instant = new Date(value);

  if (Number.isNaN(instant.getTime())) {
    return "—";
  }

  const pad = (part: number) => String(part).padStart(2, "0");

  return `${pad(instant.getDate())}/${pad(instant.getMonth() + 1)}/${instant.getFullYear()} ${pad(instant.getHours())}:${pad(instant.getMinutes())}`;
}

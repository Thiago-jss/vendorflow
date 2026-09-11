import type {
  ApprovalStepRole,
  ApprovalStepState,
  PurchaseRequestStatus
} from "./contracts";

/**
 * Display formatting for values the system keeps exactly.
 *
 * A centavo amount and a quantity arrive as canonical decimal text and are re-spelled here
 * by moving characters around. There is no `Number`, no `parseFloat` and no `toFixed` in
 * this file: a total above 2^53 and a quantity such as 0.1 both have to survive being shown.
 *
 * Anything that is not canonical is shown as an em dash rather than guessed at. A rendering
 * helper is not the place to decide what a malformed amount probably meant.
 */
export const UNAVAILABLE = "—";

const CENTS_PATTERN = /^(0|[1-9]\d*)$/;
const QUANTITY_PATTERN = /^(0|[1-9]\d*)(?:\.\d{1,3})?$/;
const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** "687375" becomes "R$ 6.873,75". Exact at any magnitude, because it is string surgery. */
export function formatCents(value: string): string {
  if (!CENTS_PATTERN.test(value)) {
    return UNAVAILABLE;
  }

  const padded = value.padStart(3, "0");
  const reais = padded.slice(0, -2);
  const centavos = padded.slice(-2);

  return `R$ ${groupThousands(reais)},${centavos}`;
}

/** "1.250" becomes "1,250": the decimal separator changes, the precision does not. */
export function formatQuantity(value: string): string {
  if (!QUANTITY_PATTERN.test(value)) {
    return UNAVAILABLE;
  }

  const [whole = "", fraction] = value.split(".");

  return fraction === undefined
    ? groupThousands(whole)
    : `${groupThousands(whole)},${fraction}`;
}

/** A calendar day, not an instant: no time zone is applied to it. */
export function formatCalendarDate(value: string): string {
  const parts = CALENDAR_DATE_PATTERN.exec(value);

  if (parts === null) {
    return UNAVAILABLE;
  }

  const [, year, month, day] = parts;

  return `${day}/${month}/${year}`;
}

/** An instant, shown in the reader's own time zone. */
export function formatTimestamp(value: string | null): string {
  if (value === null) {
    return UNAVAILABLE;
  }

  const instant = new Date(value);

  if (Number.isNaN(instant.getTime())) {
    return UNAVAILABLE;
  }

  const pad = (part: number) => String(part).padStart(2, "0");

  return `${pad(instant.getDate())}/${pad(instant.getMonth() + 1)}/${instant.getFullYear()} ${pad(instant.getHours())}:${pad(instant.getMinutes())}`;
}

const STATUS_LABELS: Readonly<Record<PurchaseRequestStatus, string>> = {
  DRAFT: "Rascunho",
  SUBMITTED: "Enviada",
  IN_QUOTATION: "Em cotação",
  IN_FINAL_APPROVAL: "Em aprovação final",
  APPROVED: "Aprovada",
  ORDERED: "Pedido emitido",
  REJECTED: "Rejeitada",
  CANCELLED: "Cancelada"
};

/** The status the API reported, in words. The label never decides what may be done. */
export function statusLabel(status: PurchaseRequestStatus): string {
  return STATUS_LABELS[status] ?? status;
}

const APPROVAL_STEP_ROLE_LABELS: Readonly<Record<ApprovalStepRole, string>> = {
  MANAGER: "Gestor",
  PURCHASING: "Compras",
  FINANCE: "Financeiro"
};

/**
 * The responsibility a rung of the ladder belongs to, in words.
 *
 * It is a step role and not a principal's role: a Purchasing step is decided by a BUYER, and
 * the two vocabularies meet only on the server.
 */
export function approvalStepRoleLabel(role: ApprovalStepRole): string {
  return APPROVAL_STEP_ROLE_LABELS[role] ?? role;
}

const APPROVAL_STEP_STATE_LABELS: Readonly<Record<ApprovalStepState, string>> = {
  PENDING: "Aguardando etapas anteriores",
  ACTIONABLE: "Aguardando decisão",
  APPROVED: "Aprovada",
  REJECTED: "Rejeitada",
  VOIDED: "Sem efeito"
};

/** The state the API reported for a rung. Never inferred from timestamps. */
export function approvalStepStateLabel(state: ApprovalStepState): string {
  return APPROVAL_STEP_STATE_LABELS[state] ?? state;
}

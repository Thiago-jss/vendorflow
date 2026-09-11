/**
 * Every failure the UI can meet, reduced to a closed set the interface knows how to render.
 *
 * The API's own error body is never rendered as-is: a response carries a status this module
 * maps to a message written here, plus — only for the two statuses that describe the payload
 * the user just typed — a bounded list of plain-text details. Nothing else from the body
 * reaches the screen, so an unexpected field, a stack trace or an HTML error page cannot.
 */
export type ApiFailureKind =
  | "network"
  | "invalid-request"
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "unprocessable"
  | "rate-limited"
  | "server"
  | "unknown";

export interface ApiFailure {
  readonly kind: ApiFailureKind;
  /** Null when the request never reached the API. */
  readonly status: number | null;
  readonly message: string;
  /** Bounded, plain-text validation details. Empty for every other kind. */
  readonly details: readonly string[];
}

const MESSAGES: Readonly<Record<ApiFailureKind, string>> = {
  network:
    "Não foi possível falar com o servidor. Verifique a conexão e tente novamente.",
  "invalid-request":
    "Os dados enviados não foram aceitos. Revise os campos e tente novamente.",
  unauthorized: "Sua sessão não está mais ativa. Entre novamente para continuar.",
  forbidden: "Você não tem permissão para executar esta ação.",
  "not-found": "Registro não encontrado.",
  conflict:
    "O estado atual do registro não permite esta ação. Recarregue e verifique antes de repetir.",
  unprocessable:
    "Os dados enviados não atendem a uma regra do sistema. Revise e tente novamente.",
  "rate-limited":
    "Muitas tentativas em pouco tempo. Aguarde alguns instantes e tente novamente.",
  server:
    "O servidor não conseguiu concluir a operação. Tente novamente em instantes.",
  unknown: "Não foi possível concluir a operação."
};

const MAXIMUM_DETAILS = 5;
const MAXIMUM_DETAIL_LENGTH = 200;
/** Printable text only: a control character has no place in a rendered message. */
const PRINTABLE_DETAIL = /^[^\p{Cc}\p{Cf}]+$/u;

function kindForStatus(status: number): ApiFailureKind {
  switch (status) {
    case 400:
      return "invalid-request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not-found";
    case 409:
      return "conflict";
    case 422:
      return "unprocessable";
    case 429:
      return "rate-limited";
    default:
      return status >= 500 ? "server" : "unknown";
  }
}

function readDetails(body: unknown): readonly string[] {
  if (typeof body !== "object" || body === null || !("message" in body)) {
    return [];
  }

  const message: unknown = (body as { message: unknown }).message;
  const candidates = typeof message === "string" ? [message] : message;

  if (!Array.isArray(candidates)) {
    return [];
  }

  return candidates
    .filter(
      (candidate): candidate is string =>
        typeof candidate === "string" &&
        candidate.length > 0 &&
        candidate.length <= MAXIMUM_DETAIL_LENGTH &&
        PRINTABLE_DETAIL.test(candidate)
    )
    .slice(0, MAXIMUM_DETAILS);
}

export function normalizeApiFailure(status: number, body: unknown): ApiFailure {
  const kind = kindForStatus(status);
  // Only the two statuses that are *about the submitted payload* carry details forward. A
  // 403, a 404 or a 409 answers with the message written above and nothing the server may
  // have said about the resource behind it.
  const details =
    kind === "invalid-request" || kind === "unprocessable"
      ? readDetails(body)
      : [];

  return { kind, status, message: MESSAGES[kind], details };
}

export function networkFailure(): ApiFailure {
  return {
    kind: "network",
    status: null,
    message: MESSAGES.network,
    details: []
  };
}

export function failureOfKind(kind: ApiFailureKind): ApiFailure {
  return { kind, status: null, message: MESSAGES[kind], details: [] };
}

/** The transport throws this and only this, so no raw `Error` can reach a rendered surface. */
export class ApiRequestError extends Error {
  readonly failure: ApiFailure;

  constructor(failure: ApiFailure) {
    super(failure.message);
    this.name = "ApiRequestError";
    this.failure = failure;
  }
}

export function toApiFailure(error: unknown): ApiFailure {
  return error instanceof ApiRequestError ? error.failure : failureOfKind("unknown");
}

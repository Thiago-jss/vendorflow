"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  approvalStepRoleLabel,
  approvalStepStateLabel,
  formatCalendarDate,
  formatCents,
  formatTimestamp,
  statusLabel
} from "@/purchase-requests/formatting";
import { createIdempotencyKeyStore } from "@/purchase-requests/idempotency";
import { StatusBadge } from "@/purchase-requests/status-badge";
import { toApiFailure, type ApiFailure } from "@/session/api-error";
import { useSession } from "@/session/session-context";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { EmptyState, FailureAlert, LoadingRegion } from "@/ui/feedback";
import { decideApproval, listApprovalQueue } from "./api";
import type { ApprovalDecision, ApprovalQueueItem } from "./contracts";
import { approvalDecisionFingerprint } from "./idempotency";

/** FR-031, as a courtesy check. The API counts after trimming and remains the authority. */
const MINIMUM_REJECTION_REASON_CHARACTERS = 10;

const DECISION_TITLE: Readonly<Record<ApprovalDecision, string>> = {
  APPROVED: "Aprovar esta solicitação?",
  REJECTED: "Rejeitar esta solicitação?"
};

const DECISION_CONFIRM_LABEL: Readonly<Record<ApprovalDecision, string>> = {
  APPROVED: "Aprovar solicitação",
  REJECTED: "Rejeitar solicitação"
};

const DECISION_CONSEQUENCE: Readonly<Record<ApprovalDecision, string>> = {
  APPROVED:
    "A aprovação é definitiva: não existe desfazer, e a solicitação segue para cotação.",
  REJECTED:
    "A rejeição é definitiva: não existe desfazer, a solicitação é encerrada e as etapas restantes deixam de ter efeito."
};

const DECISION_SETTLED_LABEL: Readonly<Record<ApprovalDecision, string>> = {
  APPROVED: "Solicitação aprovada",
  REJECTED: "Solicitação rejeitada"
};

/** The decision the manager is composing. It is never sent; only its two fields are. */
interface DecisionIntent {
  readonly item: ApprovalQueueItem;
  readonly decision: ApprovalDecision;
}

function nonWhitespaceLength(text: string): number {
  return text.replace(/\s/gu, "").length;
}

/**
 * A decision whose outcome the browser cannot know.
 *
 * A dropped connection, a 5xx and a 429 all leave the question "did it land?" open, and an
 * unrecognized status is no better. None of them may be retried automatically; all of them
 * may be retried by the person, with the same key, which is exactly what REL-004 makes safe.
 *
 * Everything else — 400, 401, 403, 404, 409, 422 — is definitive for this attempt, so its key
 * is spent and a new intent has to start a new one.
 */
function isAmbiguousDecisionFailure(failure: ApiFailure): boolean {
  return (
    failure.kind === "network" ||
    failure.kind === "server" ||
    failure.kind === "rate-limited" ||
    failure.kind === "unknown"
  );
}

/**
 * A queue row's decision controls are offered only for the step the server says is waiting,
 * and only when that step is the Manager's.
 *
 * This is an affordance and not a copy of the policy. The API decides who may act on which
 * rung, refuses self-approval, and answers a conflict when the ladder moved underneath the
 * reader; every one of those answers is rendered rather than pre-empted.
 */
function isActionableByManager(item: ApprovalQueueItem): boolean {
  return (
    item.pendingStep.state === "ACTIONABLE" && item.pendingStep.role === "MANAGER"
  );
}

/**
 * The Manager's approval inbox.
 *
 * It shows exactly what the queue endpoint publishes: a request summary and the rung waiting
 * on the caller. It never reads `GET /purchase-requests/{id}`, which is the requester's own
 * route — a manager has no published way to read another employee's justification or items,
 * and inventing one client-side would just be a 404 with extra steps.
 */
export function ApprovalInbox() {
  const { session } = useSession();
  const fieldPrefix = useId();
  const reasonFieldId = `${fieldPrefix}-reason`;
  const reasonHintId = `${reasonFieldId}-hint`;
  const reasonErrorId = `${reasonFieldId}-error`;

  const [items, setItems] = useState<readonly ApprovalQueueItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loadFailure, setLoadFailure] = useState<ApiFailure | null>(null);

  const [intent, setIntent] = useState<DecisionIntent | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [decisionFailure, setDecisionFailure] = useState<ApiFailure | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);
  const [settled, setSettled] = useState<string | null>(null);

  // One decision intent's key, in the memory of this document and nowhere else: not a log,
  // not a URL, not storage.
  const idempotencyKeys = useRef(createIdempotencyKeyStore());

  const loadPage = useCallback(
    async (after: string | null) => {
      setLoading(true);
      setLoadFailure(null);

      try {
        const page = await listApprovalQueue(session, { cursor: after });

        setItems((current) =>
          after === null ? page.items : [...current, ...page.items]
        );
        setCursor(page.nextCursor);
        setLoaded(true);
      } catch (error: unknown) {
        setLoadFailure(toApiFailure(error));
      } finally {
        setLoading(false);
      }
    },
    [session]
  );

  useEffect(() => {
    void loadPage(null);
  }, [loadPage]);

  const openDecision = useCallback(
    (item: ApprovalQueueItem, decision: ApprovalDecision) => {
      setIntent({ item, decision });
      setReason("");
      setReasonError(null);
      setDecisionFailure(null);
      setAmbiguous(false);
      setSettled(null);
    },
    []
  );

  const closeDecision = useCallback(() => {
    setIntent(null);
    setReason("");
    setReasonError(null);
  }, []);

  const reloadFromDialog = useCallback(() => {
    closeDecision();
    setDecisionFailure(null);
    setAmbiguous(false);
    void loadPage(null);
  }, [closeDecision, loadPage]);

  const confirmDecision = useCallback(async () => {
    if (intent === null) {
      return;
    }

    const trimmedReason = reason.trim();

    if (
      intent.decision === "REJECTED" &&
      nonWhitespaceLength(trimmedReason) < MINIMUM_REJECTION_REASON_CHARACTERS
    ) {
      setReasonError(
        `Descreva o motivo da rejeição com pelo menos ${MINIMUM_REJECTION_REASON_CHARACTERS} caracteres.`
      );
      document.getElementById(reasonFieldId)?.focus();

      return;
    }

    setReasonError(null);
    setDeciding(true);
    setDecisionFailure(null);
    setAmbiguous(false);

    // The same intent keeps the same key, including across an explicit retry of an answer
    // the browser never saw.
    const key = idempotencyKeys.current.keyFor(
      approvalDecisionFingerprint({
        purchaseRequestId: intent.item.request.id,
        approvalStepId: intent.item.pendingStep.id,
        decision: intent.decision,
        reason: trimmedReason
      })
    );

    try {
      const outcome = await decideApproval(
        session,
        intent.item.request.id,
        trimmedReason.length === 0
          ? { decision: intent.decision }
          : { decision: intent.decision, reason: trimmedReason },
        key
      );

      // A definitive answer: the key has done its work and must not be reused.
      idempotencyKeys.current.discard();
      setItems((current) =>
        current.filter((row) => row.request.id !== intent.item.request.id)
      );
      setSettled(
        `${DECISION_SETTLED_LABEL[intent.decision]}. Situação atual da solicitação: ${statusLabel(outcome.status)}.`
      );
      closeDecision();
    } catch (error: unknown) {
      const failure = toApiFailure(error);
      const retryable = isAmbiguousDecisionFailure(failure);

      if (!retryable) {
        // Spent. Reopening the decision afterwards is a new attempt, with a new key.
        idempotencyKeys.current.discard();
        closeDecision();
      }

      setDecisionFailure(failure);
      setAmbiguous(retryable);
    } finally {
      setDeciding(false);
    }
  }, [closeDecision, intent, reason, reasonFieldId, session]);

  if (loadFailure !== null && items.length === 0) {
    return <FailureAlert failure={loadFailure} onRetry={() => void loadPage(null)} />;
  }

  if (!loaded && loading) {
    return <LoadingRegion label="Carregando a fila de aprovações..." />;
  }

  const decisionDialog =
    intent === null ? null : (
      <ConfirmDialog
        titleId="approval-decision-title"
        title={DECISION_TITLE[intent.decision]}
        confirmLabel={
          ambiguous ? "Tentar novamente" : DECISION_CONFIRM_LABEL[intent.decision]
        }
        confirmTone={intent.decision === "APPROVED" ? "primary" : "danger"}
        cancelLabel="Voltar para a fila"
        busy={deciding}
        onConfirm={() => void confirmDecision()}
        onCancel={closeDecision}
      >
        <p>{DECISION_CONSEQUENCE[intent.decision]}</p>

        <dl className="definition-grid">
          <div>
            <dt>Valor avaliado nesta etapa</dt>
            <dd>{formatCents(intent.item.pendingStep.evaluatedAmountCents)}</dd>
          </div>
          <div>
            <dt>Total estimado</dt>
            <dd>{formatCents(intent.item.request.estimatedTotalCents)}</dd>
          </div>
          <div>
            <dt>Enviada em</dt>
            <dd>{formatTimestamp(intent.item.request.submittedAt)}</dd>
          </div>
          <div>
            <dt>Itens</dt>
            <dd>{intent.item.request.itemCount}</dd>
          </div>
        </dl>

        <div className="field">
          <label htmlFor={reasonFieldId}>
            {intent.decision === "REJECTED"
              ? "Motivo da rejeição"
              : "Justificativa da aprovação (opcional)"}
          </label>
          <textarea
            id={reasonFieldId}
            rows={3}
            maxLength={2000}
            value={reason}
            aria-invalid={reasonError === null ? undefined : true}
            aria-describedby={reasonError === null ? reasonHintId : reasonErrorId}
            onChange={(event) => setReason(event.target.value)}
          />
          {reasonError === null ? (
            <p className="field-hint" id={reasonHintId}>
              {intent.decision === "REJECTED"
                ? `Obrigatório, com pelo menos ${MINIMUM_REJECTION_REASON_CHARACTERS} caracteres. O motivo fica registrado na trilha de auditoria.`
                : "Opcional. Se preenchida, fica registrada na trilha de auditoria."}
            </p>
          ) : (
            <p className="field-error" id={reasonErrorId}>
              {reasonError}
            </p>
          )}
        </div>

        {decisionFailure === null ? null : (
          <FailureAlert
            failure={decisionFailure}
            ambiguous={ambiguous}
            onRetry={reloadFromDialog}
            retryLabel="Recarregar fila"
          />
        )}
      </ConfirmDialog>
    );

  if (loaded && items.length === 0 && cursor === null) {
    return (
      <>
        {settled === null ? null : (
          <p className="notice" role="status">
            {settled}
          </p>
        )}
        {decisionFailure === null || intent !== null ? null : (
          <FailureAlert
            failure={decisionFailure}
            ambiguous={ambiguous}
            onRetry={() => void loadPage(null)}
            retryLabel="Recarregar fila"
          />
        )}
        <EmptyState title="Nenhuma solicitação aguarda a sua aprovação.">
          <p>
            Apenas solicitações enviadas do seu departamento e paradas em uma etapa de gestor
            aparecem aqui. As suas próprias solicitações nunca entram nesta fila: ninguém
            aprova o que pediu.
          </p>
        </EmptyState>
        {decisionDialog}
      </>
    );
  }

  return (
    <div className="list" aria-busy={loading}>
      {settled === null ? null : (
        <p className="notice" role="status">
          {settled}
        </p>
      )}

      {/* While the dialog is open it carries its own alert, so the failure is stated once. */}
      {decisionFailure === null || intent !== null ? null : (
        <FailureAlert
          failure={decisionFailure}
          ambiguous={ambiguous}
          onRetry={() => void loadPage(null)}
          retryLabel="Recarregar fila"
        />
      )}

      {items.length === 0 ? (
        <p className="list-end">
          Nada nesta página aguarda decisão. Carregue mais para ver o restante da fila.
        </p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">
              Solicitações do seu departamento aguardando a sua decisão, da mais recente para
              a mais antiga
            </caption>
            <thead>
              <tr>
                <th scope="col">Situação</th>
                <th scope="col">Enviada em</th>
                <th scope="col">Necessária em</th>
                <th scope="col">Itens</th>
                <th scope="col">Total estimado</th>
                <th scope="col">Etapa</th>
                <th scope="col">Valor avaliado</th>
                <th scope="col">
                  <span className="visually-hidden">Decisão</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const submittedAt = formatTimestamp(item.request.submittedAt);
                const rowContext = ` solicitação enviada em ${submittedAt}`;

                return (
                  <tr key={item.request.id}>
                    <td>
                      <StatusBadge status={item.request.status} />
                    </td>
                    <td>{submittedAt}</td>
                    <td>{formatCalendarDate(item.request.neededBy)}</td>
                    <td className="numeric">{item.request.itemCount}</td>
                    <td className="numeric">
                      {formatCents(item.request.estimatedTotalCents)}
                    </td>
                    <td>
                      <span className="step-cell">
                        <span>{approvalStepRoleLabel(item.pendingStep.role)}</span>
                        <span className="step-cell-state">
                          {approvalStepStateLabel(item.pendingStep.state)}
                        </span>
                      </span>
                    </td>
                    <td className="numeric">
                      {formatCents(item.pendingStep.evaluatedAmountCents)}
                    </td>
                    <td>
                      {isActionableByManager(item) ? (
                        <span className="row-actions">
                          <button
                            type="button"
                            className="button button-primary"
                            disabled={deciding}
                            onClick={() => openDecision(item, "APPROVED")}
                          >
                            Aprovar
                            <span className="visually-hidden">{rowContext}</span>
                          </button>
                          <button
                            type="button"
                            className="button button-danger"
                            disabled={deciding}
                            onClick={() => openDecision(item, "REJECTED")}
                          >
                            Rejeitar
                            <span className="visually-hidden">{rowContext}</span>
                          </button>
                        </span>
                      ) : (
                        <span className="step-cell-state">
                          Sem decisão disponível para você nesta etapa.
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {loadFailure === null ? null : (
        <FailureAlert
          failure={loadFailure}
          onRetry={() => void loadPage(cursor)}
          retryLabel="Tentar carregar mais"
        />
      )}

      {cursor === null ? (
        <p className="list-end">Fim da fila.</p>
      ) : (
        <button
          type="button"
          className="button button-secondary"
          disabled={loading}
          onClick={() => void loadPage(cursor)}
        >
          {loading ? "Carregando..." : "Carregar mais"}
        </button>
      )}

      {decisionDialog}
    </div>
  );
}

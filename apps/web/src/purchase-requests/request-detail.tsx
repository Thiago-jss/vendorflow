"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toApiFailure, type ApiFailure } from "@/session/api-error";
import { useSession } from "@/session/session-context";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { FailureAlert, LoadingRegion } from "@/ui/feedback";
import {
  cancelPurchaseRequest,
  getPurchaseRequest,
  submitPurchaseRequest
} from "./api";
import type {
  ApprovalStep,
  PurchaseRequest,
  PurchaseRequestStatus
} from "./contracts";
import {
  formatCalendarDate,
  formatCents,
  formatQuantity,
  formatTimestamp,
  statusLabel
} from "./formatting";
import { createIdempotencyKeyStore, submissionFingerprint } from "./idempotency";
import { StatusBadge } from "./status-badge";

/**
 * One request, as the API describes it.
 *
 * Every value shown here is the server's: the status, the estimated total, each line total,
 * the approval ladder, and the two supplements that are null until quotation and ordering
 * produce them. The page recomputes none of it.
 *
 * The two actions are affordances. Whether a draft may be submitted and whether a request may
 * be cancelled are decided by the API, and its refusal is rendered rather than pre-empted.
 */
const APPROVAL_STEP_ROLE_LABELS: Readonly<Record<string, string>> = {
  MANAGER: "Gestor",
  PURCHASING: "Compras",
  FINANCE: "Financeiro"
};

const APPROVAL_STEP_STATE_LABELS: Readonly<Record<string, string>> = {
  PENDING: "Aguardando etapas anteriores",
  ACTIONABLE: "Aguardando decisão",
  APPROVED: "Aprovada",
  REJECTED: "Rejeitada",
  VOIDED: "Sem efeito"
};

/**
 * Presentation only. The states from which the API accepts a cancellation, named so the page
 * stops offering a button that is certainly refused.
 *
 * It is an affordance and not a rule: the API decides, and a request whose state changed
 * underneath the reader still answers with a conflict, which this page renders like any
 * other refusal. Stated as an allowlist rather than as "everything but the terminal states"
 * so a state added to the lifecycle later is silently *not* offered until someone checks.
 */
const CANCELLABLE_STATUSES: readonly PurchaseRequestStatus[] = [
  "DRAFT",
  "SUBMITTED",
  "IN_QUOTATION",
  "IN_FINAL_APPROVAL",
  "APPROVED"
];

/** A failure whose retry is safe because the submission carries the same key (REL-004). */
function isRetryableSubmission(failure: ApiFailure): boolean {
  return (
    failure.kind === "network" ||
    failure.kind === "server" ||
    failure.kind === "rate-limited"
  );
}

export function RequestDetail({
  purchaseRequestId
}: {
  readonly purchaseRequestId: string;
}) {
  const { session, context } = useSession();
  const [request, setRequest] = useState<PurchaseRequest | null>(null);
  const [loadFailure, setLoadFailure] = useState<ApiFailure | null>(null);
  const [actionFailure, setActionFailure] = useState<ApiFailure | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);
  const [pending, setPending] = useState(false);
  const [confirmingCancellation, setConfirmingCancellation] = useState(false);
  // Kept for the lifetime of this page's submission intent, and nowhere else.
  const idempotencyKeys = useRef(createIdempotencyKeyStore());

  const load = useCallback(async () => {
    setLoadFailure(null);

    try {
      setRequest(await getPurchaseRequest(session, purchaseRequestId));
    } catch (error: unknown) {
      setLoadFailure(toApiFailure(error));
    }
  }, [purchaseRequestId, session]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(async () => {
    if (request === null) {
      return;
    }

    setPending(true);
    setActionFailure(null);
    setAmbiguous(false);

    const key = idempotencyKeys.current.keyFor(submissionFingerprint(request));

    try {
      setRequest(await submitPurchaseRequest(session, request.id, key));
      // A definitive answer: the key has done its work and must not be reused.
      idempotencyKeys.current.discard();
    } catch (error: unknown) {
      const failure = toApiFailure(error);

      if (!isRetryableSubmission(failure)) {
        idempotencyKeys.current.discard();
      }

      setActionFailure(failure);
      setAmbiguous(isRetryableSubmission(failure));
    } finally {
      setPending(false);
    }
  }, [request, session]);

  const cancel = useCallback(async () => {
    if (request === null) {
      return;
    }

    setPending(true);
    setActionFailure(null);
    setAmbiguous(false);

    try {
      setRequest(await cancelPurchaseRequest(session, request.id));
      setConfirmingCancellation(false);
    } catch (error: unknown) {
      const failure = toApiFailure(error);

      setActionFailure(failure);
      // Cancellation carries no idempotency key, so a network or server failure leaves an
      // outcome the browser cannot know. It is never retried automatically.
      setAmbiguous(failure.kind === "network" || failure.kind === "server");
      setConfirmingCancellation(false);
    } finally {
      setPending(false);
    }
  }, [request, session]);

  if (loadFailure !== null) {
    return <FailureAlert failure={loadFailure} onRetry={() => void load()} />;
  }

  if (request === null) {
    return <LoadingRegion label="Carregando solicitação..." />;
  }

  const isRequester = context?.membership.userId === request.requesterId;
  const isDraft = request.status === "DRAFT";
  const canEdit = isDraft && isRequester;
  const canCancel = isRequester && CANCELLABLE_STATUSES.includes(request.status);

  function decisionAuthorLabel(step: ApprovalStep): string {
    if (step.decidedById === null) {
      return "Sem decisão registrada";
    }

    // The API publishes no person directory, and a raw identifier is not a name. The only
    // honest personalization is "you".
    return step.decidedById === context?.membership.userId
      ? "Você"
      : `Responsável por ${APPROVAL_STEP_ROLE_LABELS[step.role] ?? step.role}`;
  }

  return (
    <div className="detail">
      <header className="detail-header">
        <div>
          <p className="eyebrow">Solicitação de compra</p>
          <h1>{formatCents(request.estimatedTotalCents)}</h1>
          <p className="detail-subtitle">
            Total estimado calculado pelo servidor. Situação atual:{" "}
            {statusLabel(request.status)}.
          </p>
        </div>
        <StatusBadge status={request.status} />
      </header>

      {actionFailure === null ? null : (
        <FailureAlert
          failure={actionFailure}
          ambiguous={ambiguous}
          onRetry={
            isRetryableSubmission(actionFailure) && canEdit
              ? () => void submit()
              : () => void load()
          }
          retryLabel={
            isRetryableSubmission(actionFailure) && canEdit
              ? "Tentar enviar novamente"
              : "Recarregar solicitação"
          }
        />
      )}

      <section className="panel" aria-labelledby="summary-heading">
        <h2 id="summary-heading">Resumo</h2>
        <dl className="definition-grid">
          <div>
            <dt>Necessária em</dt>
            <dd>{formatCalendarDate(request.neededBy)}</dd>
          </div>
          <div>
            <dt>Criada em</dt>
            <dd>{formatTimestamp(request.createdAt)}</dd>
          </div>
          <div>
            <dt>Enviada em</dt>
            <dd>{formatTimestamp(request.submittedAt)}</dd>
          </div>
          <div>
            <dt>Cancelada em</dt>
            <dd>{formatTimestamp(request.cancelledAt)}</dd>
          </div>
        </dl>
        <h3>Justificativa</h3>
        <p className="detail-justification">{request.justification}</p>
      </section>

      <section className="panel" aria-labelledby="items-heading">
        <h2 id="items-heading">Itens</h2>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Descrição</th>
                <th scope="col">Unidade</th>
                <th scope="col">Quantidade</th>
                <th scope="col">Preço unitário estimado</th>
                <th scope="col">Total da linha</th>
              </tr>
            </thead>
            <tbody>
              {request.items.map((item) => (
                <tr key={item.id}>
                  <td className="numeric">{item.position}</td>
                  <td>{item.description}</td>
                  <td>{item.unitOfMeasure}</td>
                  <td className="numeric">{formatQuantity(item.quantity)}</td>
                  <td className="numeric">
                    {formatCents(item.estimatedUnitPriceCents)}
                  </td>
                  <td className="numeric">
                    {formatCents(item.estimatedLineTotalCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" aria-labelledby="approval-heading">
        <h2 id="approval-heading">Aprovações</h2>
        {request.approval === null ? (
          <p>
            Um rascunho ainda não tem fluxo de aprovação. Ele é criado quando a solicitação é
            enviada.
          </p>
        ) : (
          <ol className="approval-steps">
            {request.approval.steps.map((step) => (
              <li key={step.id}>
                <p className="approval-step-title">
                  {`Etapa ${step.sequence} — ${APPROVAL_STEP_ROLE_LABELS[step.role] ?? step.role}`}
                </p>
                <dl className="definition-grid">
                  <div>
                    <dt>Situação</dt>
                    <dd>{APPROVAL_STEP_STATE_LABELS[step.state] ?? step.state}</dd>
                  </div>
                  <div>
                    <dt>Valor avaliado</dt>
                    <dd>{formatCents(step.evaluatedAmountCents)}</dd>
                  </div>
                  <div>
                    <dt>Decidida por</dt>
                    <dd>{decisionAuthorLabel(step)}</dd>
                  </div>
                  <div>
                    <dt>Decidida em</dt>
                    <dd>{formatTimestamp(step.decidedAt)}</dd>
                  </div>
                </dl>
                <p className="approval-step-reason">
                  {step.decisionReason === null
                    ? "Sem justificativa registrada."
                    : step.decisionReason}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      {request.selectedQuote === null ? null : (
        <section className="panel" aria-labelledby="quote-heading">
          <h2 id="quote-heading">Cotação selecionada</h2>
          <dl className="definition-grid">
            <div>
              <dt>Total</dt>
              <dd>{formatCents(request.selectedQuote.totalCents)}</dd>
            </div>
            <div>
              <dt>Válida até</dt>
              <dd>{formatCalendarDate(request.selectedQuote.validUntil)}</dd>
            </div>
            <div>
              <dt>Prazo de entrega</dt>
              <dd>{`${request.selectedQuote.deliveryLeadTimeDays} dia(s)`}</dd>
            </div>
            <div>
              <dt>Selecionada em</dt>
              <dd>{formatTimestamp(request.selectedQuote.selectedAt)}</dd>
            </div>
          </dl>
        </section>
      )}

      {request.purchaseOrder === null ? null : (
        <section className="panel" aria-labelledby="order-heading">
          <h2 id="order-heading">Pedido de compra</h2>
          <dl className="definition-grid">
            <div>
              <dt>Número</dt>
              <dd>{request.purchaseOrder.number}</dd>
            </div>
            <div>
              <dt>Situação</dt>
              <dd>
                {request.purchaseOrder.status === "ISSUED" ? "Emitido" : "Cancelado"}
              </dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>{formatCents(request.purchaseOrder.totalCents)}</dd>
            </div>
            <div>
              <dt>Emitido em</dt>
              <dd>{formatTimestamp(request.purchaseOrder.issuedAt)}</dd>
            </div>
          </dl>
        </section>
      )}

      <div className="detail-actions">
        <Link className="button button-secondary" href="/requests">
          Voltar para a lista
        </Link>
        {canEdit ? (
          <Link
            className="button button-secondary"
            href={`/requests/${request.id}/edit`}
          >
            Editar rascunho
          </Link>
        ) : null}
        {canEdit ? (
          <button
            type="button"
            className="button button-primary"
            disabled={pending}
            onClick={() => void submit()}
          >
            {pending ? "Enviando..." : "Enviar para aprovação"}
          </button>
        ) : null}
        {canCancel ? (
          <button
            type="button"
            className="button button-danger"
            disabled={pending}
            onClick={() => setConfirmingCancellation(true)}
          >
            Cancelar solicitação
          </button>
        ) : null}
      </div>

      {confirmingCancellation ? (
        <ConfirmDialog
          titleId="cancel-request-title"
          title="Cancelar esta solicitação?"
          confirmLabel="Cancelar solicitação"
          cancelLabel="Manter solicitação"
          busy={pending}
          onConfirm={() => void cancel()}
          onCancel={() => setConfirmingCancellation(false)}
        >
          <p>
            O cancelamento é definitivo: a solicitação não volta a tramitar e não pode ser
            desfeita. As aprovações ainda pendentes deixam de ter efeito.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

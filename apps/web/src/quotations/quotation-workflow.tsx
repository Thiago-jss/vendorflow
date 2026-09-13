"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  formatCalendarDate,
  formatCents,
  formatTimestamp
} from "@/purchase-requests/formatting";
import { toApiFailure, type ApiFailure } from "@/session/api-error";
import { useSession } from "@/session/session-context";
import type { Supplier } from "@/suppliers/contracts";
import { EmptyState, FailureAlert, LoadingRegion } from "@/ui/feedback";
import {
  getQuotationWork,
  listActiveSuppliers,
  listQuotationQueue,
  registerQuote
} from "./api";
import type {
  QuotationQueueRow,
  QuotationWork,
  QuoteRegistrationInput,
  RegisteredQuote
} from "./contracts";
import { QuoteForm } from "./quote-form";

/**
 * A registration whose outcome the browser cannot know.
 *
 * A dropped connection, a 5xx and a 429 all leave "did it land?" open, and an unrecognized
 * status is no better. The route has no idempotency key, so none of these is retried
 * automatically: only the Buyer deciding to try again — or to reload the queue and look first —
 * sends a second request.
 */
function isAmbiguousRegistrationFailure(failure: ApiFailure): boolean {
  return (
    failure.kind === "network" ||
    failure.kind === "server" ||
    failure.kind === "rate-limited" ||
    failure.kind === "unknown"
  );
}

/** The request a quotation workspace was opened for, and the generation that opened it. */
interface Workspace {
  readonly purchaseRequestId: string;
  readonly generation: number;
}

/**
 * The Buyer quotation workflow: FR-040/FR-041 over the browser.
 *
 * It lists what `GET /purchase-requests/awaiting-quotation` publishes, reads one request only
 * through the narrow quotation-work route, and hands `POST .../quotes` exactly the fields its
 * DTO declares. It never reads `GET /purchase-requests/{id}`, the requester's own route.
 *
 * Tenant, role, request state, line coverage, supplier activity and every total are the API's.
 * This component renders its answers and never pre-empts them.
 */
export function QuotationWorkflow() {
  const { session } = useSession();

  const [rows, setRows] = useState<readonly QuotationQueueRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueLoaded, setQueueLoaded] = useState(false);
  const [queueFailure, setQueueFailure] = useState<ApiFailure | null>(null);

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [work, setWork] = useState<QuotationWork | null>(null);
  const [workspaceFailure, setWorkspaceFailure] = useState<ApiFailure | null>(null);
  const [suppliers, setSuppliers] = useState<readonly Supplier[]>([]);
  const [supplierCursor, setSupplierCursor] = useState<string | null>(null);
  const [loadingSuppliers, setLoadingSuppliers] = useState(false);
  const [supplierFailure, setSupplierFailure] = useState<ApiFailure | null>(null);

  const [registering, setRegistering] = useState(false);
  const [registrationFailure, setRegistrationFailure] = useState<ApiFailure | null>(null);
  const [registrationAmbiguous, setRegistrationAmbiguous] = useState(false);
  const [registered, setRegistered] = useState<RegisteredQuote | null>(null);

  /**
   * One generation per intended queue read. A refresh does not cancel a read already in flight,
   * so every continuation checks that its own generation is still the latest before it may
   * touch the queue state: a superseded answer is discarded instead of applied.
   */
  const queueGeneration = useRef(0);

  /**
   * One generation per quotation workspace. Opening a request, retrying its read and closing
   * the workspace all advance it, so a detail, supplier or registration answer that belongs to
   * an earlier workspace can never populate — or close — a newer one.
   */
  const workspaceGeneration = useRef(0);

  /**
   * Set synchronously, before the POST leaves. A disabled button only takes effect after React
   * re-renders; this refuses a second submission that arrives before that.
   */
  const registrationInFlight = useRef(false);

  const loadQueue = useCallback(
    async (after: string | null) => {
      const generation = ++queueGeneration.current;

      setQueueLoading(true);
      setQueueFailure(null);

      try {
        const page = await listQuotationQueue(session, { cursor: after });

        if (queueGeneration.current !== generation) {
          return;
        }

        setRows((current) => (after === null ? page.items : [...current, ...page.items]));
        setCursor(page.nextCursor);
        setQueueLoaded(true);
      } catch (error: unknown) {
        if (queueGeneration.current !== generation) {
          return;
        }

        setQueueFailure(toApiFailure(error));
      } finally {
        if (queueGeneration.current === generation) {
          setQueueLoading(false);
        }
      }
    },
    [session]
  );

  useEffect(() => {
    void loadQueue(null);
  }, [loadQueue]);

  async function loadWorkspace(purchaseRequestId: string): Promise<void> {
    const generation = ++workspaceGeneration.current;

    setWorkspace({ purchaseRequestId, generation });
    setWork(null);
    setWorkspaceFailure(null);
    setSuppliers([]);
    setSupplierCursor(null);
    setSupplierFailure(null);
    setLoadingSuppliers(false);
    setRegistrationFailure(null);
    setRegistrationAmbiguous(false);

    try {
      const [detail, supplierPage] = await Promise.all([
        getQuotationWork(session, purchaseRequestId),
        listActiveSuppliers(session)
      ]);

      if (workspaceGeneration.current !== generation) {
        // Another request was opened, or this one closed, while the read was in flight.
        return;
      }

      setWork(detail);
      setSuppliers(supplierPage.items);
      setSupplierCursor(supplierPage.nextCursor);
    } catch (error: unknown) {
      if (workspaceGeneration.current !== generation) {
        return;
      }

      setWorkspaceFailure(toApiFailure(error));
    }
  }

  function openWorkspace(row: QuotationQueueRow): void {
    if (registrationInFlight.current) {
      return;
    }

    setRegistered(null);
    void loadWorkspace(row.id);
  }

  function closeWorkspace(): void {
    workspaceGeneration.current += 1;
    setWorkspace(null);
    setWork(null);
    setWorkspaceFailure(null);
    setSuppliers([]);
    setSupplierCursor(null);
    setSupplierFailure(null);
    setLoadingSuppliers(false);
    setRegistering(false);
    setRegistrationFailure(null);
    setRegistrationAmbiguous(false);
  }

  async function loadMoreSuppliers(): Promise<void> {
    if (supplierCursor === null) {
      return;
    }

    const generation = workspaceGeneration.current;

    setLoadingSuppliers(true);
    setSupplierFailure(null);

    try {
      const page = await listActiveSuppliers(session, supplierCursor);

      if (workspaceGeneration.current !== generation) {
        return;
      }

      setSuppliers((current) => [...current, ...page.items]);
      setSupplierCursor(page.nextCursor);
    } catch (error: unknown) {
      if (workspaceGeneration.current !== generation) {
        return;
      }

      setSupplierFailure(toApiFailure(error));
    } finally {
      if (workspaceGeneration.current === generation) {
        setLoadingSuppliers(false);
      }
    }
  }

  async function submitRegistration(input: QuoteRegistrationInput): Promise<void> {
    if (workspace === null || registrationInFlight.current) {
      return;
    }

    const { purchaseRequestId, generation } = workspace;

    registrationInFlight.current = true;
    setRegistering(true);
    setRegistrationFailure(null);
    setRegistrationAmbiguous(false);

    try {
      const quote = await registerQuote(session, purchaseRequestId, input);

      // The quote exists whichever workspace is open now, so the confirmation stands. Only the
      // workspace that submitted it is closed.
      setRegistered(quote);

      if (workspaceGeneration.current === generation) {
        closeWorkspace();
      }

      // Authoritative reconciliation: a fresh first page, rather than assuming the request left
      // the queue or where the rest of it now sits. `loadQueue` reports its own failure and
      // never throws, so it cannot reclassify the registration above.
      void loadQueue(null);
    } catch (error: unknown) {
      if (workspaceGeneration.current !== generation) {
        return;
      }

      const failure = toApiFailure(error);

      // The form stays mounted either way, with everything the Buyer typed. Nothing is resent.
      setRegistrationFailure(failure);
      setRegistrationAmbiguous(isAmbiguousRegistrationFailure(failure));
    } finally {
      registrationInFlight.current = false;

      if (workspaceGeneration.current === generation) {
        setRegistering(false);
      }
    }
  }

  let workspaceContent: ReactNode = null;

  if (workspace !== null) {
    let body: ReactNode;

    if (workspaceFailure !== null) {
      body = (
        <>
          <FailureAlert
            failure={workspaceFailure}
            onRetry={() => void loadWorkspace(workspace.purchaseRequestId)}
          />
          <div className="form-actions">
            <button type="button" className="button button-secondary" onClick={closeWorkspace}>
              Fechar
            </button>
          </div>
        </>
      );
    } else if (work === null) {
      body = <LoadingRegion label="Carregando itens da solicitação..." />;
    } else {
      body = (
        <>
          <dl className="definition-grid">
            <div>
              <dt>Solicitação</dt>
              <dd>
                <code>{work.id}</code>
              </dd>
            </div>
            <div>
              <dt>Necessária em</dt>
              <dd>{formatCalendarDate(work.neededBy)}</dd>
            </div>
          </dl>
          <QuoteForm
            key={workspace.generation}
            items={work.items}
            suppliers={suppliers}
            hasMoreSuppliers={supplierCursor !== null}
            loadingSuppliers={loadingSuppliers}
            supplierFailure={supplierFailure}
            onLoadMoreSuppliers={() => void loadMoreSuppliers()}
            pending={registering}
            failure={registrationFailure}
            ambiguous={registrationAmbiguous}
            onReloadQueue={() => void loadQueue(null)}
            onSubmit={(input) => void submitRegistration(input)}
            onCancel={closeWorkspace}
          />
        </>
      );
    }

    workspaceContent = (
      <div className="panel">
        <h2>Registrar cotação</h2>
        {body}
      </div>
    );
  }

  let queueContent: ReactNode;

  if (queueFailure !== null && rows.length === 0) {
    queueContent = <FailureAlert failure={queueFailure} onRetry={() => void loadQueue(null)} />;
  } else if (!queueLoaded && queueLoading) {
    queueContent = <LoadingRegion label="Carregando a fila de cotação..." />;
  } else if (rows.length === 0 && cursor === null) {
    queueContent = (
      <EmptyState title="Nenhuma solicitação aguarda cotação.">
        <p>Solicitações aprovadas pelo gestor aparecem aqui até receberem cotações.</p>
      </EmptyState>
    );
  } else {
    queueContent = (
      <div className="list" aria-busy={queueLoading}>
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">
              Solicitações da organização aguardando cotação
            </caption>
            <thead>
              <tr>
                <th scope="col">Enviada em</th>
                <th scope="col">Necessária em</th>
                <th scope="col">Itens</th>
                <th scope="col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const neededBy = formatCalendarDate(row.neededBy);

                return (
                  <tr key={row.id}>
                    <td>{formatTimestamp(row.submittedAt)}</td>
                    <td>{neededBy}</td>
                    <td className="numeric">{row.itemCount}</td>
                    <td>
                      <button
                        type="button"
                        className="button button-primary"
                        disabled={registering}
                        onClick={() => openWorkspace(row)}
                      >
                        Cotar
                        <span className="visually-hidden">{` solicitação necessária em ${neededBy}`}</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {queueFailure === null ? null : (
          <FailureAlert
            failure={queueFailure}
            onRetry={() => void loadQueue(cursor)}
            retryLabel="Tentar carregar mais"
          />
        )}

        {cursor === null ? (
          <p className="list-end">Fim da fila.</p>
        ) : (
          <button
            type="button"
            className="button button-secondary"
            disabled={queueLoading}
            onClick={() => void loadQueue(cursor)}
          >
            {queueLoading ? "Carregando..." : "Carregar mais"}
          </button>
        )}
      </div>
    );
  }

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <h1>Cotações</h1>
          <p className="page-intro">
            Solicitações aprovadas que aguardam cotação. Cada cotação registra o preço de um
            fornecedor ativo para todos os itens da solicitação.
          </p>
        </div>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => void loadQueue(null)}
        >
          Atualizar fila
        </button>
      </div>

      {registered === null ? null : (
        <p className="notice" role="status">
          {`Cotação registrada. Total calculado pelo servidor: ${formatCents(registered.totalCents)} (itens ${formatCents(registered.itemsTotalCents)}, frete ${formatCents(registered.freightCents)}, desconto ${formatCents(registered.discountCents)}). ${registered.itemCount} ${registered.itemCount === 1 ? "item" : "itens"}, válida até ${formatCalendarDate(registered.validUntil)}, entrega em ${registered.deliveryLeadTimeDays} ${registered.deliveryLeadTimeDays === 1 ? "dia" : "dias"}.`}
        </p>
      )}

      {workspaceContent}

      {queueContent}
    </section>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toApiFailure, type ApiFailure } from "@/session/api-error";
import { useSession } from "@/session/session-context";
import { EmptyState, FailureAlert, LoadingRegion } from "@/ui/feedback";
import { listPurchaseRequests } from "./api";
import type { PurchaseRequestSummary } from "./contracts";
import { formatCalendarDate, formatCents, formatTimestamp } from "./formatting";
import { StatusBadge } from "./status-badge";

/**
 * The requester's own list, paginated the way the API paginates: forward, by opaque cursor.
 *
 * There is no page number and no total count, because the API publishes neither. "Carregar
 * mais" appends the next page and stops existing when `nextCursor` is null.
 */
export function RequestList() {
  const { session } = useSession();
  const [items, setItems] = useState<readonly PurchaseRequestSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  const loadPage = useCallback(
    async (after: string | null) => {
      setLoading(true);
      setFailure(null);

      try {
        const page = await listPurchaseRequests(session, { cursor: after });

        setItems((current) =>
          after === null ? page.items : [...current, ...page.items]
        );
        setCursor(page.nextCursor);
        setLoaded(true);
      } catch (error: unknown) {
        setFailure(toApiFailure(error));
      } finally {
        setLoading(false);
      }
    },
    [session]
  );

  useEffect(() => {
    void loadPage(null);
  }, [loadPage]);

  if (failure !== null && items.length === 0) {
    return (
      <FailureAlert failure={failure} onRetry={() => void loadPage(null)} />
    );
  }

  if (!loaded && loading) {
    return <LoadingRegion label="Carregando solicitações..." />;
  }

  if (items.length === 0) {
    return (
      <EmptyState title="Você ainda não tem solicitações de compra.">
        <p>
          Crie a primeira solicitação para registrar o que precisa ser comprado. Ela começa
          como rascunho e só entra em aprovação quando você a envia.
        </p>
        <Link className="button button-primary" href="/requests/new">
          Nova solicitação
        </Link>
      </EmptyState>
    );
  }

  return (
    <div className="list" aria-busy={loading}>
      <div className="table-scroll">
        <table className="data-table">
          <caption className="visually-hidden">
            Suas solicitações de compra, da mais recente para a mais antiga
          </caption>
          <thead>
            <tr>
              <th scope="col">Criada em</th>
              <th scope="col">Situação</th>
              <th scope="col">Total estimado</th>
              <th scope="col">Itens</th>
              <th scope="col">Necessária em</th>
              <th scope="col">
                <span className="visually-hidden">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((request) => (
              <tr key={request.id}>
                <td>{formatTimestamp(request.createdAt)}</td>
                <td>
                  <StatusBadge status={request.status} />
                </td>
                <td className="numeric">{formatCents(request.estimatedTotalCents)}</td>
                <td className="numeric">{request.itemCount}</td>
                <td>{formatCalendarDate(request.neededBy)}</td>
                <td>
                  <Link href={`/requests/${request.id}`}>
                    Abrir
                    <span className="visually-hidden">
                      {` solicitação criada em ${formatTimestamp(request.createdAt)}`}
                    </span>
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {failure === null ? null : (
        <FailureAlert
          failure={failure}
          onRetry={() => void loadPage(cursor)}
          retryLabel="Tentar carregar mais"
        />
      )}

      {cursor === null ? (
        <p className="list-end">Fim da lista.</p>
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
    </div>
  );
}

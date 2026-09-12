"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toApiFailure, type ApiFailure } from "@/session/api-error";
import { useSession } from "@/session/session-context";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { EmptyState, FailureAlert, LoadingRegion } from "@/ui/feedback";
import { deactivateSupplier, listSuppliers, registerSupplier } from "./api";
import type { Supplier, SupplierActiveFilter, SupplierRegistrationInput } from "./contracts";
import { formatTimestamp, taxIdentifierTypeLabel } from "./formatting";
import { RegistrationForm } from "./registration-form";
import { SupplierStatusBadge } from "./supplier-status-badge";

const FILTER_LABELS: Readonly<Record<SupplierActiveFilter, string>> = {
  all: "Todos",
  active: "Ativos",
  inactive: "Inativos"
};

const FILTERS: readonly SupplierActiveFilter[] = ["all", "active", "inactive"];

/**
 * A mutation whose outcome the browser cannot know.
 *
 * A dropped connection, a 5xx and a 429 all leave the question "did it land?" open, and an
 * unrecognized status is no better. Registration and deactivation both have no idempotency
 * key, so none of these may be retried automatically: only a person deciding to try again — or
 * to reload and look first — sends a second request.
 */
function isAmbiguousMutationFailure(failure: ApiFailure): boolean {
  return (
    failure.kind === "network" ||
    failure.kind === "server" ||
    failure.kind === "rate-limited" ||
    failure.kind === "unknown"
  );
}

/**
 * The Buyer/Admin supplier registry: FR-010–FR-013 over the browser.
 *
 * The API is the sole authority on tenant isolation, uniqueness, CNPJ validation and active
 * state. This component only renders what `GET /suppliers` publishes and hands the other two
 * routes exactly the fields they declare.
 */
export function SupplierRegistry() {
  const { session } = useSession();

  const [activeFilter, setActiveFilter] = useState<SupplierActiveFilter>("all");
  const [items, setItems] = useState<readonly Supplier[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [listFailure, setListFailure] = useState<ApiFailure | null>(null);

  const [settled, setSettled] = useState<string | null>(null);

  const [showRegistrationForm, setShowRegistrationForm] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [registrationFailure, setRegistrationFailure] = useState<ApiFailure | null>(null);
  const [registrationAmbiguous, setRegistrationAmbiguous] = useState(false);

  const [deactivateIntent, setDeactivateIntent] = useState<Supplier | null>(null);
  const [deactivating, setDeactivating] = useState(false);
  const [deactivateFailure, setDeactivateFailure] = useState<ApiFailure | null>(null);
  const [deactivateAmbiguous, setDeactivateAmbiguous] = useState(false);

  /**
   * A monotonically increasing generation, one per intended list query.
   *
   * A filter switch or a fresh reload does not cancel the request already in flight — nothing
   * here can abort a `fetch` — so an old query can still resolve after a newer one. Every
   * continuation below checks that its own generation is still the latest before it is allowed
   * to touch `items`, `cursor`, `loading`, `loaded` or `listFailure`: an answer that arrives
   * after the question stopped mattering is discarded instead of applied.
   */
  const listQueryGeneration = useRef(0);

  const loadPage = useCallback(
    async (after: string | null) => {
      const generation = ++listQueryGeneration.current;

      setLoading(true);
      setListFailure(null);

      try {
        const page = await listSuppliers(session, { cursor: after, activeFilter });

        if (listQueryGeneration.current !== generation) {
          // Superseded while in flight: a newer filter or reload already owns the screen.
          return;
        }

        setItems((current) => (after === null ? page.items : [...current, ...page.items]));
        setCursor(page.nextCursor);
        setLoaded(true);
      } catch (error: unknown) {
        if (listQueryGeneration.current !== generation) {
          return;
        }

        setListFailure(toApiFailure(error));
      } finally {
        if (listQueryGeneration.current === generation) {
          setLoading(false);
        }
      }
    },
    // A changed filter is a new identity for this callback, so the effect below re-runs it
    // with `after: null` — a fresh first page rather than pages from two filters mixed
    // together.
    [session, activeFilter]
  );

  useEffect(() => {
    void loadPage(null);
  }, [loadPage]);

  /**
   * `listQueryGeneration` is only advanced when `loadPage` itself starts, and that only
   * happens later, from the effect above, once React has committed the new `activeFilter`.
   * A request for the old filter can resolve in that gap and would still read as current.
   *
   * So a real filter change invalidates the in-flight generation right here, synchronously,
   * in the same event as the click — before `setActiveFilter` is even scheduled. `loadPage`
   * then mints its own newer generation as usual once the effect runs.
   */
  function selectFilter(filter: SupplierActiveFilter): void {
    if (filter === activeFilter) {
      return;
    }

    listQueryGeneration.current += 1;
    setActiveFilter(filter);
  }

  function openRegistrationForm(): void {
    setShowRegistrationForm(true);
    setRegistrationFailure(null);
    setRegistrationAmbiguous(false);
  }

  function closeRegistrationForm(): void {
    setShowRegistrationForm(false);
    setRegistrationFailure(null);
    setRegistrationAmbiguous(false);
  }

  async function submitRegistration(input: SupplierRegistrationInput): Promise<void> {
    setRegistering(true);
    setRegistrationFailure(null);
    setRegistrationAmbiguous(false);

    try {
      const created = await registerSupplier(session, input);

      setShowRegistrationForm(false);
      setSettled(`Fornecedor "${created.tradeName}" cadastrado.`);
      // Conservative: a full first-page reload under the active filter, rather than assuming
      // where the new row lands in the server's own order.
      await loadPage(null);
    } catch (error: unknown) {
      const failure = toApiFailure(error);

      setRegistrationFailure(failure);
      setRegistrationAmbiguous(isAmbiguousMutationFailure(failure));
    } finally {
      setRegistering(false);
    }
  }

  function reloadDuringRegistration(): void {
    setRegistrationFailure(null);
    setRegistrationAmbiguous(false);
    void loadPage(null);
  }

  function openDeactivate(supplier: Supplier): void {
    setDeactivateIntent(supplier);
    setDeactivateFailure(null);
    setDeactivateAmbiguous(false);
  }

  function closeDeactivate(): void {
    setDeactivateIntent(null);
  }

  function reloadFromDeactivateDialog(): void {
    closeDeactivate();
    setDeactivateFailure(null);
    setDeactivateAmbiguous(false);
    void loadPage(null);
  }

  async function confirmDeactivate(): Promise<void> {
    if (deactivateIntent === null) {
      return;
    }

    setDeactivating(true);
    setDeactivateFailure(null);
    setDeactivateAmbiguous(false);

    try {
      const updated = await deactivateSupplier(session, deactivateIntent.id);

      // Immediate, correct-by-construction: never leave an inactive supplier visible under
      // the Active filter while the authoritative reload below is still in flight.
      setItems((current) =>
        activeFilter === "active"
          ? current.filter((item) => item.id !== updated.id)
          : current.map((item) => (item.id === updated.id ? updated : item))
      );
      setSettled(`Fornecedor "${updated.tradeName}" desativado.`);
      closeDeactivate();

      // Authoritative reconciliation: a fresh first page for the filter currently selected,
      // rather than trusting a local patch to still describe the server's own page boundary,
      // order or cursor. `loadPage` reports its own failure through `listFailure`; it never
      // throws, so a failed reload here cannot reclassify the deactivation above, which already
      // succeeded.
      await loadPage(null);
    } catch (error: unknown) {
      const failure = toApiFailure(error);
      const ambiguous = isAmbiguousMutationFailure(failure);

      if (!ambiguous) {
        // Definitive: the dialog's own question is answered, and reopening it starts a new
        // one.
        closeDeactivate();
      }

      setDeactivateFailure(failure);
      setDeactivateAmbiguous(ambiguous);
    } finally {
      setDeactivating(false);
    }
  }

  const deactivateDialog =
    deactivateIntent === null ? null : (
      <ConfirmDialog
        titleId="supplier-deactivate-title"
        title="Desativar este fornecedor?"
        confirmLabel={deactivateAmbiguous ? "Tentar novamente" : "Desativar fornecedor"}
        confirmTone="danger"
        cancelLabel="Voltar"
        busy={deactivating}
        onConfirm={() => void confirmDeactivate()}
        onCancel={closeDeactivate}
      >
        <p>
          O fornecedor continua vinculado às cotações e aos pedidos de compra já registrados,
          mas deixa de poder receber novas cotações.
        </p>
        <dl className="definition-grid">
          <div>
            <dt>Razão social</dt>
            <dd>{deactivateIntent.legalName}</dd>
          </div>
          <div>
            <dt>Nome fantasia</dt>
            <dd>{deactivateIntent.tradeName}</dd>
          </div>
        </dl>
        {deactivateFailure === null ? null : (
          <FailureAlert
            failure={deactivateFailure}
            ambiguous={deactivateAmbiguous}
            onRetry={reloadFromDeactivateDialog}
            retryLabel="Recarregar lista"
          />
        )}
      </ConfirmDialog>
    );

  let listContent: ReactNode;

  if (listFailure !== null && items.length === 0) {
    listContent = <FailureAlert failure={listFailure} onRetry={() => void loadPage(null)} />;
  } else if (!loaded && loading) {
    listContent = <LoadingRegion label="Carregando fornecedores..." />;
  } else if (items.length === 0) {
    listContent = (
      <EmptyState title="Nenhum fornecedor encontrado para este filtro.">
        <p>Cadastre um fornecedor ou escolha outro filtro de situação.</p>
      </EmptyState>
    );
  } else {
    listContent = (
      <div className="list" aria-busy={loading}>
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">
              Fornecedores da organização, da mais recente para a mais antiga
            </caption>
            <thead>
              <tr>
                <th scope="col">Razão social</th>
                <th scope="col">Nome fantasia</th>
                <th scope="col">Identificador fiscal</th>
                <th scope="col">Contato</th>
                <th scope="col">Situação</th>
                <th scope="col">Cadastrado em</th>
                <th scope="col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((supplier) => (
                <tr key={supplier.id}>
                  <td>{supplier.legalName}</td>
                  <td>{supplier.tradeName}</td>
                  <td>
                    {taxIdentifierTypeLabel(supplier.taxIdentifierType)} · {supplier.taxIdentifier}
                  </td>
                  <td>
                    <span className="step-cell">
                      <span>{supplier.contactEmail}</span>
                      <span className="step-cell-state">{supplier.contactPhone}</span>
                    </span>
                  </td>
                  <td>
                    <span className="step-cell">
                      <SupplierStatusBadge isActive={supplier.isActive} />
                      {supplier.isActive ? null : (
                        <span className="step-cell-state">
                          {`desde ${formatTimestamp(supplier.deactivatedAt)}`}
                        </span>
                      )}
                    </span>
                  </td>
                  <td>{formatTimestamp(supplier.createdAt)}</td>
                  <td>
                    {supplier.isActive ? (
                      <button
                        type="button"
                        className="button button-danger"
                        disabled={deactivating}
                        onClick={() => openDeactivate(supplier)}
                      >
                        Desativar
                        <span className="visually-hidden">{` fornecedor ${supplier.tradeName}`}</span>
                      </button>
                    ) : (
                      <span className="step-cell-state">Sem ação disponível.</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {listFailure === null ? null : (
          <FailureAlert
            failure={listFailure}
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

  return (
    <section className="page">
      <div className="page-header">
        <div>
          <h1>Fornecedores</h1>
          <p className="page-intro">
            Cadastro de fornecedores da organização. Um fornecedor desativado permanece
            vinculado ao seu histórico de cotações e pedidos, mas não recebe novas cotações.
          </p>
        </div>
        {showRegistrationForm ? null : (
          <button type="button" className="button button-primary" onClick={openRegistrationForm}>
            Novo fornecedor
          </button>
        )}
      </div>

      {settled === null ? null : (
        <p className="notice" role="status">
          {settled}
        </p>
      )}

      {showRegistrationForm ? (
        <div className="panel">
          <h2>Novo fornecedor</h2>
          <RegistrationForm
            pending={registering}
            failure={registrationFailure}
            ambiguous={registrationAmbiguous}
            onSubmit={(input) => void submitRegistration(input)}
            onCancel={closeRegistrationForm}
          />
          {registrationAmbiguous ? (
            <button type="button" className="button button-secondary" onClick={reloadDuringRegistration}>
              Recarregar lista antes de tentar de novo
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="row-actions" role="group" aria-label="Filtrar por situação">
        {FILTERS.map((filter) => (
          <button
            key={filter}
            type="button"
            className={`button ${activeFilter === filter ? "button-primary" : "button-secondary"}`}
            aria-pressed={activeFilter === filter}
            onClick={() => selectFilter(filter)}
          >
            {FILTER_LABELS[filter]}
          </button>
        ))}
      </div>

      {/* Only shown once the dialog itself has closed: while it is open, the dialog carries
          its own copy of this same failure. */}
      {deactivateFailure === null || deactivateIntent !== null ? null : (
        <FailureAlert
          failure={deactivateFailure}
          onRetry={() => void loadPage(null)}
          retryLabel="Recarregar lista"
        />
      )}

      {listContent}

      {deactivateDialog}
    </section>
  );
}

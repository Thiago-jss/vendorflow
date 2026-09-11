"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toApiFailure, type ApiFailure } from "@/session/api-error";
import { useSession } from "@/session/session-context";
import { FailureAlert, LoadingRegion } from "@/ui/feedback";
import { getPurchaseRequest, replacePurchaseRequestDraft } from "./api";
import type { PurchaseRequest, PurchaseRequestDraftInput } from "./contracts";
import { DraftForm } from "./draft-form";

/**
 * Editing is offered while the API reports the request as a DRAFT owned by the current
 * membership. The `PUT` route decides for real: a request that stopped being a draft answers
 * with a conflict, and that answer is what the user sees.
 */
export function EditRequestScreen({
  purchaseRequestId
}: {
  readonly purchaseRequestId: string;
}) {
  const { session, context } = useSession();
  const router = useRouter();
  const [request, setRequest] = useState<PurchaseRequest | null>(null);
  const [loadFailure, setLoadFailure] = useState<ApiFailure | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);
  const [pending, setPending] = useState(false);

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

  async function save(draft: PurchaseRequestDraftInput): Promise<void> {
    setPending(true);
    setFailure(null);
    setAmbiguous(false);

    try {
      await replacePurchaseRequestDraft(session, purchaseRequestId, draft);

      router.replace(`/requests/${purchaseRequestId}`);
    } catch (error: unknown) {
      const reported = toApiFailure(error);

      setFailure(reported);
      // No durable idempotency on `PUT` either: an ambiguous outcome is reported, never
      // retried automatically.
      setAmbiguous(reported.kind === "network" || reported.kind === "server");
      setPending(false);
    }
  }

  if (loadFailure !== null) {
    return <FailureAlert failure={loadFailure} onRetry={() => void load()} />;
  }

  if (request === null) {
    return <LoadingRegion label="Carregando rascunho..." />;
  }

  const editable =
    request.status === "DRAFT" &&
    context?.membership.userId === request.requesterId;

  if (!editable) {
    return (
      <section className="page">
        <h1>Rascunho indisponível</h1>
        <p>
          Esta solicitação não está mais em rascunho ou não pertence à sua conta, e por isso
          não pode ser editada.
        </p>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => router.push(`/requests/${purchaseRequestId}`)}
        >
          Ver solicitação
        </button>
      </section>
    );
  }

  return (
    <section className="page">
      <h1>Editar rascunho</h1>
      <p className="page-intro">
        A edição substitui a justificativa, a data desejada e a lista de itens. O total
        estimado é recalculado pelo servidor.
      </p>
      <DraftForm
        submitLabel="Salvar alterações"
        pending={pending}
        failure={failure}
        ambiguous={ambiguous}
        initialValue={{
          justification: request.justification,
          neededBy: request.neededBy,
          items: request.items.map((item) => ({
            description: item.description,
            unitOfMeasure: item.unitOfMeasure,
            quantity: item.quantity,
            estimatedUnitPriceCents: item.estimatedUnitPriceCents
          }))
        }}
        onSubmit={(draft) => void save(draft)}
        onCancel={() => router.push(`/requests/${purchaseRequestId}`)}
      />
    </section>
  );
}

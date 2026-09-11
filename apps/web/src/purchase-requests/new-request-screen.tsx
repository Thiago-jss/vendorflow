"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toApiFailure, type ApiFailure } from "@/session/api-error";
import { useSession } from "@/session/session-context";
import { createPurchaseRequestDraft } from "./api";
import type { PurchaseRequestDraftInput } from "./contracts";
import { DraftForm } from "./draft-form";

/**
 * Creation has no idempotency key — REL-004 does not cover it — so a failure whose outcome is
 * unknown is reported as exactly that. The page never resends the command on its own.
 */
export function NewRequestScreen() {
  const { session } = useSession();
  const router = useRouter();
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);
  const [pending, setPending] = useState(false);

  async function create(draft: PurchaseRequestDraftInput): Promise<void> {
    setPending(true);
    setFailure(null);
    setAmbiguous(false);

    try {
      const created = await createPurchaseRequestDraft(session, draft);

      router.replace(`/requests/${created.id}`);
    } catch (error: unknown) {
      const reported = toApiFailure(error);

      setFailure(reported);
      setAmbiguous(reported.kind === "network" || reported.kind === "server");
      setPending(false);
    }
  }

  return (
    <section className="page">
      <h1>Nova solicitação de compra</h1>
      <p className="page-intro">
        A solicitação é criada como rascunho. Você pode revisar e editar antes de enviá-la
        para aprovação.
      </p>
      <DraftForm
        submitLabel="Salvar rascunho"
        pending={pending}
        failure={failure}
        ambiguous={ambiguous}
        onSubmit={(draft) => void create(draft)}
        onCancel={() => router.push("/requests")}
      />
    </section>
  );
}

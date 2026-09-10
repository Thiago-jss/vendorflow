import { formatCents } from "../../../platform/numeric/centavos";
import type { PurchaseRequestStatus } from "../../../procurement/application/support/purchase-request-status";

/**
 * The outgoing fact a quote selection emits (ADR-003, FR-062).
 *
 * It looks like the audit payload next door and it is not the same thing. An audit payload is
 * history and stays inside PostgreSQL; this one is a transport copy that leaves the process,
 * so it is deliberately *narrower*:
 *
 * - **No selection rationale.** FR-044's text is a buyer's written justification for choosing
 *   one supplier over another. It is recorded in the audit trail, where it is tenant-scoped
 *   and access-controlled. It does not go on a queue.
 * - **No supplier name and no fiscal identifier.** A consumer that needs either reads
 *   PostgreSQL under a tenant-scoped query.
 * - **Identifiers, enums and amounts as digit strings** (BR-031).
 *
 * What it does carry is what FR-062 needs to notify: who raised the request, what state it
 * reached, and — when one exists — which responsibility must act next.
 *
 * These are type aliases rather than interfaces on purpose: a type alias of an object literal
 * carries an implicit index signature, so the compiler proves each payload satisfies
 * `OutgoingEventPayload`.
 */
export type PurchaseRequestQuoteSelectedEventPayload = {
  readonly status: PurchaseRequestStatus;
  readonly supplierQuoteId: string;
  readonly supplierId: string;
  readonly selectedTotalCents: string;
  readonly requesterId: string;
  readonly selectedById: string;
  readonly approvalFlowId: string;
  readonly approvalFlowState: string;
  /** FR-062's "next actor": the responsibility now waiting, or null when none remains. */
  readonly actionableStepRole: string | null;
  readonly actionableStepId: string | null;
};

export function purchaseRequestQuoteSelectedEventPayload(input: {
  readonly status: PurchaseRequestStatus;
  readonly supplierQuoteId: string;
  readonly supplierId: string;
  readonly selectedTotalCents: bigint;
  readonly requesterId: string;
  readonly selectedById: string;
  readonly approvalFlowId: string;
  readonly approvalFlowState: string;
  readonly actionableStepRole: string | null;
  readonly actionableStepId: string | null;
}): PurchaseRequestQuoteSelectedEventPayload {
  return {
    status: input.status,
    supplierQuoteId: input.supplierQuoteId,
    supplierId: input.supplierId,
    selectedTotalCents: formatCents(input.selectedTotalCents),
    requesterId: input.requesterId,
    selectedById: input.selectedById,
    approvalFlowId: input.approvalFlowId,
    approvalFlowState: input.approvalFlowState,
    actionableStepRole: input.actionableStepRole,
    actionableStepId: input.actionableStepId,
  };
}

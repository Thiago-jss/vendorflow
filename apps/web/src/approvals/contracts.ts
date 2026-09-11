import type {
  ApprovalStep,
  PurchaseRequestStatus,
  PurchaseRequestSummary
} from "@/purchase-requests/contracts";

/**
 * The Manager approval surface, as the browser reads it.
 *
 * A queue row is exactly what `GET /purchase-requests/awaiting-my-approval` publishes: a
 * request **summary** and the step waiting on the caller. The justification, the item lines
 * and the requester are not in that contract, and there is no route a Manager may use to
 * fetch them — `GET /purchase-requests/{id}` is the requester's own-read. So nothing here
 * declares them, and the screen cannot accidentally show them.
 */
export interface ApprovalQueueItem {
  readonly request: PurchaseRequestSummary;
  readonly pendingStep: ApprovalStep;
}

export interface ApprovalQueuePage {
  readonly items: readonly ApprovalQueueItem[];
  /** Opaque keyset cursor. Null on the last page, and there is no total count. */
  readonly nextCursor: string | null;
}

export type ApprovalDecision = "APPROVED" | "REJECTED";

/**
 * The whole decision body, which is a closed world of two fields (`ApprovalDecisionDto`).
 *
 * There is no step identifier, no actor, no amount, no tenant and no target status: the step
 * is the one the flow is waiting on, the actor is the authenticated principal, and the
 * resulting state is the policy's. The API runs `forbidNonWhitelisted`, so sending any of
 * them is a 400 rather than a value it must remember to ignore.
 */
export interface ApprovalDecisionInput {
  readonly decision: ApprovalDecision;
  readonly reason?: string;
}

/**
 * What the inbox reads back from a decision.
 *
 * The route answers with the full purchase request, but a Manager's screen has no business
 * rendering another employee's justification or item lines, and this slice publishes no
 * department-scoped detail read. The type is narrowed on purpose: reconciling the queue needs
 * the identifier and the resulting status, and nothing else is reachable from here.
 */
export interface ApprovalDecisionOutcome {
  readonly id: string;
  readonly status: PurchaseRequestStatus;
}

import type { BrowserSession } from "@/session/browser-session";
import type {
  PurchaseRequest,
  PurchaseRequestDraftInput,
  PurchaseRequestPage
} from "./contracts";

/**
 * The six endpoints this slice consumes, spelled once.
 *
 * Nothing here adds a field the DTO does not declare: the API refuses an unknown property
 * rather than ignoring it, and status, totals, positions, tenant and requester are all
 * derived server-side.
 */
const RESOURCE = "/purchase-requests";

export function listPurchaseRequests(
  session: BrowserSession,
  options: { readonly cursor?: string | null; readonly limit?: number } = {}
): Promise<PurchaseRequestPage> {
  const query = new URLSearchParams();

  if (options.limit !== undefined) {
    query.set("limit", String(options.limit));
  }

  // Taken verbatim from a previous response. The browser never builds or interprets one.
  if (options.cursor !== undefined && options.cursor !== null) {
    query.set("cursor", options.cursor);
  }

  const suffix = query.size === 0 ? "" : `?${query.toString()}`;

  return session.request<PurchaseRequestPage>({ path: `${RESOURCE}${suffix}` });
}

export function getPurchaseRequest(
  session: BrowserSession,
  purchaseRequestId: string
): Promise<PurchaseRequest> {
  return session.request<PurchaseRequest>({
    path: `${RESOURCE}/${purchaseRequestId}`
  });
}

export function createPurchaseRequestDraft(
  session: BrowserSession,
  draft: PurchaseRequestDraftInput
): Promise<PurchaseRequest> {
  return session.request<PurchaseRequest>({
    path: RESOURCE,
    method: "POST",
    body: draft
  });
}

export function replacePurchaseRequestDraft(
  session: BrowserSession,
  purchaseRequestId: string,
  draft: PurchaseRequestDraftInput
): Promise<PurchaseRequest> {
  return session.request<PurchaseRequest>({
    path: `${RESOURCE}/${purchaseRequestId}`,
    method: "PUT",
    body: draft
  });
}

/** The one operation in this slice with durable idempotency (REL-004). */
export function submitPurchaseRequest(
  session: BrowserSession,
  purchaseRequestId: string,
  idempotencyKey: string
): Promise<PurchaseRequest> {
  return session.request<PurchaseRequest>({
    path: `${RESOURCE}/${purchaseRequestId}/submit`,
    method: "POST",
    idempotencyKey
  });
}

export function cancelPurchaseRequest(
  session: BrowserSession,
  purchaseRequestId: string
): Promise<PurchaseRequest> {
  return session.request<PurchaseRequest>({
    path: `${RESOURCE}/${purchaseRequestId}/cancel`,
    method: "POST"
  });
}

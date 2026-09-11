import { ApiRequestError, failureOfKind } from "@/session/api-error";
import type { BrowserSession } from "@/session/browser-session";
import type {
  ApprovalDecisionInput,
  ApprovalDecisionOutcome,
  ApprovalQueuePage
} from "./contracts";

/**
 * The two endpoints the Manager inbox consumes, spelled once.
 *
 * Both sit on the `/purchase-requests` surface. The queue's literal segment is declared
 * before `:purchaseRequestId` server-side, which is what keeps it a route rather than an
 * identifier — and the reason the identifier below is checked before it is interpolated.
 */
const RESOURCE = "/purchase-requests";
const APPROVAL_QUEUE_PATH = `${RESOURCE}/awaiting-my-approval`;

/** The route's own contract: `ParseUUIDPipe({ version: "4" })`. */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * An identifier is untrusted route input even when the API is where it came from.
 *
 * Anything that is not a version 4 UUID is refused here rather than pasted into a path,
 * so no response value can make the browser address a different literal endpoint. The API
 * would answer 400 for the same input; refusing locally means the attempt never leaves.
 */
function requestPathSegment(purchaseRequestId: string): string {
  if (!UUID_V4.test(purchaseRequestId)) {
    throw new ApiRequestError(failureOfKind("invalid-request"));
  }

  return purchaseRequestId;
}

/**
 * FR-030. The caller's own department-scoped Manager queue.
 *
 * Organization and department come from the persisted principal, so no query parameter here
 * can widen either. The cursor is taken verbatim from a previous response: the browser never
 * builds or interprets one, and there is no page number to invent.
 */
export function listApprovalQueue(
  session: BrowserSession,
  options: { readonly cursor?: string | null; readonly limit?: number } = {}
): Promise<ApprovalQueuePage> {
  const query = new URLSearchParams();

  if (options.limit !== undefined) {
    query.set("limit", String(options.limit));
  }

  if (options.cursor !== undefined && options.cursor !== null) {
    query.set("cursor", options.cursor);
  }

  const suffix = query.size === 0 ? "" : `?${query.toString()}`;

  return session.request<ApprovalQueuePage>({
    path: `${APPROVAL_QUEUE_PATH}${suffix}`
  });
}

/**
 * FR-031 and REL-004. Decides the step the flow is waiting on.
 *
 * The body is rebuilt field by field rather than forwarded, so only `decision` and a
 * non-empty `reason` can ever travel. An absent reason is omitted entirely: the API refuses
 * a blank approval reason rather than treating it as absent.
 */
export async function decideApproval(
  session: BrowserSession,
  purchaseRequestId: string,
  input: ApprovalDecisionInput,
  idempotencyKey: string
): Promise<ApprovalDecisionOutcome> {
  return session.request<ApprovalDecisionOutcome>({
    path: `${RESOURCE}/${requestPathSegment(purchaseRequestId)}/approval-decision`,
    method: "POST",
    body:
      input.reason === undefined
        ? { decision: input.decision }
        : { decision: input.decision, reason: input.reason },
    idempotencyKey
  });
}

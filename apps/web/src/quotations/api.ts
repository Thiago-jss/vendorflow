import { ApiRequestError, failureOfKind } from "@/session/api-error";
import type { BrowserSession } from "@/session/browser-session";
import { listSuppliers } from "@/suppliers/api";
import type { SupplierPage } from "@/suppliers/contracts";
import type {
  QuotationQueuePage,
  QuotationWork,
  QuoteRegistrationInput,
  RegisteredQuote
} from "./contracts";

/**
 * The endpoints the Buyer quotation workflow consumes, spelled once.
 *
 * `GET /purchase-requests/{id}` is deliberately absent: it is the requester's own read, and a
 * Buyer reads a request only through the narrow quotation-work route below. The organization
 * is derived from the access token server-side, so nothing here builds or sends a tenant.
 */
const RESOURCE = "/purchase-requests";
const QUOTATION_QUEUE_PATH = `${RESOURCE}/awaiting-quotation`;

/** Enough active suppliers to choose from in one read; the API's own page ceiling. */
const SUPPLIER_CHOICE_PAGE_SIZE = 100;

/** The routes' own contract: `ParseUUIDPipe({ version: "4" })`. */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * An identifier is untrusted route input even when the API is where it came from.
 *
 * Anything that is not a version 4 UUID is refused here rather than pasted into a path, so no
 * response value can make the browser address a different literal endpoint.
 */
function requestPathSegment(purchaseRequestId: string): string {
  if (!UUID_V4.test(purchaseRequestId)) {
    throw new ApiRequestError(failureOfKind("invalid-request"));
  }

  return purchaseRequestId;
}

/**
 * FR-040. The organization's quotation queue. The cursor is taken verbatim from a previous
 * response: the browser never builds or interprets one.
 */
export function listQuotationQueue(
  session: BrowserSession,
  options: { readonly cursor?: string | null; readonly limit?: number } = {}
): Promise<QuotationQueuePage> {
  const query = new URLSearchParams();

  if (options.limit !== undefined) {
    query.set("limit", String(options.limit));
  }

  if (options.cursor !== undefined && options.cursor !== null) {
    query.set("cursor", options.cursor);
  }

  const suffix = query.size === 0 ? "" : `?${query.toString()}`;

  return session.request<QuotationQueuePage>({
    path: `${QUOTATION_QUEUE_PATH}${suffix}`
  });
}

/**
 * FR-040/FR-041. The item lines a quote must price. Reading it proves nothing about whether a
 * quote may be registered: registration checks the request's state again on its own.
 */
export async function getQuotationWork(
  session: BrowserSession,
  purchaseRequestId: string
): Promise<QuotationWork> {
  return session.request<QuotationWork>({
    path: `${QUOTATION_QUEUE_PATH}/${requestPathSegment(purchaseRequestId)}`
  });
}

/**
 * The supplier registry's own list client, pinned to active suppliers. There is no second
 * wrapper around `GET /suppliers`; this only fixes the filter a quote needs.
 */
export function listActiveSuppliers(
  session: BrowserSession,
  cursor: string | null = null
): Promise<SupplierPage> {
  return listSuppliers(session, {
    cursor,
    limit: SUPPLIER_CHOICE_PAGE_SIZE,
    activeFilter: "active"
  });
}

/**
 * FR-041. The body is rebuilt field by field, and each line from its two fields, so nothing a
 * caller's draft object carries — a quantity, a total, a status, a tenant — can ever travel.
 *
 * No idempotency key: the route does not accept one. The browser never retries this on its own.
 */
export async function registerQuote(
  session: BrowserSession,
  purchaseRequestId: string,
  input: QuoteRegistrationInput
): Promise<RegisteredQuote> {
  return session.request<RegisteredQuote>({
    path: `${RESOURCE}/${requestPathSegment(purchaseRequestId)}/quotes`,
    method: "POST",
    body: {
      supplierId: input.supplierId,
      freightCents: input.freightCents,
      discountCents: input.discountCents,
      validUntil: input.validUntil,
      deliveryLeadTimeDays: input.deliveryLeadTimeDays,
      lines: input.lines.map((line) => ({
        purchaseRequestItemId: line.purchaseRequestItemId,
        unitPriceCents: line.unitPriceCents
      }))
    }
  });
}

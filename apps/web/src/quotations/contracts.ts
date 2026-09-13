/**
 * The Buyer quotation surface, as the browser reads and writes it.
 *
 * Every type here is declared for this workflow alone, even where a field name matches the
 * requester's own purchase-request contract. `GET /purchase-requests/{id}` is the requester's
 * read, and nothing a Buyer screen consumes is shaped like it: the justification, the
 * requester, the department, the approval history and every estimate are absent from the
 * routes below, so they are absent from these types and no screen can render them by accident.
 *
 * Amounts and quantities stay strings exactly as the API sends them. The browser never
 * converts, sums or rounds one.
 */

/**
 * One row of `GET /purchase-requests/awaiting-quotation`.
 *
 * The wire row also carries `estimatedTotalCents` and a few lifecycle timestamps. They are not
 * declared because the queue does not show them: an estimate is the requester's number, not a
 * price a Buyer should anchor a supplier quote to.
 */
export interface QuotationQueueRow {
  readonly id: string;
  readonly neededBy: string;
  readonly itemCount: number;
  readonly submittedAt: string | null;
}

export interface QuotationQueuePage {
  readonly items: readonly QuotationQueueRow[];
  /** Opaque keyset cursor. Null on the last page, and there is no total count. */
  readonly nextCursor: string | null;
}

/** One persisted request line, as `GET /purchase-requests/awaiting-quotation/{id}` publishes it. */
export interface QuotationWorkItem {
  /** Operational: the `purchaseRequestItemId` a quote line refers to. Not business content. */
  readonly id: string;
  readonly position: number;
  readonly description: string;
  readonly unitOfMeasure: string;
  /** Exact decimal text. Shown, never sent back: the API reads the persisted quantity. */
  readonly quantity: string;
}

/** The whole Slice 4A quotation-work read. There is nothing else to declare. */
export interface QuotationWork {
  readonly id: string;
  readonly neededBy: string;
  readonly items: readonly QuotationWorkItem[];
}

export interface QuoteRegistrationLineInput {
  readonly purchaseRequestItemId: string;
  /** Integer centavos as canonical text. */
  readonly unitPriceCents: string;
}

/**
 * The closed world `RegisterSupplierQuoteDto` declares.
 *
 * There is no quantity, no line total, no goods total, no quote total, no status and no
 * tenant: the API reads quantities from the persisted request, computes every total itself and
 * derives the organization from the access token. It runs `forbidNonWhitelisted`, so any of
 * those would be a 400 rather than a value it quietly ignores.
 */
export interface QuoteRegistrationInput {
  readonly supplierId: string;
  readonly freightCents: string;
  readonly discountCents: string;
  /** A calendar day, `YYYY-MM-DD`. */
  readonly validUntil: string;
  readonly deliveryLeadTimeDays: number;
  readonly lines: readonly QuoteRegistrationLineInput[];
}

/**
 * What the confirmation reads back from `POST /purchase-requests/{id}/quotes`.
 *
 * The route answers with the full quote. The screen renders only the server-computed totals
 * and the terms the Buyer just entered, so only those are declared.
 */
export interface RegisteredQuote {
  readonly id: string;
  readonly itemsTotalCents: string;
  readonly freightCents: string;
  readonly discountCents: string;
  readonly totalCents: string;
  readonly itemCount: number;
  readonly validUntil: string;
  readonly deliveryLeadTimeDays: number;
}

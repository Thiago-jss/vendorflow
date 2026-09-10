import type { ScaledQuantity } from "../../../platform/numeric/scaled-quantity";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";

export const SUPPLIER_QUOTE_REPOSITORY = Symbol("SUPPLIER_QUOTE_REPOSITORY");

/** BR-022/BR-024. `ACTIVE` is a live offer, `WITHDRAWN` is history, `SELECTED` is the winner. */
export const supplierQuoteStatuses = [
  "ACTIVE",
  "WITHDRAWN",
  "SELECTED",
] as const;

export type SupplierQuoteStatus = (typeof supplierQuoteStatuses)[number];

export interface SupplierQuoteItemRecord {
  readonly id: string;
  readonly purchaseRequestItemId: string;
  readonly position: number;
  /** Thousandths of a unit, copied from the request line. Exact, never a binary float. */
  readonly quantityScaled: ScaledQuantity;
  readonly unitPriceCents: bigint;
  /** BR-033: already rounded half-up, once, at the line. */
  readonly lineTotalCents: bigint;
}

export interface SupplierQuoteRecord {
  readonly id: string;
  readonly purchaseRequestId: string;
  readonly supplierId: string;
  readonly status: SupplierQuoteStatus;
  readonly freightCents: bigint;
  readonly discountCents: bigint;
  readonly itemsTotalCents: bigint;
  readonly totalCents: bigint;
  readonly itemCount: number;
  readonly validUntil: Date;
  readonly deliveryLeadTimeDays: number;
  readonly registeredById: string;
  readonly selectionRationale: string | null;
  readonly selectedById: string | null;
  readonly selectedAt: Date | null;
  readonly withdrawnAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly items: readonly SupplierQuoteItemRecord[];
}

export interface TenantQuoteCriteria {
  readonly organizationId: string;
  readonly purchaseRequestId: string;
  readonly supplierQuoteId: string;
}

export interface TenantRequestQuoteCriteria {
  readonly organizationId: string;
  readonly purchaseRequestId: string;
}

/**
 * FR-043 and NFR-004. Keyset position in the comparison, which is ordered by total ascending
 * and then by quote identifier ascending.
 *
 * Both halves are part of the key on purpose. `total_cents` alone is not unique — two
 * suppliers quoting the same amount is the ordinary case a comparison exists to resolve — and
 * a cursor carrying only the total would either skip the rest of a tied group or replay it.
 * The identifier breaks the tie with a value that is unique by construction, so the pair is a
 * total order and every row appears on exactly one page.
 */
export interface SupplierQuoteListCursor {
  readonly totalCents: bigint;
  readonly id: string;
}

export interface ListSupplierQuotesCriteria extends TenantRequestQuoteCriteria {
  readonly limit: number;
  readonly after: SupplierQuoteListCursor | null;
}

export interface SupplierQuotePage {
  readonly items: readonly SupplierQuoteRecord[];
  readonly nextCursor: SupplierQuoteListCursor | null;
}

export interface RegisterSupplierQuoteLine {
  readonly purchaseRequestItemId: string;
  readonly position: number;
  readonly quantityScaled: ScaledQuantity;
  readonly unitPriceCents: bigint;
  readonly lineTotalCents: bigint;
}

export interface RegisterSupplierQuoteInput
  extends TenantRequestQuoteCriteria {
  readonly supplierId: string;
  readonly registeredById: string;
  readonly freightCents: bigint;
  readonly discountCents: bigint;
  readonly itemsTotalCents: bigint;
  readonly totalCents: bigint;
  readonly validUntil: Date;
  readonly deliveryLeadTimeDays: number;
  readonly lines: readonly RegisterSupplierQuoteLine[];
}

export interface WithdrawSupplierQuoteInput extends TenantQuoteCriteria {
  readonly withdrawnAt: Date;
}

export interface SelectSupplierQuoteInput extends TenantQuoteCriteria {
  readonly selectedById: string;
  readonly selectedAt: Date;
  readonly selectionRationale: string;
  /** BR-023, restated inside the write: validity is a predicate, not only a pre-check. */
  readonly validOnOrAfter: Date;
}

/**
 * Persistence for the SupplierQuote aggregate.
 *
 * Every method is scoped by construction (ADR-002): there is no read by quote identifier alone
 * and no optional `organizationId`. Every single-quote method additionally carries the
 * `purchaseRequestId` in its predicate — not for convenience, but because a quote identifier
 * from another request in the same tenant must answer exactly as an unknown one does.
 *
 * The mutating methods return `null` when their conditional write matched no row. That is the
 * concurrency authority: state and validity are re-checked *inside* the UPDATE, never before
 * it. `register` raises `SupplierQuoteAlreadyActiveError` rather than a driver error when
 * BR-022's partial unique index refuses a second live offer, and `select` raises
 * `SupplierQuoteConcurrentlyModifiedError` when BR-024's refuses a second winner — both are
 * expected business conflicts, and a race that a pre-check missed answers the way the
 * pre-check would have.
 *
 * Every write takes a `TransactionScope`. A quote registered outside the transaction that
 * proved its request is still in quotation is precisely the race BR-020 forbids, and there is
 * deliberately no overload that permits it.
 */
export interface SupplierQuoteRepository {
  register(
    scope: TransactionScope,
    input: RegisterSupplierQuoteInput,
  ): Promise<SupplierQuoteRecord>;

  /**
   * FR-043. One bounded page of a request's quotes, ordered by total ascending and then by
   * identifier ascending.
   *
   * Withdrawn quotes are part of the page like any other (FR-046). There is no status filter
   * here and no cap on how many quotes a request may have: NFR-004 is answered by bounding
   * the *page*, never by bounding the business.
   */
  listForRequest(
    criteria: ListSupplierQuotesCriteria,
  ): Promise<SupplierQuotePage>;

  find(criteria: TenantQuoteCriteria): Promise<SupplierQuoteRecord | null>;

  /** The same read inside a transaction, so a decision cannot be made on a stale row. */
  findInTransaction(
    scope: TransactionScope,
    criteria: TenantQuoteCriteria,
  ): Promise<SupplierQuoteRecord | null>;

  /** FR-051's source: the selected quote of a request, with its priced lines. */
  findSelectedForRequest(
    scope: TransactionScope,
    criteria: TenantRequestQuoteCriteria,
  ): Promise<SupplierQuoteRecord | null>;

  withdraw(
    scope: TransactionScope,
    input: WithdrawSupplierQuoteInput,
  ): Promise<SupplierQuoteRecord | null>;

  select(
    scope: TransactionScope,
    input: SelectSupplierQuoteInput,
  ): Promise<SupplierQuoteRecord | null>;
}

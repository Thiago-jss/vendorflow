import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import type { PurchaseRequestStatus } from "../support/purchase-request-status";
import type { NormalizedPurchaseRequestDraftItem } from "../support/purchase-request-draft";
import type { ScaledQuantity } from "../support/decimal-quantity";

export const PURCHASE_REQUEST_REPOSITORY = Symbol(
  "PURCHASE_REQUEST_REPOSITORY",
);

export interface PurchaseRequestItemRecord {
  readonly id: string;
  readonly position: number;
  readonly description: string;
  readonly unitOfMeasure: string;
  /** Thousandths of a unit; exact, never a binary float. See `decimal-quantity.ts`. */
  readonly quantityScaled: ScaledQuantity;
  readonly estimatedUnitPriceCents: bigint;
  /** BR-033: already rounded half-up, once, at the line. */
  readonly estimatedLineTotalCents: bigint;
}

export interface PurchaseRequestRecord {
  readonly id: string;
  readonly status: PurchaseRequestStatus;
  readonly requesterId: string;
  readonly departmentId: string;
  readonly justification: string;
  readonly neededBy: Date;
  readonly estimatedTotalCents: bigint;
  readonly submittedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly items: readonly PurchaseRequestItemRecord[];
}

/** What a list row needs. Items and justification stay out of a collection response. */
export interface PurchaseRequestSummaryRecord {
  readonly id: string;
  readonly status: PurchaseRequestStatus;
  readonly neededBy: Date;
  readonly estimatedTotalCents: bigint;
  readonly itemCount: number;
  readonly submittedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Every criterion a requester-owned operation needs, and no optional tenant. */
export interface OwnPurchaseRequestCriteria {
  readonly organizationId: string;
  readonly requesterId: string;
  readonly purchaseRequestId: string;
}

/**
 * AUTHZ-004. The criteria of an operation authorized by *responsibility* rather than by
 * ownership: a Manager acts on the requests of one Department, and the Department is in the
 * predicate for the same reason `requesterId` is in the one above — a request outside the
 * boundary is never loaded, so nothing about it can leak.
 *
 * The department is the request's own persisted `department_id` (BR-042), not a join through
 * the requester's current profile: moving a person between departments must not move the
 * requests they already raised into another manager's queue.
 */
export interface DepartmentPurchaseRequestCriteria {
  readonly organizationId: string;
  readonly departmentId: string;
  readonly purchaseRequestId: string;
}

export interface ListDepartmentPurchaseRequestsCriteria {
  readonly organizationId: string;
  readonly departmentId: string;
  readonly statuses: readonly PurchaseRequestStatus[];
  /**
   * BR-005 in the predicate. A decision maker's queue leaves out the requests they raised
   * themselves, because they may never decide those — excluded here rather than after the
   * page is assembled, so paging stays honest.
   */
  readonly excludingRequesterId: string | null;
  readonly limit: number;
  readonly after: PurchaseRequestListCursor | null;
}

export interface CreatePurchaseRequestDraftInput {
  readonly organizationId: string;
  readonly requesterId: string;
  readonly departmentId: string;
  readonly justification: string;
  readonly neededBy: Date;
  readonly estimatedTotalCents: bigint;
  readonly items: readonly NormalizedPurchaseRequestDraftItem[];
}

export interface ReplacePurchaseRequestDraftInput
  extends OwnPurchaseRequestCriteria {
  readonly justification: string;
  readonly neededBy: Date;
  readonly estimatedTotalCents: bigint;
  readonly items: readonly NormalizedPurchaseRequestDraftItem[];
}

export interface SubmitPurchaseRequestInput extends OwnPurchaseRequestCriteria {
  readonly submittedAt: Date;
  /** The states the domain currently allows a submission from (BR-011). */
  readonly submittableStatuses: readonly PurchaseRequestStatus[];
}

export interface CancelPurchaseRequestInput extends OwnPurchaseRequestCriteria {
  readonly cancelledAt: Date;
  /** The states the domain currently allows a cancellation from (BR-011, BR-013). */
  readonly cancellableStatuses: readonly PurchaseRequestStatus[];
}

/**
 * FR-032. The request half of an approval decision. There is no `requesterId`: the actor is
 * not the owner, and the department is what bounds them instead. The permitted source states
 * travel with the command so they end up in the WHERE clause of the write.
 */
export interface ApplyApprovalDecisionInput
  extends DepartmentPurchaseRequestCriteria {
  readonly fromStatuses: readonly PurchaseRequestStatus[];
  readonly toStatus: PurchaseRequestStatus;
}

/** Keyset position in the requester's own list, ordered newest first. */
export interface PurchaseRequestListCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface ListOwnPurchaseRequestsCriteria {
  readonly organizationId: string;
  readonly requesterId: string;
  readonly limit: number;
  readonly after: PurchaseRequestListCursor | null;
}

export interface PurchaseRequestPage {
  readonly items: readonly PurchaseRequestSummaryRecord[];
  readonly nextCursor: PurchaseRequestListCursor | null;
}

/**
 * Persistence for the purchase request aggregate.
 *
 * Every method is scoped by construction (ADR-002): there is no read by identifier alone
 * and no optional `organizationId`, so a caller cannot express an unscoped query even by
 * mistake. The requester-owned operations additionally carry `requesterId` in the predicate
 * rather than checking ownership after loading a row — a foreign request is never read, so
 * it can never be leaked through timing, an error shape or a log line.
 *
 * The mutating methods return `null` when their conditional write matched no row. That is
 * how a concurrent transition is detected: the state was re-checked inside the write, not
 * before it.
 *
 * The transitions that must commit together with an approval flow and an audit event take a
 * `TransactionScope` rather than opening their own transaction (ADR-001 rule 4, AUD-004).
 */
export interface PurchaseRequestRepository {
  createDraft(
    input: CreatePurchaseRequestDraftInput,
  ): Promise<PurchaseRequestRecord>;

  findOwnRequest(
    criteria: OwnPurchaseRequestCriteria,
  ): Promise<PurchaseRequestRecord | null>;

  /** AUTHZ-004. The same read, bounded by department instead of by ownership. */
  findDepartmentRequest(
    criteria: DepartmentPurchaseRequestCriteria,
  ): Promise<PurchaseRequestRecord | null>;

  listOwnRequests(
    criteria: ListOwnPurchaseRequestsCriteria,
  ): Promise<PurchaseRequestPage>;

  /** FR-030. One department's requests in the given states, newest first. */
  listDepartmentRequests(
    criteria: ListDepartmentPurchaseRequestsCriteria,
  ): Promise<PurchaseRequestPage>;

  replaceOwnDraft(
    input: ReplacePurchaseRequestDraftInput,
  ): Promise<PurchaseRequestRecord | null>;

  submitOwnRequest(
    scope: TransactionScope,
    input: SubmitPurchaseRequestInput,
  ): Promise<PurchaseRequestRecord | null>;

  cancelOwnRequest(
    scope: TransactionScope,
    input: CancelPurchaseRequestInput,
  ): Promise<PurchaseRequestRecord | null>;

  applyApprovalDecision(
    scope: TransactionScope,
    input: ApplyApprovalDecisionInput,
  ): Promise<PurchaseRequestRecord | null>;

  /** FR-022. Returns false when no DRAFT row of this requester matched. */
  deleteOwnDraft(criteria: OwnPurchaseRequestCriteria): Promise<boolean>;
}

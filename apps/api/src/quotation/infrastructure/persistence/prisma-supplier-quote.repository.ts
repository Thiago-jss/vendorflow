import { Injectable } from "@nestjs/common";
import { DatabaseService, Prisma } from "@vendorflow/database";
import { transactionClient } from "../../../platform/persistence/prisma-transaction-runner";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import {
  toDecimalQuantity,
  toScaledQuantity,
} from "../../../platform/persistence/scaled-quantity.mapper";
import {
  SupplierQuoteAlreadyActiveError,
  SupplierQuoteConcurrentlyModifiedError,
} from "../../application/contracts/quotation.errors";
import {
  supplierQuoteStatuses,
  type ListSupplierQuotesCriteria,
  type RegisterSupplierQuoteInput,
  type SelectSupplierQuoteInput,
  type SupplierQuotePage,
  type SupplierQuoteRecord,
  type SupplierQuoteRepository,
  type SupplierQuoteStatus,
  type TenantQuoteCriteria,
  type TenantRequestQuoteCriteria,
  type WithdrawSupplierQuoteInput,
} from "../../application/contracts/supplier-quote.repository";

/** Prisma's code for a unique-constraint violation. */
const UNIQUE_VIOLATION = "P2002";

const QUOTE_SELECTION = {
  id: true,
  purchaseRequestId: true,
  supplierId: true,
  status: true,
  freightCents: true,
  discountCents: true,
  itemsTotalCents: true,
  totalCents: true,
  itemCount: true,
  validUntil: true,
  deliveryLeadTimeDays: true,
  registeredById: true,
  selectionRationale: true,
  selectedById: true,
  selectedAt: true,
  withdrawnAt: true,
  createdAt: true,
  updatedAt: true,
  items: {
    orderBy: { position: "asc" },
    select: {
      id: true,
      purchaseRequestItemId: true,
      position: true,
      quantity: true,
      unitPriceCents: true,
      lineTotalCents: true,
    },
  },
} satisfies Prisma.SupplierQuoteSelect;

type SupplierQuoteRow = Prisma.SupplierQuoteGetPayload<{
  select: typeof QUOTE_SELECTION;
}>;

@Injectable()
export class PrismaSupplierQuoteRepository implements SupplierQuoteRepository {
  constructor(private readonly database: DatabaseService) {}

  async register(
    scope: TransactionScope,
    input: RegisterSupplierQuoteInput,
  ): Promise<SupplierQuoteRecord> {
    const transaction = transactionClient(scope);

    try {
      const created = await transaction.supplierQuote.create({
        data: {
          organizationId: input.organizationId,
          purchaseRequestId: input.purchaseRequestId,
          supplierId: input.supplierId,
          registeredById: input.registeredById,
          freightCents: input.freightCents,
          discountCents: input.discountCents,
          itemsTotalCents: input.itemsTotalCents,
          totalCents: input.totalCents,
          // BR-021's declared coverage. The deferred constraint trigger compares it, at
          // COMMIT, against both this quote's lines and the request's items — so a partial
          // quote cannot commit however it was assembled.
          itemCount: input.lines.length,
          validUntil: input.validUntil,
          deliveryLeadTimeDays: input.deliveryLeadTimeDays,
        },
        select: { id: true },
      });

      // Written as a separate statement rather than a nested create because every scalar on a
      // quote line participates in one of its three composite foreign keys, and only the
      // explicit form can state them all. It is still the same transaction, and BR-021's
      // coverage trigger is deferred to COMMIT, so the order of the two statements is
      // immaterial to the invariant.
      await transaction.supplierQuoteItem.createMany({
        data: input.lines.map((line) => ({
          organizationId: input.organizationId,
          supplierQuoteId: created.id,
          // Denormalized so the composite foreign key can prove that this line's request item
          // belongs to the same request as its quote.
          purchaseRequestId: input.purchaseRequestId,
          purchaseRequestItemId: line.purchaseRequestItemId,
          position: line.position,
          quantity: toDecimalQuantity(line.quantityScaled),
          unitPriceCents: line.unitPriceCents,
          lineTotalCents: line.lineTotalCents,
        })),
      });

      const quote = await transaction.supplierQuote.findUniqueOrThrow({
        where: {
          organizationId_id: {
            organizationId: input.organizationId,
            id: created.id,
          },
        },
        select: QUOTE_SELECTION,
      });

      return toRecord(quote);
    } catch (error: unknown) {
      // BR-022, decided by the partial unique index. Translated into the business error a
      // pre-check would have produced, so a race answers exactly as a sequential duplicate
      // does and no driver detail reaches the caller (ADR-002).
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_VIOLATION
      ) {
        throw new SupplierQuoteAlreadyActiveError();
      }

      throw error;
    }
  }

  async listForRequest(
    criteria: ListSupplierQuotesCriteria,
  ): Promise<SupplierQuotePage> {
    const after = criteria.after;
    // FR-043 and NFR-004. Keyset, not offset: `(total_cents ASC, id ASC)` is a total order
    // led by the index that exists for exactly this comparison, so a page cannot shift or
    // repeat when a quote is registered mid-read. The second comparison is what makes ties
    // safe — two suppliers at the same total are the ordinary case, and a predicate on the
    // total alone would either skip the rest of the tied group or serve it twice.
    const rows = await this.database.supplierQuote.findMany({
      where: {
        organizationId: criteria.organizationId,
        purchaseRequestId: criteria.purchaseRequestId,
        ...(after === null
          ? {}
          : {
              OR: [
                { totalCents: { gt: after.totalCents } },
                { totalCents: after.totalCents, id: { gt: after.id } },
              ],
            }),
      },
      orderBy: [{ totalCents: "asc" }, { id: "asc" }],
      // One row beyond the page, so "is there a next page" is answered by the same read
      // rather than by a second count over an unbounded collection.
      take: criteria.limit + 1,
      select: QUOTE_SELECTION,
    });
    const page = rows.slice(0, criteria.limit).map((quote) => toRecord(quote));
    const last = page.at(-1);

    return {
      items: page,
      nextCursor:
        rows.length > criteria.limit && last !== undefined
          ? { totalCents: last.totalCents, id: last.id }
          : null,
    };
  }

  async find(
    criteria: TenantQuoteCriteria,
  ): Promise<SupplierQuoteRecord | null> {
    return this.findWith(this.database, criteria);
  }

  async findInTransaction(
    scope: TransactionScope,
    criteria: TenantQuoteCriteria,
  ): Promise<SupplierQuoteRecord | null> {
    return this.findWith(transactionClient(scope), criteria);
  }

  async findSelectedForRequest(
    scope: TransactionScope,
    criteria: TenantRequestQuoteCriteria,
  ): Promise<SupplierQuoteRecord | null> {
    const quote = await transactionClient(scope).supplierQuote.findFirst({
      where: {
        organizationId: criteria.organizationId,
        purchaseRequestId: criteria.purchaseRequestId,
        status: "SELECTED",
      },
      select: QUOTE_SELECTION,
    });

    return quote === null ? null : toRecord(quote);
  }

  async withdraw(
    scope: TransactionScope,
    input: WithdrawSupplierQuoteInput,
  ): Promise<SupplierQuoteRecord | null> {
    const transaction = transactionClient(scope);
    // BR-024 in the other direction: `status = ACTIVE` is in the WHERE clause, so a withdrawal
    // racing a selection matches no row rather than un-selecting a winner.
    const withdrawn = await transaction.supplierQuote.updateMany({
      where: {
        id: input.supplierQuoteId,
        organizationId: input.organizationId,
        purchaseRequestId: input.purchaseRequestId,
        status: "ACTIVE",
      },
      data: { status: "WITHDRAWN", withdrawnAt: input.withdrawnAt },
    });

    if (withdrawn.count !== 1) {
      return null;
    }

    return this.findWith(transaction, input);
  }

  async select(
    scope: TransactionScope,
    input: SelectSupplierQuoteInput,
  ): Promise<SupplierQuoteRecord | null> {
    const transaction = transactionClient(scope);

    try {
      // BR-023 and BR-024 as predicates, not pre-checks. `status = ACTIVE` refuses a withdrawn
      // or already-selected quote; `validUntil >= today` refuses an expired one *at the moment
      // of writing*, so a quote that expired between the read and here does not slip through.
      const selected = await transaction.supplierQuote.updateMany({
        where: {
          id: input.supplierQuoteId,
          organizationId: input.organizationId,
          purchaseRequestId: input.purchaseRequestId,
          status: "ACTIVE",
          validUntil: { gte: toCalendarDay(input.validOnOrAfter) },
        },
        data: {
          status: "SELECTED",
          selectedById: input.selectedById,
          selectedAt: input.selectedAt,
          selectionRationale: input.selectionRationale,
        },
      });

      if (selected.count !== 1) {
        return null;
      }

      return await this.findWith(transaction, input);
    } catch (error: unknown) {
      // BR-024, decided by the partial unique index that permits one SELECTED quote per
      // request. Two buyers selecting different quotes at the same instant therefore produce
      // one winner and one controlled conflict, never two winners (REL-005).
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_VIOLATION
      ) {
        throw new SupplierQuoteConcurrentlyModifiedError();
      }

      throw error;
    }
  }

  /**
   * Tenant, request and quote are all in the predicate. A quote identifier belonging to
   * another request of the same tenant is therefore never loaded, and answers exactly as an
   * unknown one does (MT-004).
   */
  private async findWith(
    client: Pick<DatabaseService, "supplierQuote">,
    criteria: TenantQuoteCriteria,
  ): Promise<SupplierQuoteRecord | null> {
    const quote = await client.supplierQuote.findFirst({
      where: {
        id: criteria.supplierQuoteId,
        organizationId: criteria.organizationId,
        purchaseRequestId: criteria.purchaseRequestId,
      },
      select: QUOTE_SELECTION,
    });

    return quote === null ? null : toRecord(quote);
  }
}

/**
 * BR-023 is inclusive and `valid_until` is a DATE, which round-trips as midnight UTC. The
 * comparison instant is reduced to that same midnight, so a quote valid until the 5th is still
 * selectable at any time on the 5th rather than expiring at the first moment of it.
 */
function toCalendarDay(instant: Date): Date {
  return new Date(
    Date.UTC(
      instant.getUTCFullYear(),
      instant.getUTCMonth(),
      instant.getUTCDate(),
    ),
  );
}

function toRecord(row: SupplierQuoteRow): SupplierQuoteRecord {
  return {
    id: row.id,
    purchaseRequestId: row.purchaseRequestId,
    supplierId: row.supplierId,
    status: toQuoteStatus(row.status),
    freightCents: row.freightCents,
    discountCents: row.discountCents,
    itemsTotalCents: row.itemsTotalCents,
    totalCents: row.totalCents,
    itemCount: row.itemCount,
    validUntil: row.validUntil,
    deliveryLeadTimeDays: row.deliveryLeadTimeDays,
    registeredById: row.registeredById,
    selectionRationale: row.selectionRationale,
    selectedById: row.selectedById,
    selectedAt: row.selectedAt,
    withdrawnAt: row.withdrawnAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    items: row.items.map((item) => ({
      id: item.id,
      purchaseRequestItemId: item.purchaseRequestItemId,
      position: item.position,
      quantityScaled: toScaledQuantity(item.quantity),
      unitPriceCents: item.unitPriceCents,
      lineTotalCents: item.lineTotalCents,
    })),
  };
}

/**
 * Persistence returns the PostgreSQL enum as a string. Narrowing it here, in one place, means
 * a value added to the database but not to the application contract fails loudly instead of
 * reaching the domain as an unrecognized quote status.
 */
function toQuoteStatus(value: string): SupplierQuoteStatus {
  const status = supplierQuoteStatuses.find((candidate) => candidate === value);

  if (status === undefined) {
    throw new Error("Persistence returned an unsupported supplier quote status");
  }

  return status;
}

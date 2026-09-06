import { Injectable } from "@nestjs/common";
import { DatabaseService, Prisma } from "@vendorflow/database";
import type {
  CancelPurchaseRequestInput,
  CreatePurchaseRequestDraftInput,
  ListOwnPurchaseRequestsCriteria,
  OwnPurchaseRequestCriteria,
  PurchaseRequestPage,
  PurchaseRequestRecord,
  PurchaseRequestRepository,
  PurchaseRequestSummaryRecord,
  ReplacePurchaseRequestDraftInput,
  SubmitPurchaseRequestInput,
} from "../../application/contracts/purchase-request.repository";
import type { NormalizedPurchaseRequestDraftItem } from "../../application/support/purchase-request-draft";
import { calculateEstimatedLineTotalCents } from "../../application/support/purchase-request-money";
import {
  toDecimalQuantity,
  toPurchaseRequestStatus,
  toScaledQuantity,
} from "./purchase-request-status.mapper";

const REQUEST_SELECTION = {
  id: true,
  status: true,
  requesterId: true,
  departmentId: true,
  justification: true,
  neededBy: true,
  estimatedTotalCents: true,
  submittedAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
  items: {
    orderBy: { position: "asc" },
    select: {
      id: true,
      position: true,
      description: true,
      unitOfMeasure: true,
      quantity: true,
      estimatedUnitPriceCents: true,
    },
  },
} satisfies Prisma.PurchaseRequestSelect;

const SUMMARY_SELECTION = {
  id: true,
  status: true,
  neededBy: true,
  estimatedTotalCents: true,
  submittedAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { items: true } },
} satisfies Prisma.PurchaseRequestSelect;

type PurchaseRequestRow = Prisma.PurchaseRequestGetPayload<{
  select: typeof REQUEST_SELECTION;
}>;

type PurchaseRequestSummaryRow = Prisma.PurchaseRequestGetPayload<{
  select: typeof SUMMARY_SELECTION;
}>;

/**
 * Long enough for a draft replacement — a conditional update plus a delete and a re-insert
 * of the item list — to finish, short enough that a stuck transaction does not hold the
 * request's row lock indefinitely.
 */
const DRAFT_REPLACEMENT_TIMEOUT_MS = 10_000;

@Injectable()
export class PrismaPurchaseRequestRepository
  implements PurchaseRequestRepository
{
  constructor(private readonly database: DatabaseService) {}

  async createDraft(
    input: CreatePurchaseRequestDraftInput,
  ): Promise<PurchaseRequestRecord> {
    const created = await this.database.purchaseRequest.create({
      data: {
        organizationId: input.organizationId,
        requesterId: input.requesterId,
        departmentId: input.departmentId,
        justification: input.justification,
        neededBy: input.neededBy,
        estimatedTotalCents: input.estimatedTotalCents,
        items: {
          // Positions are assigned here, from array order. A client never names one, so it
          // cannot collide with the (organization, request, position) unique constraint or
          // reorder someone else's line.
          create: input.items.map((item, index) => itemData(item, index)),
        },
      },
      select: REQUEST_SELECTION,
    });

    return toRecord(created);
  }

  async findOwnRequest(
    criteria: OwnPurchaseRequestCriteria,
  ): Promise<PurchaseRequestRecord | null> {
    // Tenant, resource and owner are all in the predicate. A foreign row is never loaded,
    // so there is nothing to decide about after the fact (ADR-002).
    const request = await this.database.purchaseRequest.findUnique({
      where: {
        organizationId_id: {
          organizationId: criteria.organizationId,
          id: criteria.purchaseRequestId,
        },
        requesterId: criteria.requesterId,
      },
      select: REQUEST_SELECTION,
    });

    return request === null ? null : toRecord(request);
  }

  async listOwnRequests(
    criteria: ListOwnPurchaseRequestsCriteria,
  ): Promise<PurchaseRequestPage> {
    const after = criteria.after;
    // Keyset, not offset: (created_at DESC, id DESC) is a total order backed by the
    // tenant-leading index, so a page cannot shift or repeat when a row is inserted. The
    // cursor is compared as plain values against an already tenant-scoped predicate, so it
    // can neither reach a foreign row nor reveal that one exists.
    const rows = await this.database.purchaseRequest.findMany({
      where: {
        organizationId: criteria.organizationId,
        requesterId: criteria.requesterId,
        ...(after === null
          ? {}
          : {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: criteria.limit + 1,
      select: SUMMARY_SELECTION,
    });

    const page = rows.slice(0, criteria.limit).map((row) => toSummary(row));
    const last = page.at(-1);

    return {
      items: page,
      nextCursor:
        rows.length > criteria.limit && last !== undefined
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  }

  async replaceOwnDraft(
    input: ReplacePurchaseRequestDraftInput,
  ): Promise<PurchaseRequestRecord | null> {
    return this.database.$transaction(
      async (transaction) => {
        // The status is part of the predicate, so a request submitted between the caller's
        // read and this write updates nothing rather than mutating a submitted request
        // (FR-023). `updateMany` is what allows a non-unique predicate; the affected count
        // must be exactly one.
        const updated = await transaction.purchaseRequest.updateMany({
          where: {
            id: input.purchaseRequestId,
            organizationId: input.organizationId,
            requesterId: input.requesterId,
            status: "DRAFT",
          },
          data: {
            justification: input.justification,
            neededBy: input.neededBy,
            estimatedTotalCents: input.estimatedTotalCents,
          },
        });

        if (updated.count !== 1) {
          return null;
        }

        // Items are stated as a whole list, so they are replaced as a whole list. Both
        // statements stay tenant-scoped even though the request row is already proven, so
        // the scope does not depend on the statement above having run.
        await transaction.purchaseRequestItem.deleteMany({
          where: {
            organizationId: input.organizationId,
            purchaseRequestId: input.purchaseRequestId,
          },
        });
        await transaction.purchaseRequestItem.createMany({
          data: input.items.map((item, index) => ({
            organizationId: input.organizationId,
            purchaseRequestId: input.purchaseRequestId,
            ...itemData(item, index),
          })),
        });

        const request = await transaction.purchaseRequest.findUnique({
          where: {
            organizationId_id: {
              organizationId: input.organizationId,
              id: input.purchaseRequestId,
            },
            requesterId: input.requesterId,
          },
          select: REQUEST_SELECTION,
        });

        return request === null ? null : toRecord(request);
      },
      { timeout: DRAFT_REPLACEMENT_TIMEOUT_MS },
    );
  }

  async submitOwnRequest(
    input: SubmitPurchaseRequestInput,
  ): Promise<PurchaseRequestRecord | null> {
    return this.transition({
      criteria: input,
      fromStatuses: input.submittableStatuses,
      data: { status: "SUBMITTED", submittedAt: input.submittedAt },
    });
  }

  async cancelOwnRequest(
    input: CancelPurchaseRequestInput,
  ): Promise<PurchaseRequestRecord | null> {
    return this.transition({
      criteria: input,
      fromStatuses: input.cancellableStatuses,
      data: { status: "CANCELLED", cancelledAt: input.cancelledAt },
    });
  }

  async deleteOwnDraft(criteria: OwnPurchaseRequestCriteria): Promise<boolean> {
    // Items go with it through the ON DELETE CASCADE the migration declares; they have no
    // life outside the request.
    const deleted = await this.database.purchaseRequest.deleteMany({
      where: {
        id: criteria.purchaseRequestId,
        organizationId: criteria.organizationId,
        requesterId: criteria.requesterId,
        status: "DRAFT",
      },
    });

    return deleted.count === 1;
  }

  /**
   * One conditional UPDATE decides every requester-driven transition. The permitted source
   * states are in the WHERE clause rather than checked beforehand, so two concurrent
   * commands cannot both observe the same state and both succeed (AUTHZ-005).
   */
  private async transition(input: {
    readonly criteria: OwnPurchaseRequestCriteria;
    readonly fromStatuses: readonly string[];
    readonly data: Prisma.PurchaseRequestUpdateManyMutationInput;
  }): Promise<PurchaseRequestRecord | null> {
    const { criteria } = input;

    return this.database.$transaction(async (transaction) => {
      const updated = await transaction.purchaseRequest.updateMany({
        where: {
          id: criteria.purchaseRequestId,
          organizationId: criteria.organizationId,
          requesterId: criteria.requesterId,
          status: { in: input.fromStatuses.map(toPurchaseRequestStatus) },
        },
        data: input.data,
      });

      if (updated.count !== 1) {
        return null;
      }

      const request = await transaction.purchaseRequest.findUnique({
        where: {
          organizationId_id: {
            organizationId: criteria.organizationId,
            id: criteria.purchaseRequestId,
          },
          requesterId: criteria.requesterId,
        },
        select: REQUEST_SELECTION,
      });

      return request === null ? null : toRecord(request);
    });
  }
}

function itemData(
  item: NormalizedPurchaseRequestDraftItem,
  index: number,
): {
  position: number;
  description: string;
  unitOfMeasure: string;
  quantity: Prisma.Decimal;
  estimatedUnitPriceCents: bigint;
} {
  return {
    position: index + 1,
    description: item.description,
    unitOfMeasure: item.unitOfMeasure,
    quantity: toDecimalQuantity(item.quantityScaled),
    estimatedUnitPriceCents: item.estimatedUnitPriceCents,
  };
}

function toRecord(row: PurchaseRequestRow): PurchaseRequestRecord {
  return {
    id: row.id,
    status: toPurchaseRequestStatus(row.status),
    requesterId: row.requesterId,
    departmentId: row.departmentId,
    justification: row.justification,
    neededBy: row.neededBy,
    estimatedTotalCents: row.estimatedTotalCents,
    submittedAt: row.submittedAt,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    items: row.items.map((item) => {
      const quantityScaled = toScaledQuantity(item.quantity);

      return {
        id: item.id,
        position: item.position,
        description: item.description,
        unitOfMeasure: item.unitOfMeasure,
        quantityScaled,
        estimatedUnitPriceCents: item.estimatedUnitPriceCents,
        // Derived, never stored: a persisted line total is a second source of truth for a
        // value the unit price and quantity already determine. Recomputing it here with the
        // same half-up rule keeps a read consistent with the write that produced the total.
        estimatedLineTotalCents: calculateEstimatedLineTotalCents({
          quantityScaled,
          estimatedUnitPriceCents: item.estimatedUnitPriceCents,
        }),
      };
    }),
  };
}

function toSummary(
  row: PurchaseRequestSummaryRow,
): PurchaseRequestSummaryRecord {
  return {
    id: row.id,
    status: toPurchaseRequestStatus(row.status),
    neededBy: row.neededBy,
    estimatedTotalCents: row.estimatedTotalCents,
    itemCount: row._count.items,
    submittedAt: row.submittedAt,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

import { Injectable } from "@nestjs/common";
import { DatabaseService, Prisma } from "@vendorflow/database";
import { transactionClient } from "../../../platform/persistence/prisma-transaction-runner";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import {
  toDecimalQuantity,
  toScaledQuantity,
} from "../../../platform/persistence/scaled-quantity.mapper";
import {
  supplierTaxIdentifierTypes,
  type SupplierTaxIdentifierType,
} from "../../../supplier/application/support/tax-identifier";
import { PurchaseOrderAlreadyIssuedError } from "../../application/contracts/purchase-order.errors";
import {
  purchaseOrderStatuses,
  type CancelPurchaseOrderInput,
  type IssuePurchaseOrderInput,
  type ListPurchaseOrdersCriteria,
  type PurchaseOrderPage,
  type PurchaseOrderRecord,
  type PurchaseOrderRepository,
  type PurchaseOrderStatus,
  type TenantPurchaseOrderCriteria,
} from "../../application/contracts/purchase-order.repository";

/** Prisma's code for a unique-constraint violation. */
const UNIQUE_VIOLATION = "P2002";

const ORDER_SELECTION = {
  id: true,
  purchaseRequestId: true,
  supplierQuoteId: true,
  supplierId: true,
  number: true,
  status: true,
  supplierLegalName: true,
  supplierTaxIdentifier: true,
  supplierTaxIdentifierType: true,
  freightCents: true,
  discountCents: true,
  itemsTotalCents: true,
  totalCents: true,
  deliveryLeadTimeDays: true,
  issuedById: true,
  issuedAt: true,
  cancelledById: true,
  cancelledAt: true,
  cancellationReason: true,
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
      unitPriceCents: true,
      lineTotalCents: true,
    },
  },
} satisfies Prisma.PurchaseOrderSelect;

type PurchaseOrderRow = Prisma.PurchaseOrderGetPayload<{
  select: typeof ORDER_SELECTION;
}>;

@Injectable()
export class PrismaPurchaseOrderRepository implements PurchaseOrderRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * FR-053, in one statement.
   *
   * `INSERT … ON CONFLICT DO UPDATE … RETURNING` is what makes this both correct and cheap:
   * the tenant's counter row is created on first use and advanced on every use, the row lock
   * PostgreSQL takes serializes concurrent issuances within the organization, and the whole
   * thing participates in the caller's transaction — so a rollback returns the counter with
   * everything else and consumes no visible number.
   *
   * The inserted `next_value` is 2 and the returned value is `next_value - 1`, which is what
   * makes the **first** allocation of an organization 1 rather than 2. Seeding the row with 1
   * and returning it before incrementing would need two statements and a window between them.
   *
   * A parameterized tagged template with an explicit tenant predicate. There is no
   * string-built SQL here (SEC-005).
   */
  async allocateNextNumber(
    scope: TransactionScope,
    organizationId: string,
  ): Promise<bigint> {
    const allocated = await transactionClient(scope).$queryRaw<
      { allocated: bigint }[]
    >`
      INSERT INTO "purchase_order_number_sequences"
                  ("organization_id", "next_value", "updated_at")
           VALUES (${organizationId}::uuid, 2, CURRENT_TIMESTAMP)
      ON CONFLICT ("organization_id") DO UPDATE
              SET "next_value" = "purchase_order_number_sequences"."next_value" + 1,
                  "updated_at" = CURRENT_TIMESTAMP
        RETURNING "next_value" - 1 AS "allocated"
    `;
    const value = allocated.at(0)?.allocated;

    if (value === undefined) {
      throw new Error("The purchase order number allocation returned no value");
    }

    return value;
  }

  async issue(
    scope: TransactionScope,
    input: IssuePurchaseOrderInput & {
      readonly sequenceValue: bigint;
      readonly number: string;
    },
  ): Promise<PurchaseOrderRecord> {
    const transaction = transactionClient(scope);

    try {
      const created = await transaction.purchaseOrder.create({
        data: {
          organizationId: input.organizationId,
          purchaseRequestId: input.purchaseRequestId,
          supplierQuoteId: input.supplierQuoteId,
          // The four-column composite foreign key over (organization, quote, request,
          // supplier) is what proves this is the quote's supplier. Nothing in this method
          // could establish that on its own, and nothing in this method has to.
          supplierId: input.supplierId,
          number: input.number,
          sequenceValue: input.sequenceValue,
          supplierLegalName: input.supplierLegalName,
          supplierTaxIdentifier: input.supplierTaxIdentifier,
          supplierTaxIdentifierType: input.supplierTaxIdentifierType,
          freightCents: input.freightCents,
          discountCents: input.discountCents,
          itemsTotalCents: input.itemsTotalCents,
          totalCents: input.totalCents,
          deliveryLeadTimeDays: input.deliveryLeadTimeDays,
          issuedById: input.issuedById,
          issuedAt: input.issuedAt,
        },
        select: { id: true },
      });

      // A separate statement rather than a nested create, for the same reason as a quote line:
      // the tenant column participates in the composite foreign key back to the order, and only
      // the explicit form can state it. Still one transaction.
      await transaction.purchaseOrderItem.createMany({
        data: input.lines.map((line) => ({
          organizationId: input.organizationId,
          purchaseOrderId: created.id,
          position: line.position,
          description: line.description,
          unitOfMeasure: line.unitOfMeasure,
          quantity: toDecimalQuantity(line.quantityScaled),
          unitPriceCents: line.unitPriceCents,
          lineTotalCents: line.lineTotalCents,
        })),
      });

      const order = await transaction.purchaseOrder.findUniqueOrThrow({
        where: {
          organizationId_id: {
            organizationId: input.organizationId,
            id: created.id,
          },
        },
        select: ORDER_SELECTION,
      });

      return toRecord(order);
    } catch (error: unknown) {
      // FR-050, decided by the unique constraints on (organization, request) and
      // (organization, quote). Translated into the business error a pre-check would have
      // produced, so a race answers exactly as a sequential duplicate does (ADR-002).
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_VIOLATION
      ) {
        throw new PurchaseOrderAlreadyIssuedError();
      }

      throw error;
    }
  }

  async find(
    criteria: TenantPurchaseOrderCriteria,
  ): Promise<PurchaseOrderRecord | null> {
    const order = await this.database.purchaseOrder.findUnique({
      where: {
        organizationId_id: {
          organizationId: criteria.organizationId,
          id: criteria.purchaseOrderId,
        },
      },
      select: ORDER_SELECTION,
    });

    return order === null ? null : toRecord(order);
  }

  async findForRequest(criteria: {
    readonly organizationId: string;
    readonly purchaseRequestId: string;
  }): Promise<PurchaseOrderRecord | null> {
    const order = await this.database.purchaseOrder.findUnique({
      where: {
        organizationId_purchaseRequestId: {
          organizationId: criteria.organizationId,
          purchaseRequestId: criteria.purchaseRequestId,
        },
      },
      select: ORDER_SELECTION,
    });

    return order === null ? null : toRecord(order);
  }

  async list(criteria: ListPurchaseOrdersCriteria): Promise<PurchaseOrderPage> {
    const after = criteria.after;
    // Keyset, not offset: (issued_at DESC, id DESC) is a total order backed by the
    // tenant-leading index, so a page cannot shift or repeat when an order is issued.
    const rows = await this.database.purchaseOrder.findMany({
      where: {
        organizationId: criteria.organizationId,
        ...(criteria.status === null ? {} : { status: criteria.status }),
        ...(after === null
          ? {}
          : {
              OR: [
                { issuedAt: { lt: after.issuedAt } },
                { issuedAt: after.issuedAt, id: { lt: after.id } },
              ],
            }),
      },
      orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
      take: criteria.limit + 1,
      select: ORDER_SELECTION,
    });
    const page = rows.slice(0, criteria.limit).map((row) => toRecord(row));
    const last = page.at(-1);

    return {
      items: page,
      nextCursor:
        rows.length > criteria.limit && last !== undefined
          ? { issuedAt: last.issuedAt, id: last.id }
          : null,
    };
  }

  async cancel(
    scope: TransactionScope,
    input: CancelPurchaseOrderInput,
  ): Promise<PurchaseOrderRecord | null> {
    const transaction = transactionClient(scope);
    // `status = ISSUED` is in the WHERE clause rather than checked beforehand, so two
    // concurrent cancellations cannot both observe an issued order and both succeed
    // (REL-005). Cancellation is terminal, so there is no state to return to.
    const cancelled = await transaction.purchaseOrder.updateMany({
      where: {
        id: input.purchaseOrderId,
        organizationId: input.organizationId,
        status: "ISSUED",
      },
      data: {
        status: "CANCELLED",
        cancelledById: input.cancelledById,
        cancelledAt: input.cancelledAt,
        cancellationReason: input.cancellationReason,
      },
    });

    if (cancelled.count !== 1) {
      return null;
    }

    const order = await transaction.purchaseOrder.findUnique({
      where: {
        organizationId_id: {
          organizationId: input.organizationId,
          id: input.purchaseOrderId,
        },
      },
      select: ORDER_SELECTION,
    });

    return order === null ? null : toRecord(order);
  }
}

function toRecord(row: PurchaseOrderRow): PurchaseOrderRecord {
  return {
    id: row.id,
    purchaseRequestId: row.purchaseRequestId,
    supplierQuoteId: row.supplierQuoteId,
    supplierId: row.supplierId,
    number: row.number,
    status: toPurchaseOrderStatus(row.status),
    supplierLegalName: row.supplierLegalName,
    supplierTaxIdentifier: row.supplierTaxIdentifier,
    supplierTaxIdentifierType: toTaxIdentifierType(
      row.supplierTaxIdentifierType,
    ),
    freightCents: row.freightCents,
    discountCents: row.discountCents,
    itemsTotalCents: row.itemsTotalCents,
    totalCents: row.totalCents,
    deliveryLeadTimeDays: row.deliveryLeadTimeDays,
    issuedById: row.issuedById,
    issuedAt: row.issuedAt,
    cancelledById: row.cancelledById,
    cancelledAt: row.cancelledAt,
    cancellationReason: row.cancellationReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    items: row.items.map((item) => ({
      id: item.id,
      position: item.position,
      description: item.description,
      unitOfMeasure: item.unitOfMeasure,
      quantityScaled: toScaledQuantity(item.quantity),
      unitPriceCents: item.unitPriceCents,
      lineTotalCents: item.lineTotalCents,
    })),
  };
}

/**
 * Persistence returns the PostgreSQL enums as strings. Narrowing them here, in one place, means
 * a value added to the database but not to the application contract fails loudly instead of
 * reaching the domain as an unrecognized status or identifier type.
 */
function toPurchaseOrderStatus(value: string): PurchaseOrderStatus {
  const status = purchaseOrderStatuses.find((candidate) => candidate === value);

  if (status === undefined) {
    throw new Error("Persistence returned an unsupported purchase order status");
  }

  return status;
}

function toTaxIdentifierType(value: string): SupplierTaxIdentifierType {
  const type = supplierTaxIdentifierTypes.find(
    (candidate) => candidate === value,
  );

  if (type === undefined) {
    throw new Error("Persistence returned an unsupported tax identifier type");
  }

  return type;
}

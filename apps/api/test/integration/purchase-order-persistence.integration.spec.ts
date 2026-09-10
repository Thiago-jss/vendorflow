import { DatabaseService } from "@vendorflow/database";
import { PrismaTransactionRunner } from "../../src/platform/persistence/prisma-transaction-runner";
import { PrismaPurchaseRequestRepository } from "../../src/procurement/infrastructure/persistence/prisma-purchase-request.repository";
import { PurchaseOrderAlreadyIssuedError } from "../../src/purchase-order/application/contracts/purchase-order.errors";
import { formatPurchaseOrderNumber } from "../../src/purchase-order/application/support/purchase-order-number";
import { PrismaPurchaseOrderRepository } from "../../src/purchase-order/infrastructure/persistence/prisma-purchase-order.repository";
import { createTenant, type TenantFixture } from "./identity-fixtures";
import { PostgreSqlIntegrationTestHarness } from "./postgresql-test-harness";
import {
  createPurchaseRequest,
  createSupplier,
  createSupplierQuote,
} from "./quotation-fixtures";

interface OrderableFixture {
  readonly purchaseRequestId: string;
  readonly itemIds: readonly string[];
  readonly supplierId: string;
  readonly supplierQuoteId: string;
}

/**
 * FR-050 – FR-053 against a real PostgreSQL.
 *
 * Three properties here exist only in the database: the four-column composite foreign key that
 * makes a mismatched supplier unrepresentable, the tenant counter whose row lock serializes
 * concurrent issuances, and the fact that a rollback returns an allocated number with
 * everything else. None of them can be demonstrated against a mock.
 */
describe("purchase order persistence (PostgreSQL)", () => {
  let harness: PostgreSqlIntegrationTestHarness;
  let database: DatabaseService;
  let transactions: PrismaTransactionRunner;
  let purchaseOrders: PrismaPurchaseOrderRepository;
  let purchaseRequests: PrismaPurchaseRequestRepository;
  let organizationA: TenantFixture;
  let organizationB: TenantFixture;

  beforeAll(async () => {
    harness = await PostgreSqlIntegrationTestHarness.start();
    database = harness.database;
    transactions = new PrismaTransactionRunner(database);
    purchaseOrders = new PrismaPurchaseOrderRepository(database);
    purchaseRequests = new PrismaPurchaseRequestRepository(database);
  }, 180_000);

  beforeEach(async () => {
    await harness.clean();
    organizationA = await createTenant(database, { suffix: "A" });
    organizationB = await createTenant(database, { suffix: "B" });
  }, 60_000);

  afterAll(async () => {
    if (harness !== undefined) {
      await harness.stop();
    }
  });

  /** An APPROVED request with exactly one selected quote: the only shape FR-050 admits. */
  async function orderable(
    tenant: TenantFixture,
    suffix = "primary",
  ): Promise<OrderableFixture> {
    const request = await createPurchaseRequest(database, tenant, {
      status: "APPROVED",
    });
    const supplierId = await createSupplier(database, tenant, { suffix });
    const supplierQuoteId = await createSupplierQuote(
      database,
      tenant,
      {
        purchaseRequestId: request.purchaseRequestId,
        supplierId,
        registeredById: tenant.userId,
        requestItemIds: request.itemIds,
      },
      { status: "SELECTED" },
    );

    return { ...request, supplierId, supplierQuoteId };
  }

  function issuanceInput(
    tenant: TenantFixture,
    fixture: OrderableFixture,
    overrides: { readonly supplierId?: string } = {},
  ) {
    return {
      organizationId: tenant.organizationId,
      purchaseRequestId: fixture.purchaseRequestId,
      supplierQuoteId: fixture.supplierQuoteId,
      supplierId: overrides.supplierId ?? fixture.supplierId,
      supplierLegalName: "Supplier Primary Ltda",
      supplierTaxIdentifier: "11.222.333/0001-81",
      supplierTaxIdentifierType: "CNPJ" as const,
      freightCents: 0n,
      discountCents: 0n,
      itemsTotalCents: 270_000n,
      totalCents: 270_000n,
      deliveryLeadTimeDays: 15,
      issuedById: tenant.userId,
      issuedAt: new Date(),
      lines: fixture.itemIds.map((_, index) => ({
        position: index + 1,
        description: `Line ${index + 1}`,
        unitOfMeasure: "UN",
        quantityScaled: 1_000n,
        unitPriceCents: 135_000n,
        lineTotalCents: 135_000n,
      })),
    };
  }

  async function issue(
    tenant: TenantFixture,
    fixture: OrderableFixture,
    overrides: { readonly supplierId?: string } = {},
  ) {
    return transactions.run(async (scope) => {
      const sequenceValue = await purchaseOrders.allocateNextNumber(
        scope,
        tenant.organizationId,
      );

      return purchaseOrders.issue(scope, {
        ...issuanceInput(tenant, fixture, overrides),
        sequenceValue,
        number: formatPurchaseOrderNumber(sequenceValue),
      });
    });
  }

  describe("FR-051 the order's supplier is the quote's supplier, proven by PostgreSQL", () => {
    it("refuses an order naming a different supplier of the same tenant", async () => {
      // This is the requirement that application convention cannot satisfy: a check in code can
      // be raced, bypassed by another write path, or simply forgotten. The composite foreign key
      // over (organization, quote, request, supplier) makes the row unrepresentable.
      const fixture = await orderable(organizationA);
      const otherSupplierId = await createSupplier(database, organizationA, {
        suffix: "other",
      });

      await expect(
        issue(organizationA, fixture, { supplierId: otherSupplierId }),
      ).rejects.toThrow(
        /purchase_orders_organization_id_quote_request_supplier_fkey/,
      );
      await expect(database.purchaseOrder.count()).resolves.toBe(0);
    });

    it("refuses an order naming a supplier of another tenant", async () => {
      const fixture = await orderable(organizationA);
      const foreignSupplierId = await createSupplier(database, organizationB, {
        suffix: "foreign",
      });

      await expect(
        issue(organizationA, fixture, { supplierId: foreignSupplierId }),
      ).rejects.toThrow();
    });

    it("refuses an order whose quote belongs to another request", async () => {
      const fixture = await orderable(organizationA);
      const other = await orderable(organizationA, "second");

      await expect(
        issue(organizationA, {
          ...fixture,
          supplierQuoteId: other.supplierQuoteId,
        }),
      ).rejects.toThrow();
    });

    it("accepts the order the selected quote actually names", async () => {
      const fixture = await orderable(organizationA);
      const order = await issue(organizationA, fixture);

      expect(order.number).toBe("PO-000001");
      expect(order.supplierId).toBe(fixture.supplierId);
      expect(order.items).toHaveLength(fixture.itemIds.length);
    });
  });

  describe("FR-053 tenant-owned numbering", () => {
    it("hands out 1 for an organization's first order, not 0 and not 2", async () => {
      await expect(
        transactions.run((scope) =>
          purchaseOrders.allocateNextNumber(scope, organizationA.organizationId),
        ),
      ).resolves.toBe(1n);
    });

    it("counts up without gaps within one organization", async () => {
      const allocated: bigint[] = [];

      for (let index = 0; index < 3; index += 1) {
        allocated.push(
          await transactions.run((scope) =>
            purchaseOrders.allocateNextNumber(
              scope,
              organizationA.organizationId,
            ),
          ),
        );
      }

      expect(allocated).toEqual([1n, 2n, 3n]);
    });

    it("gives every organization its own counter starting at 1 (MT-006)", async () => {
      // No tenant can infer another's purchasing volume from the numbers it sees.
      await transactions.run((scope) =>
        purchaseOrders.allocateNextNumber(scope, organizationA.organizationId),
      );
      await transactions.run((scope) =>
        purchaseOrders.allocateNextNumber(scope, organizationA.organizationId),
      );

      await expect(
        transactions.run((scope) =>
          purchaseOrders.allocateNextNumber(scope, organizationB.organizationId),
        ),
      ).resolves.toBe(1n);
    });

    it("consumes no visible number when the issuance rolls back", async () => {
      const fixture = await orderable(organizationA);

      await expect(
        transactions.run(async (scope) => {
          const sequenceValue = await purchaseOrders.allocateNextNumber(
            scope,
            organizationA.organizationId,
          );

          expect(sequenceValue).toBe(1n);
          await purchaseOrders.issue(scope, {
            ...issuanceInput(organizationA, fixture),
            sequenceValue,
            number: formatPurchaseOrderNumber(sequenceValue),
          });

          // Stands in for anything that can fail after the rows are written: a constraint, a
          // lost connection, a failing audit or outbox write. The point is what survives.
          throw new Error("audit storage is unavailable");
        }),
      ).rejects.toThrow("audit storage is unavailable");

      await expect(database.purchaseOrder.count()).resolves.toBe(0);
      await expect(database.purchaseOrderItem.count()).resolves.toBe(0);
      await expect(
        database.purchaseOrderNumberSequence.count(),
      ).resolves.toBe(0);

      // The next successful issuance gets the number the failed attempt would have had.
      const order = await issue(organizationA, fixture);
      expect(order.number).toBe("PO-000001");
    });

    it("rolls the request's transition back with the order (REL-001)", async () => {
      const fixture = await orderable(organizationA);

      await expect(
        transactions.run(async (scope) => {
          const sequenceValue = await purchaseOrders.allocateNextNumber(
            scope,
            organizationA.organizationId,
          );
          await purchaseOrders.issue(scope, {
            ...issuanceInput(organizationA, fixture),
            sequenceValue,
            number: formatPurchaseOrderNumber(sequenceValue),
          });
          await purchaseRequests.applyOrderIssued(scope, {
            organizationId: organizationA.organizationId,
            purchaseRequestId: fixture.purchaseRequestId,
          });

          throw new Error("outbox storage is unavailable");
        }),
      ).rejects.toThrow("outbox storage is unavailable");

      await expect(
        database.purchaseRequest.findUniqueOrThrow({
          where: { id: fixture.purchaseRequestId },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: "APPROVED" });
      await expect(database.purchaseOrder.count()).resolves.toBe(0);
    });
  });

  describe("FR-050 exactly one purchase order per request", () => {
    it("refuses a second order for the same request as a business conflict", async () => {
      const fixture = await orderable(organizationA);
      await issue(organizationA, fixture);

      await expect(issue(organizationA, fixture)).rejects.toBeInstanceOf(
        PurchaseOrderAlreadyIssuedError,
      );
    });

    it("produces one order, one number and one transition under concurrent issuance", async () => {
      const fixture = await orderable(organizationA);

      const results = await Promise.allSettled([
        transactions.run(async (scope) => {
          const sequenceValue = await purchaseOrders.allocateNextNumber(
            scope,
            organizationA.organizationId,
          );
          const order = await purchaseOrders.issue(scope, {
            ...issuanceInput(organizationA, fixture),
            sequenceValue,
            number: formatPurchaseOrderNumber(sequenceValue),
          });
          await purchaseRequests.applyOrderIssued(scope, {
            organizationId: organizationA.organizationId,
            purchaseRequestId: fixture.purchaseRequestId,
          });

          return order;
        }),
        transactions.run(async (scope) => {
          const sequenceValue = await purchaseOrders.allocateNextNumber(
            scope,
            organizationA.organizationId,
          );
          const order = await purchaseOrders.issue(scope, {
            ...issuanceInput(organizationA, fixture),
            sequenceValue,
            number: formatPurchaseOrderNumber(sequenceValue),
          });
          await purchaseRequests.applyOrderIssued(scope, {
            organizationId: organizationA.organizationId,
            purchaseRequestId: fixture.purchaseRequestId,
          });

          return order;
        }),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      await expect(database.purchaseOrder.count()).resolves.toBe(1);

      const order = await database.purchaseOrder.findFirstOrThrow({
        select: { number: true, sequenceValue: true },
      });
      // The loser's allocation rolled back with it, so the winner's number is still the first.
      expect(order.number).toBe("PO-000001");
      expect(order.sequenceValue).toBe(1n);
      await expect(
        database.purchaseRequest.findUniqueOrThrow({
          where: { id: fixture.purchaseRequestId },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: "ORDERED" });
    });
  });

  describe("FR-054 cancellation is terminal and local", () => {
    it("records who cancelled, when and why, and refuses a second cancellation", async () => {
      const fixture = await orderable(organizationA);
      const order = await issue(organizationA, fixture);
      const input = {
        organizationId: organizationA.organizationId,
        purchaseOrderId: order.id,
        cancelledById: organizationA.userId,
        cancelledAt: new Date(),
        cancellationReason: "Supplier withdrew after a plant fire",
      };

      await expect(
        transactions.run((scope) => purchaseOrders.cancel(scope, input)),
      ).resolves.not.toBeNull();
      // The conditional write re-checks ISSUED, so the second attempt matches no row.
      await expect(
        transactions.run((scope) => purchaseOrders.cancel(scope, input)),
      ).resolves.toBeNull();
    });

    it("refuses a cancelled order with no reason, actor or instant", async () => {
      const fixture = await orderable(organizationA);
      const order = await issue(organizationA, fixture);

      await expect(
        database.purchaseOrder.update({
          where: {
            organizationId_id: {
              organizationId: organizationA.organizationId,
              id: order.id,
            },
          },
          data: { status: "CANCELLED" },
        }),
      ).rejects.toThrow(/purchase_orders_cancellation_check/);
    });

    it("refuses a reason shorter than ten non-whitespace characters at the database too", async () => {
      const fixture = await orderable(organizationA);
      const order = await issue(organizationA, fixture);

      await expect(
        database.purchaseOrder.update({
          where: {
            organizationId_id: {
              organizationId: organizationA.organizationId,
              id: order.id,
            },
          },
          data: {
            status: "CANCELLED",
            cancelledById: organizationA.userId,
            cancelledAt: new Date(),
            cancellationReason: "   short   ",
          },
        }),
      ).rejects.toThrow(/purchase_orders_cancellation_check/);
    });

    it("leaves the ORDERED request exactly where it was (BR-013)", async () => {
      const fixture = await orderable(organizationA);
      const order = await issue(organizationA, fixture);

      await transactions.run((scope) =>
        purchaseRequests.applyOrderIssued(scope, {
          organizationId: organizationA.organizationId,
          purchaseRequestId: fixture.purchaseRequestId,
        }),
      );
      await transactions.run((scope) =>
        purchaseOrders.cancel(scope, {
          organizationId: organizationA.organizationId,
          purchaseOrderId: order.id,
          cancelledById: organizationA.userId,
          cancelledAt: new Date(),
          cancellationReason: "Supplier withdrew after a plant fire",
        }),
      );

      await expect(
        database.purchaseRequest.findUniqueOrThrow({
          where: { id: fixture.purchaseRequestId },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: "ORDERED" });
      // And the selected quote is still selected: cancelling an order reopens nothing.
      await expect(
        database.supplierQuote.count({
          where: { id: fixture.supplierQuoteId, status: "SELECTED" },
        }),
      ).resolves.toBe(1);
    });
  });

  describe("tenant-scoped reads never load a foreign order (MT-004)", () => {
    it("answers null for another organization's order identifier", async () => {
      const foreign = await orderable(organizationB);
      const order = await issue(organizationB, foreign);

      await expect(
        purchaseOrders.find({
          organizationId: organizationA.organizationId,
          purchaseOrderId: order.id,
        }),
      ).resolves.toBeNull();
    });

    it("lists only the caller's own organization", async () => {
      await issue(organizationA, await orderable(organizationA));
      await issue(organizationB, await orderable(organizationB));

      const page = await purchaseOrders.list({
        organizationId: organizationA.organizationId,
        status: null,
        limit: 20,
        after: null,
      });

      expect(page.items).toHaveLength(1);
      // Both organizations' first order is PO-000001, which is the point of a per-tenant
      // counter — and is why the identifier alone can never be used to reach across a tenant.
      expect(page.items[0]?.number).toBe("PO-000001");
    });
  });
});

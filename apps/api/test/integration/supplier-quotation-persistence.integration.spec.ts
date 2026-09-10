import { randomUUID } from "node:crypto";
import { DatabaseService, Prisma } from "@vendorflow/database";
import { PrismaTransactionRunner } from "../../src/platform/persistence/prisma-transaction-runner";
import { PrismaApprovalFlowRepository } from "../../src/approval/infrastructure/persistence/prisma-approval-flow.repository";
import { PrismaPurchaseRequestRepository } from "../../src/procurement/infrastructure/persistence/prisma-purchase-request.repository";
import { PrismaSupplierQuoteRepository } from "../../src/quotation/infrastructure/persistence/prisma-supplier-quote.repository";
import { SupplierQuoteAlreadyActiveError } from "../../src/quotation/application/contracts/quotation.errors";
import { createTenant, type TenantFixture } from "./identity-fixtures";
import { PostgreSqlIntegrationTestHarness } from "./postgresql-test-harness";
import {
  createPurchaseRequest,
  createSupplier,
  createSupplierQuote,
  type PurchaseRequestFixture,
} from "./quotation-fixtures";

/**
 * What PostgreSQL refuses, whatever wrote it.
 *
 * Every assertion here is about a property no unit test can hold: a composite foreign key, a
 * partial unique index, a CHECK constraint, a deferred constraint trigger evaluated at COMMIT,
 * and two transactions racing under READ COMMITTED. A mock would only demonstrate the mock.
 *
 * The fixtures write through Prisma rather than through the application on purpose: the point
 * is what the database refuses even when the application's own checks are bypassed.
 */
describe("supplier and quotation persistence (PostgreSQL)", () => {
  let harness: PostgreSqlIntegrationTestHarness;
  let database: DatabaseService;
  let transactions: PrismaTransactionRunner;
  let purchaseRequests: PrismaPurchaseRequestRepository;
  let approvalFlows: PrismaApprovalFlowRepository;
  let supplierQuotes: PrismaSupplierQuoteRepository;
  let organizationA: TenantFixture;
  let organizationB: TenantFixture;

  beforeAll(async () => {
    harness = await PostgreSqlIntegrationTestHarness.start();
    database = harness.database;
    transactions = new PrismaTransactionRunner(database);
    purchaseRequests = new PrismaPurchaseRequestRepository(database);
    approvalFlows = new PrismaApprovalFlowRepository(database);
    supplierQuotes = new PrismaSupplierQuoteRepository(database);
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

  async function quotableRequest(
    tenant: TenantFixture,
  ): Promise<PurchaseRequestFixture & { readonly supplierId: string }> {
    const request = await createPurchaseRequest(database, tenant);
    const supplierId = await createSupplier(database, tenant, {
      suffix: `${tenant.organizationId.slice(0, 8)}-1`,
    });

    return { ...request, supplierId };
  }

  describe("FR-013 supplier fiscal identity", () => {
    it("refuses a second supplier with the same normalized identifier in one tenant", async () => {
      await createSupplier(database, organizationA, {
        suffix: "one",
        taxIdentifierNormalized: "11222333000181",
      });

      await expect(
        createSupplier(database, organizationA, {
          suffix: "two",
          taxIdentifierNormalized: "11222333000181",
        }),
      ).rejects.toThrow();
    });

    it("lets two tenants register the same identifier (MT-006)", async () => {
      // Uniqueness is per organization. Two customers may perfectly well buy from one supplier.
      await createSupplier(database, organizationA, {
        suffix: "one",
        taxIdentifierNormalized: "11222333000181",
      });

      await expect(
        createSupplier(database, organizationB, {
          suffix: "one",
          taxIdentifierNormalized: "11222333000181",
        }),
      ).resolves.toEqual(expect.any(String));
    });

    it("refuses a CNPJ whose normalized form is not 14 digits", async () => {
      await expect(
        createSupplier(database, organizationA, {
          suffix: "bad",
          taxIdentifierType: "CNPJ",
          taxIdentifierNormalized: "1122233300018",
        }),
      ).rejects.toThrow(/suppliers_cnpj_normalized_check/);
    });

    it("refuses a normalized form that is not uppercase alphanumeric", async () => {
      await expect(
        createSupplier(database, organizationA, {
          suffix: "bad",
          taxIdentifierNormalized: "vf-lower",
        }),
      ).rejects.toThrow(/suppliers_tax_identifier_normalized_shape_check/);
    });

    it("refuses an inactive supplier with no deactivation instant, and the reverse", async () => {
      const base = {
        organizationId: organizationA.organizationId,
        legalName: "Papelaria Central Ltda",
        tradeName: "Papelaria Central",
        taxIdentifierType: "OTHER" as const,
        contactEmail: "contato@example.com",
        contactPhone: "+55 11 4002-8922",
      };

      await expect(
        database.supplier.create({
          data: {
            ...base,
            taxIdentifier: "A1",
            taxIdentifierNormalized: "A1",
            isActive: false,
            deactivatedAt: null,
          },
        }),
      ).rejects.toThrow(/suppliers_deactivation_check/);

      await expect(
        database.supplier.create({
          data: {
            ...base,
            taxIdentifier: "A2",
            taxIdentifierNormalized: "A2",
            isActive: true,
            deactivatedAt: new Date(),
          },
        }),
      ).rejects.toThrow(/suppliers_deactivation_check/);
    });
  });

  describe("cross-tenant relationships are refused by PostgreSQL, not by the caller", () => {
    it("refuses a quote whose supplier belongs to another organization", async () => {
      const request = await createPurchaseRequest(database, organizationA);
      const foreignSupplierId = await createSupplier(database, organizationB, {
        suffix: "foreign",
      });

      await expect(
        createSupplierQuote(
          database,
          organizationA,
          {
            purchaseRequestId: request.purchaseRequestId,
            supplierId: foreignSupplierId,
            registeredById: organizationA.userId,
            requestItemIds: request.itemIds,
          },
        ),
      ).rejects.toThrow(/supplier_quotes_organization_id_supplier_id_fkey/);
    });

    it("refuses a quote attached to another organization's request", async () => {
      const foreign = await createPurchaseRequest(database, organizationB);
      const supplierId = await createSupplier(database, organizationA, {
        suffix: "own",
      });

      await expect(
        createSupplierQuote(database, organizationA, {
          purchaseRequestId: foreign.purchaseRequestId,
          supplierId,
          registeredById: organizationA.userId,
          requestItemIds: foreign.itemIds,
        }),
      ).rejects.toThrow();
    });

    it("refuses a quote registered by a user of another organization", async () => {
      const { purchaseRequestId, itemIds, supplierId } =
        await quotableRequest(organizationA);

      await expect(
        createSupplierQuote(database, organizationA, {
          purchaseRequestId,
          supplierId,
          registeredById: organizationB.userId,
          requestItemIds: itemIds,
        }),
      ).rejects.toThrow(/supplier_quotes_organization_id_registered_by_id_fkey/);
    });
  });

  describe("BR-021 a quote prices every item of its request, and only those", () => {
    it("refuses a line that prices an item of a different request in the same tenant", async () => {
      // The composite foreign key reaches the request item through
      // (organization, request, item), so the line simply has nowhere to point.
      const own = await quotableRequest(organizationA);
      const other = await createPurchaseRequest(database, organizationA);

      await expect(
        createSupplierQuote(
          database,
          organizationA,
          {
            purchaseRequestId: own.purchaseRequestId,
            supplierId: own.supplierId,
            registeredById: organizationA.userId,
            requestItemIds: own.itemIds,
          },
          { itemIds: other.itemIds },
        ),
      ).rejects.toThrow(
        /supplier_quote_items_organization_id_request_id_item_id_fkey/,
      );
    });

    it("refuses a partial quote at COMMIT, through the deferred coverage trigger", async () => {
      const { purchaseRequestId, itemIds, supplierId } =
        await quotableRequest(organizationA);

      // Only the first of two lines. Every individual statement is valid; the coverage is not,
      // and coverage is only decidable once the whole insert has been written.
      await expect(
        createSupplierQuote(
          database,
          organizationA,
          {
            purchaseRequestId,
            supplierId,
            registeredById: organizationA.userId,
            requestItemIds: itemIds,
          },
          { itemIds: itemIds.slice(0, 1) },
        ),
      ).rejects.toThrow(/must price every item of its purchase request/);

      await expect(database.supplierQuote.count()).resolves.toBe(0);
    });

    it("refuses a declared item count that disagrees with the lines written", async () => {
      const { purchaseRequestId, itemIds, supplierId } =
        await quotableRequest(organizationA);

      await expect(
        createSupplierQuote(
          database,
          organizationA,
          {
            purchaseRequestId,
            supplierId,
            registeredById: organizationA.userId,
            requestItemIds: itemIds,
          },
          { declaredItemCount: itemIds.length + 1 },
        ),
      ).rejects.toThrow(/must price every item of its purchase request/);
    });

    it("refuses a duplicate line for one request item", async () => {
      const { purchaseRequestId, itemIds, supplierId } =
        await quotableRequest(organizationA);
      const quoteId = await createSupplierQuote(database, organizationA, {
        purchaseRequestId,
        supplierId,
        registeredById: organizationA.userId,
        requestItemIds: itemIds,
      });

      await expect(
        database.supplierQuoteItem.create({
          data: {
            organizationId: organizationA.organizationId,
            supplierQuoteId: quoteId,
            purchaseRequestId,
            purchaseRequestItemId: itemIds[0] as string,
            position: 99,
            quantity: new Prisma.Decimal("1.000"),
            unitPriceCents: 1n,
            lineTotalCents: 1n,
          },
        }),
      ).rejects.toThrow();
    });

    it("accepts a quote whose coverage is exact", async () => {
      const { purchaseRequestId, itemIds, supplierId } =
        await quotableRequest(organizationA);

      await expect(
        createSupplierQuote(database, organizationA, {
          purchaseRequestId,
          supplierId,
          registeredById: organizationA.userId,
          requestItemIds: itemIds,
        }),
      ).resolves.toEqual(expect.any(String));
    });
  });

  describe("BR-022 and BR-024 as partial unique indexes", () => {
    it("permits one ACTIVE quote per supplier per request", async () => {
      const { purchaseRequestId, itemIds, supplierId } =
        await quotableRequest(organizationA);
      const input = {
        purchaseRequestId,
        supplierId,
        registeredById: organizationA.userId,
        requestItemIds: itemIds,
      };

      await createSupplierQuote(database, organizationA, input);
      await expect(
        createSupplierQuote(database, organizationA, input),
      ).rejects.toThrow();

      // Withdrawing the first frees the slot, which is what FR-046 and BR-022 together mean.
      await database.supplierQuote.updateMany({
        where: { organizationId: organizationA.organizationId },
        data: { status: "WITHDRAWN", withdrawnAt: new Date() },
      });
      await expect(
        createSupplierQuote(database, organizationA, input),
      ).resolves.toEqual(expect.any(String));
    });

    it("permits one SELECTED quote per request, across suppliers", async () => {
      const request = await createPurchaseRequest(database, organizationA);
      const first = await createSupplier(database, organizationA, {
        suffix: "first",
      });
      const second = await createSupplier(database, organizationA, {
        suffix: "second",
      });

      await createSupplierQuote(
        database,
        organizationA,
        {
          purchaseRequestId: request.purchaseRequestId,
          supplierId: first,
          registeredById: organizationA.userId,
          requestItemIds: request.itemIds,
        },
        { status: "SELECTED" },
      );

      await expect(
        createSupplierQuote(
          database,
          organizationA,
          {
            purchaseRequestId: request.purchaseRequestId,
            supplierId: second,
            registeredById: organizationA.userId,
            requestItemIds: request.itemIds,
          },
          { status: "SELECTED" },
        ),
      ).rejects.toThrow();
    });

    it("refuses a selected quote with no rationale, actor or instant", async () => {
      const { purchaseRequestId, itemIds, supplierId } =
        await quotableRequest(organizationA);
      const quoteId = await createSupplierQuote(database, organizationA, {
        purchaseRequestId,
        supplierId,
        registeredById: organizationA.userId,
        requestItemIds: itemIds,
      });

      await expect(
        database.supplierQuote.update({
          where: {
            organizationId_id: {
              organizationId: organizationA.organizationId,
              id: quoteId,
            },
          },
          data: { status: "SELECTED" },
        }),
      ).rejects.toThrow(/supplier_quotes_selection_check/);
    });

    it("refuses a total that disagrees with its own parts (BR-032)", async () => {
      const { purchaseRequestId, itemIds, supplierId } =
        await quotableRequest(organizationA);
      const quoteId = await createSupplierQuote(database, organizationA, {
        purchaseRequestId,
        supplierId,
        registeredById: organizationA.userId,
        requestItemIds: itemIds,
      });

      await expect(
        database.supplierQuote.update({
          where: {
            organizationId_id: {
              organizationId: organizationA.organizationId,
              id: quoteId,
            },
          },
          data: { totalCents: 1n },
        }),
      ).rejects.toThrow(/supplier_quotes_total_identity_check/);
    });
  });

  describe("BR-020 a quote cannot outlive its request's quotation window", () => {
    it("refuses to register an ACTIVE quote once a cancellation has committed", async () => {
      // The race FR-025 makes real: a requester cancels while a buyer is registering. The
      // ordering is forced rather than hoped for — the cancellation holds the request's row
      // lock, the registration blocks on it, and only then does the cancellation commit. What
      // the registration sees when it finally acquires the lock is the state after the
      // cancellation, which is exactly the case a read-then-insert would get wrong.
      const { purchaseRequestId, itemIds, supplierId } =
        await quotableRequest(organizationA);

      let releaseCancellation = (): void => undefined;
      const cancellationReady = new Promise<void>((resolve) => {
        releaseCancellation = resolve;
      });

      const cancellation = database.$transaction(
        async (transaction) => {
          await transaction.$queryRaw`
            SELECT "id" FROM "purchase_requests"
             WHERE "organization_id" = ${organizationA.organizationId}::uuid
               AND "id" = ${purchaseRequestId}::uuid
               FOR UPDATE
          `;
          await transaction.purchaseRequest.updateMany({
            where: {
              id: purchaseRequestId,
              organizationId: organizationA.organizationId,
              status: "IN_QUOTATION",
            },
            data: { status: "CANCELLED", cancelledAt: new Date() },
          });

          // The lock is held until this resolves, which is what makes the ordering a fact
          // rather than a hope about scheduling.
          await cancellationReady;
        },
        { timeout: 20_000 },
      );

      const registration = transactions
        .run(async (scope) => {
          const locked = await purchaseRequests.lockRequestInStatuses(scope, {
            organizationId: organizationA.organizationId,
            purchaseRequestId,
            requiredStatuses: ["IN_QUOTATION"],
          });

          if (locked === null) {
            throw new Error("request is no longer quotable");
          }

          return supplierQuotes.register(scope, {
            organizationId: organizationA.organizationId,
            purchaseRequestId,
            supplierId,
            registeredById: organizationA.userId,
            freightCents: 0n,
            discountCents: 0n,
            itemsTotalCents: 100n,
            totalCents: 100n,
            validUntil: new Date("2026-12-31T00:00:00.000Z"),
            deliveryLeadTimeDays: 5,
            lines: itemIds.map((id, index) => ({
              purchaseRequestItemId: id,
              position: index + 1,
              quantityScaled: 1_000n,
              unitPriceCents: 50n,
              lineTotalCents: 50n,
            })),
          });
        })
        .then(
          () => "committed" as const,
          () => "refused" as const,
        );

      // Long enough for the registration to reach the lock and block on it.
      await new Promise((resolve) => setTimeout(resolve, 250));
      releaseCancellation();
      await cancellation;

      await expect(registration).resolves.toBe("refused");
      await expect(
        database.purchaseRequest.findUniqueOrThrow({
          where: { id: purchaseRequestId },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: "CANCELLED" });
      // The whole point: no live commercial offer against a request nobody can act on.
      await expect(
        database.supplierQuote.count({ where: { purchaseRequestId } }),
      ).resolves.toBe(0);
    }, 60_000);

    it("refuses a registration against a request that left IN_QUOTATION earlier", async () => {
      const { itemIds, supplierId } = await quotableRequest(organizationA);
      const cancelled = await createPurchaseRequest(database, organizationA, {
        status: "CANCELLED",
      });

      await expect(
        transactions.run(async (scope) => {
          const locked = await purchaseRequests.lockRequestInStatuses(scope, {
            organizationId: organizationA.organizationId,
            purchaseRequestId: cancelled.purchaseRequestId,
            requiredStatuses: ["IN_QUOTATION"],
          });

          if (locked === null) {
            throw new Error("request is no longer quotable");
          }

          return supplierQuotes.register(scope, {
            organizationId: organizationA.organizationId,
            purchaseRequestId: cancelled.purchaseRequestId,
            supplierId,
            registeredById: organizationA.userId,
            freightCents: 0n,
            discountCents: 0n,
            itemsTotalCents: 100n,
            totalCents: 100n,
            validUntil: new Date("2026-12-31T00:00:00.000Z"),
            deliveryLeadTimeDays: 5,
            lines: itemIds.map((id, index) => ({
              purchaseRequestItemId: id,
              position: index + 1,
              quantityScaled: 1_000n,
              unitPriceCents: 50n,
              lineTotalCents: 50n,
            })),
          });
        }),
      ).rejects.toThrow("request is no longer quotable");

      await expect(database.supplierQuote.count()).resolves.toBe(0);
    });

    it("proves the request's state under a lock rather than reading it", async () => {
      const cancelled = await createPurchaseRequest(database, organizationA, {
        status: "CANCELLED",
      });

      await expect(
        transactions.run((scope) =>
          purchaseRequests.lockRequestInStatuses(scope, {
            organizationId: organizationA.organizationId,
            purchaseRequestId: cancelled.purchaseRequestId,
            requiredStatuses: ["IN_QUOTATION"],
          }),
        ),
      ).resolves.toBeNull();
    });

    it("answers null for another tenant's request identifier (MT-004)", async () => {
      const foreign = await createPurchaseRequest(database, organizationB);

      await expect(
        transactions.run((scope) =>
          purchaseRequests.lockRequestInStatuses(scope, {
            organizationId: organizationA.organizationId,
            purchaseRequestId: foreign.purchaseRequestId,
            requiredStatuses: ["IN_QUOTATION"],
          }),
        ),
      ).resolves.toBeNull();
    });
  });

  describe("REL-005 concurrent quotation decisions", () => {
    async function requestWithTwoQuotes(): Promise<{
      readonly purchaseRequestId: string;
      readonly quoteIds: readonly string[];
    }> {
      const request = await createPurchaseRequest(database, organizationA);
      const quoteIds: string[] = [];

      for (const suffix of ["first", "second"]) {
        const supplierId = await createSupplier(database, organizationA, {
          suffix,
        });
        quoteIds.push(
          await createSupplierQuote(database, organizationA, {
            purchaseRequestId: request.purchaseRequestId,
            supplierId,
            registeredById: organizationA.userId,
            requestItemIds: request.itemIds,
          }),
        );
      }

      return { purchaseRequestId: request.purchaseRequestId, quoteIds };
    }

    function select(purchaseRequestId: string, supplierQuoteId: string) {
      return transactions.run((scope) =>
        supplierQuotes.select(scope, {
          organizationId: organizationA.organizationId,
          purchaseRequestId,
          supplierQuoteId,
          selectedById: organizationA.userId,
          selectedAt: new Date(),
          selectionRationale: "Lowest total of the offers received",
          validOnOrAfter: new Date("2026-06-01T00:00:00.000Z"),
        }),
      );
    }

    it("lets exactly one of two simultaneous selections win (BR-024)", async () => {
      const { purchaseRequestId, quoteIds } = await requestWithTwoQuotes();

      const results = await Promise.allSettled([
        select(purchaseRequestId, quoteIds[0] as string),
        select(purchaseRequestId, quoteIds[1] as string),
      ]);

      const winners = results.filter(
        (result) => result.status === "fulfilled" && result.value !== null,
      );
      expect(winners).toHaveLength(1);
      await expect(
        database.supplierQuote.count({
          where: { purchaseRequestId, status: "SELECTED" },
        }),
      ).resolves.toBe(1);
    });

    it("lets exactly one of a simultaneous withdrawal and selection win", async () => {
      const { purchaseRequestId, quoteIds } = await requestWithTwoQuotes();
      const contested = quoteIds[0] as string;

      const results = await Promise.allSettled([
        select(purchaseRequestId, contested),
        transactions.run((scope) =>
          supplierQuotes.withdraw(scope, {
            organizationId: organizationA.organizationId,
            purchaseRequestId,
            supplierQuoteId: contested,
            withdrawnAt: new Date(),
          }),
        ),
      ]);

      const winners = results.filter(
        (result) => result.status === "fulfilled" && result.value !== null,
      );
      expect(winners).toHaveLength(1);

      const quote = await database.supplierQuote.findUniqueOrThrow({
        where: {
          organizationId_id: {
            organizationId: organizationA.organizationId,
            id: contested,
          },
        },
        select: { status: true, selectedAt: true, withdrawnAt: true },
      });
      // Whichever won, the row is internally consistent: never both, never neither.
      expect(["SELECTED", "WITHDRAWN"]).toContain(quote.status);
      expect(quote.selectedAt === null).toBe(quote.status === "WITHDRAWN");
      expect(quote.withdrawnAt === null).toBe(quote.status === "SELECTED");
    });

    it("refuses to select an expired quote inside the write, not only in a pre-check", async () => {
      const request = await createPurchaseRequest(database, organizationA);
      const supplierId = await createSupplier(database, organizationA, {
        suffix: "expired",
      });
      const quoteId = await createSupplierQuote(
        database,
        organizationA,
        {
          purchaseRequestId: request.purchaseRequestId,
          supplierId,
          registeredById: organizationA.userId,
          requestItemIds: request.itemIds,
        },
        { validUntil: new Date("2026-01-31T00:00:00.000Z") },
      );

      await expect(
        transactions.run((scope) =>
          supplierQuotes.select(scope, {
            organizationId: organizationA.organizationId,
            purchaseRequestId: request.purchaseRequestId,
            supplierQuoteId: quoteId,
            selectedById: organizationA.userId,
            selectedAt: new Date("2026-02-01T00:00:00.000Z"),
            selectionRationale: "Lowest total of the offers received",
            validOnOrAfter: new Date("2026-02-01T00:00:00.000Z"),
          }),
        ),
      ).resolves.toBeNull();
    });

    it("selects a quote on its validity date, which BR-023 makes inclusive", async () => {
      const request = await createPurchaseRequest(database, organizationA);
      const supplierId = await createSupplier(database, organizationA, {
        suffix: "same-day",
      });
      const quoteId = await createSupplierQuote(
        database,
        organizationA,
        {
          purchaseRequestId: request.purchaseRequestId,
          supplierId,
          registeredById: organizationA.userId,
          requestItemIds: request.itemIds,
        },
        { validUntil: new Date("2026-02-01T00:00:00.000Z") },
      );

      await expect(
        transactions.run((scope) =>
          supplierQuotes.select(scope, {
            organizationId: organizationA.organizationId,
            purchaseRequestId: request.purchaseRequestId,
            supplierQuoteId: quoteId,
            selectedById: organizationA.userId,
            // Late in the day, and still the same calendar day.
            selectedAt: new Date("2026-02-01T23:30:00.000Z"),
            selectionRationale: "Lowest total of the offers received",
            validOnOrAfter: new Date("2026-02-01T23:30:00.000Z"),
          }),
        ),
      ).resolves.not.toBeNull();
    });

    it("translates BR-022's index violation into a business conflict, never a 500", async () => {
      const { purchaseRequestId, itemIds, supplierId } =
        await quotableRequest(organizationA);
      const line = {
        purchaseRequestItemId: itemIds[0] as string,
        position: 1,
        quantityScaled: 1_000n,
        unitPriceCents: 50n,
        lineTotalCents: 50n,
      };
      const input = {
        organizationId: organizationA.organizationId,
        purchaseRequestId,
        supplierId,
        registeredById: organizationA.userId,
        freightCents: 0n,
        discountCents: 0n,
        itemsTotalCents: 100n,
        totalCents: 100n,
        validUntil: new Date("2026-12-31T00:00:00.000Z"),
        deliveryLeadTimeDays: 5,
        lines: itemIds.map((id, index) => ({ ...line, purchaseRequestItemId: id, position: index + 1 })),
      };

      await transactions.run((scope) => supplierQuotes.register(scope, input));

      await expect(
        transactions.run((scope) => supplierQuotes.register(scope, input)),
      ).rejects.toBeInstanceOf(SupplierQuoteAlreadyActiveError);
    });
  });

  describe("BR-003 re-evaluation against a real ladder", () => {
    async function submittedRequestWithLadder(
      estimatedTotalCents: bigint,
    ): Promise<string> {
      const request = await createPurchaseRequest(database, organizationA, {
        quantitiesScaled: [1_000n],
        estimatedUnitPriceCents: estimatedTotalCents,
      });

      await transactions.run(async (scope) => {
        await approvalFlows.materialize(scope, {
          organizationId: organizationA.organizationId,
          purchaseRequestId: request.purchaseRequestId,
          evaluatedAmountCents: estimatedTotalCents,
        });
      });

      // The Manager decides before quotation begins (FR-032), which is the only state a quote
      // can be selected from.
      const step = await approvalFlows.findActionableStep({
        organizationId: organizationA.organizationId,
        purchaseRequestId: request.purchaseRequestId,
      });
      await transactions.run((scope) =>
        approvalFlows.decideActionableStep(scope, {
          organizationId: organizationA.organizationId,
          purchaseRequestId: request.purchaseRequestId,
          approvalStepId: (step as { id: string }).id,
          role: "MANAGER",
          decision: "APPROVED",
          decisionReason: null,
          decidedById: organizationA.userId,
          decidedAt: new Date(),
        }),
      );

      return request.purchaseRequestId;
    }

    it("appends and promotes the steps a higher selected tier requires", async () => {
      // Estimated at R$ 1,000.00 (one step). Selected at R$ 5,000.01 (three).
      const purchaseRequestId = await submittedRequestWithLadder(100_000n);
      const result = await transactions.run((scope) =>
        approvalFlows.reevaluateForSelectedQuote(scope, {
          organizationId: organizationA.organizationId,
          purchaseRequestId,
          selectedTotalCents: 500_001n,
        }),
      );

      expect(result?.changed).toBe(true);
      expect(result?.appendedStepRoles).toEqual(["PURCHASING", "FINANCE"]);
      expect(result?.actionableStep?.role).toBe("PURCHASING");
      expect(result?.flow.state).toBe("ACTIVE");
      expect(result?.flow.steps.map((step) => step.sequence)).toEqual([1, 2, 3]);
      // The Manager decision is untouched, and priced against the estimate it was made on.
      expect(result?.flow.steps[0]?.state).toBe("APPROVED");
      expect(result?.flow.steps[0]?.evaluatedAmountCents).toBe(100_000n);
      // The appended rungs carry the selected total, which is what they approve.
      expect(result?.flow.steps[1]?.evaluatedAmountCents).toBe(500_001n);
    });

    it("voids what a lower selected tier no longer requires and completes the flow", async () => {
      const purchaseRequestId = await submittedRequestWithLadder(500_001n);
      const result = await transactions.run((scope) =>
        approvalFlows.reevaluateForSelectedQuote(scope, {
          organizationId: organizationA.organizationId,
          purchaseRequestId,
          selectedTotalCents: 100_000n,
        }),
      );

      expect(result?.changed).toBe(true);
      expect(result?.voidedStepCount).toBe(2);
      expect(result?.actionableStep).toBeNull();
      expect(result?.flow.state).toBe("COMPLETED");
      expect(result?.flow.steps.map((step) => step.state)).toEqual([
        "APPROVED",
        "VOIDED",
        "VOIDED",
      ]);
    });

    it("never leaves two actionable steps, which a partial unique index also refuses", async () => {
      const purchaseRequestId = await submittedRequestWithLadder(500_001n);

      await transactions.run((scope) =>
        approvalFlows.reevaluateForSelectedQuote(scope, {
          organizationId: organizationA.organizationId,
          purchaseRequestId,
          selectedTotalCents: 500_001n,
        }),
      );

      await expect(
        database.approvalStep.count({
          where: { purchaseRequestId, state: "ACTIONABLE" },
        }),
      ).resolves.toBe(1);
    });

    it("answers null for a request with no flow, which is a broken invariant not a no-op", async () => {
      const request = await createPurchaseRequest(database, organizationA);

      await expect(
        transactions.run((scope) =>
          approvalFlows.reevaluateForSelectedQuote(scope, {
            organizationId: organizationA.organizationId,
            purchaseRequestId: request.purchaseRequestId,
            selectedTotalCents: 100_000n,
          }),
        ),
      ).resolves.toBeNull();
    });
  });

  describe("tenant-scoped reads never load a foreign row", () => {
    it("answers null for a quote identifier from another request of the same tenant", async () => {
      const own = await quotableRequest(organizationA);
      const other = await createPurchaseRequest(database, organizationA);
      const quoteId = await createSupplierQuote(database, organizationA, {
        purchaseRequestId: own.purchaseRequestId,
        supplierId: own.supplierId,
        registeredById: organizationA.userId,
        requestItemIds: own.itemIds,
      });

      await expect(
        supplierQuotes.find({
          organizationId: organizationA.organizationId,
          purchaseRequestId: other.purchaseRequestId,
          supplierQuoteId: quoteId,
        }),
      ).resolves.toBeNull();
    });

    it("answers null for another tenant's quote identifier", async () => {
      const foreign = await quotableRequest(organizationB);
      const quoteId = await createSupplierQuote(database, organizationB, {
        purchaseRequestId: foreign.purchaseRequestId,
        supplierId: foreign.supplierId,
        registeredById: organizationB.userId,
        requestItemIds: foreign.itemIds,
      });

      await expect(
        supplierQuotes.find({
          organizationId: organizationA.organizationId,
          purchaseRequestId: foreign.purchaseRequestId,
          supplierQuoteId: quoteId,
        }),
      ).resolves.toBeNull();
    });

    it("answers null for an identifier that exists nowhere", async () => {
      const own = await quotableRequest(organizationA);

      await expect(
        supplierQuotes.find({
          organizationId: organizationA.organizationId,
          purchaseRequestId: own.purchaseRequestId,
          supplierQuoteId: randomUUID(),
        }),
      ).resolves.toBeNull();
    });
  });
});

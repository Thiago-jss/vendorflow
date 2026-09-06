import { randomUUID } from "node:crypto";
import { DatabaseService } from "@vendorflow/database";
import type { PurchaseRequestListCursor } from "../../src/procurement/application/contracts/purchase-request.repository";
import { PrismaPurchaseRequestRepository } from "../../src/procurement/infrastructure/persistence/prisma-purchase-request.repository";
import {
  REQUESTER_CANCELLABLE_STATUSES,
  SUBMITTABLE_STATUSES,
} from "../../src/procurement/application/support/purchase-request-status";
import type { NormalizedPurchaseRequestDraftItem } from "../../src/procurement/application/support/purchase-request-draft";
import { createTenant, type TenantFixture } from "./identity-fixtures";
import { PostgreSqlIntegrationTestHarness } from "./postgresql-test-harness";

/**
 * A whole-unit line and a fractional one, so every assertion below exercises the decimal
 * path rather than the integer special case.
 */
const ITEMS: readonly NormalizedPurchaseRequestDraftItem[] = [
  {
    description: "Laptop, 16 GB RAM",
    unitOfMeasure: "UN",
    quantityScaled: 4_000n,
    estimatedUnitPriceCents: 549_900n,
  },
  {
    description: "Copper cable",
    unitOfMeasure: "M",
    // 1.25 x 1999 = 2498.75 centavos, which BR-033 rounds half-up to 2499.
    quantityScaled: 1_250n,
    estimatedUnitPriceCents: 1_999n,
  },
];

const FIRST_LINE_TOTAL_CENTS = 4n * 549_900n;
const SECOND_LINE_TOTAL_CENTS = 2_499n;
const ITEMS_TOTAL_CENTS = FIRST_LINE_TOTAL_CENTS + SECOND_LINE_TOTAL_CENTS;

describe("purchase request persistence tenant isolation (PostgreSQL)", () => {
  let harness: PostgreSqlIntegrationTestHarness;
  let database: DatabaseService;
  let repository: PrismaPurchaseRequestRepository;
  let organizationA: TenantFixture;
  let organizationB: TenantFixture;
  /** A second requester inside organization A: ownership is not the same rule as tenancy. */
  let colleagueOfA: { readonly id: string };

  beforeAll(async () => {
    harness = await PostgreSqlIntegrationTestHarness.start();
    database = harness.database;
    repository = new PrismaPurchaseRequestRepository(database);
  }, 180_000);

  beforeEach(async () => {
    await harness.clean();
    organizationA = await createTenant(database, { suffix: "A" });
    organizationB = await createTenant(database, { suffix: "B" });
    colleagueOfA = await database.user.create({
      data: {
        organizationId: organizationA.organizationId,
        branchId: organizationA.branchId,
        departmentId: organizationA.departmentId,
        name: "Colleague A",
        email: "colleague-a@example.com",
      },
      select: { id: true },
    });
  }, 60_000);

  afterAll(async () => {
    if (harness !== undefined) {
      await harness.stop();
    }
  });

  async function createDraftFor(
    tenant: TenantFixture,
    requesterId: string = tenant.userId,
  ) {
    return repository.createDraft({
      organizationId: tenant.organizationId,
      requesterId,
      departmentId: tenant.departmentId,
      justification: "Replacement laptops for the onboarding cohort",
      neededBy: new Date("2026-11-30T00:00:00.000Z"),
      estimatedTotalCents: ITEMS_TOTAL_CENTS,
      items: ITEMS,
    });
  }

  it("stores the backend-computed total as integer centavos and orders items by position", async () => {
    const created = await createDraftFor(organizationA);

    expect(created.status).toBe("DRAFT");
    expect(created.estimatedTotalCents).toBe(ITEMS_TOTAL_CENTS);
    expect(created.items.map((item) => item.position)).toEqual([1, 2]);
    expect(created.items[0]?.estimatedLineTotalCents).toBe(
      FIRST_LINE_TOTAL_CENTS,
    );
    // BR-033 survives the round trip: the line is recomputed from the persisted decimal.
    expect(created.items[1]?.estimatedLineTotalCents).toBe(
      SECOND_LINE_TOTAL_CENTS,
    );

    const row = await database.purchaseRequest.findUniqueOrThrow({
      where: { id: created.id },
      select: { estimatedTotalCents: true, departmentId: true, neededBy: true },
    });

    // BIGINT in PostgreSQL, bigint in Prisma: no float ever holds this value (BR-031).
    expect(row.estimatedTotalCents).toBe(ITEMS_TOTAL_CENTS);
    // BR-042: the requester's department at creation time.
    expect(row.departmentId).toBe(organizationA.departmentId);
    expect(row.neededBy.toISOString()).toBe("2026-11-30T00:00:00.000Z");
  });

  it("round-trips an exact decimal quantity through NUMERIC without drift", async () => {
    const created = await repository.createDraft({
      organizationId: organizationA.organizationId,
      requesterId: organizationA.userId,
      departmentId: organizationA.departmentId,
      justification: "Decimal fidelity",
      neededBy: new Date("2026-11-30T00:00:00.000Z"),
      estimatedTotalCents: 30n,
      items: [
        // 0.1 and 0.2 are the canonical binary-float casualties.
        {
          description: "Solvent",
          unitOfMeasure: "L",
          quantityScaled: 100n,
          estimatedUnitPriceCents: 100n,
        },
        {
          description: "Thinner",
          unitOfMeasure: "L",
          quantityScaled: 200n,
          estimatedUnitPriceCents: 100n,
        },
      ],
    });

    const reread = await repository.findOwnRequest({
      organizationId: organizationA.organizationId,
      requesterId: organizationA.userId,
      purchaseRequestId: created.id,
    });

    expect(reread?.items.map((item) => item.quantityScaled)).toEqual([
      100n,
      200n,
    ]);
    expect(reread?.items.map((item) => item.estimatedLineTotalCents)).toEqual([
      10n,
      20n,
    ]);

    const stored = await database.$queryRaw<
      Array<{ readonly quantity: string }>
    >`SELECT "quantity"::text AS "quantity" FROM "purchase_request_items"
      WHERE "purchase_request_id" = ${created.id}::uuid ORDER BY "position"`;

    // PostgreSQL keeps the declared scale, exactly.
    expect(stored.map((row) => row.quantity)).toEqual(["0.100", "0.200"]);
  });

  it("stores an amount larger than Number.MAX_SAFE_INTEGER exactly", async () => {
    // 2^53 + 1: a JSON number, or any narrowing to `number`, would return ...992.
    const beyondSafeInteger = 9_007_199_254_740_993n;
    const created = await repository.createDraft({
      organizationId: organizationA.organizationId,
      requesterId: organizationA.userId,
      departmentId: organizationA.departmentId,
      justification: "Large amount",
      neededBy: new Date("2026-11-30T00:00:00.000Z"),
      estimatedTotalCents: beyondSafeInteger,
      items: [
        {
          description: "Aircraft",
          unitOfMeasure: "UN",
          quantityScaled: 1_000n,
          estimatedUnitPriceCents: beyondSafeInteger,
        },
      ],
    });

    expect(created.estimatedTotalCents).toBe(beyondSafeInteger);
    expect(created.items[0]?.estimatedLineTotalCents).toBe(beyondSafeInteger);

    const stored = await database.$queryRaw<
      Array<{ readonly total: string }>
    >`SELECT "estimated_total_cents"::text AS "total" FROM "purchase_requests"
      WHERE "id" = ${created.id}::uuid`;

    expect(stored[0]?.total).toBe(beyondSafeInteger.toString());
  });

  it("reads an own request and treats a foreign tenant's request as absent", async () => {
    const own = await createDraftFor(organizationA);
    const foreign = await createDraftFor(organizationB);

    await expect(
      repository.findOwnRequest({
        organizationId: organizationA.organizationId,
        requesterId: organizationA.userId,
        purchaseRequestId: own.id,
      }),
    ).resolves.toMatchObject({ id: own.id });

    // Known identifier, wrong tenant. Not "forbidden" — absent (MT-004).
    await expect(
      repository.findOwnRequest({
        organizationId: organizationA.organizationId,
        requesterId: organizationA.userId,
        purchaseRequestId: foreign.id,
      }),
    ).resolves.toBeNull();

    // And the reverse direction, so the result is not an artefact of row order.
    await expect(
      repository.findOwnRequest({
        organizationId: organizationB.organizationId,
        requesterId: organizationB.userId,
        purchaseRequestId: own.id,
      }),
    ).resolves.toBeNull();
  });

  it("treats a colleague's request in the same tenant as absent", async () => {
    const colleagues = await createDraftFor(organizationA, colleagueOfA.id);

    await expect(
      repository.findOwnRequest({
        organizationId: organizationA.organizationId,
        requesterId: organizationA.userId,
        purchaseRequestId: colleagues.id,
      }),
    ).resolves.toBeNull();
  });

  it("never lists another tenant's or another requester's rows", async () => {
    const own = await createDraftFor(organizationA);
    await createDraftFor(organizationB);
    await createDraftFor(organizationA, colleagueOfA.id);

    const page = await repository.listOwnRequests({
      organizationId: organizationA.organizationId,
      requesterId: organizationA.userId,
      limit: 50,
      after: null,
    });

    expect(page.items.map((item) => item.id)).toEqual([own.id]);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]?.itemCount).toBe(2);
  });

  it("paginates deterministically without repeating or skipping a row", async () => {
    const created: Array<{ readonly id: string }> = [];

    for (let index = 0; index < 5; index += 1) {
      created.push(await createDraftFor(organizationA));
    }

    const newestFirst = [...created].reverse().map((request) => request.id);
    const seen: string[] = [];
    let cursor: PurchaseRequestListCursor | null = null;

    do {
      const page = await repository.listOwnRequests({
        organizationId: organizationA.organizationId,
        requesterId: organizationA.userId,
        limit: 2,
        after: cursor,
      });

      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(seen).toEqual(newestFirst);
  });

  it("refuses to update, submit, cancel or delete a foreign tenant's request", async () => {
    const foreign = await createDraftFor(organizationB);
    const asOrganizationA = {
      organizationId: organizationA.organizationId,
      requesterId: organizationA.userId,
      purchaseRequestId: foreign.id,
    };

    await expect(
      repository.replaceOwnDraft({
        ...asOrganizationA,
        justification: "Hijacked",
        neededBy: new Date("2026-12-31T00:00:00.000Z"),
        estimatedTotalCents: 1n,
        items: [
          {
            description: "Hijacked",
            unitOfMeasure: "UN",
            quantityScaled: 1_000n,
            estimatedUnitPriceCents: 1n,
          },
        ],
      }),
    ).resolves.toBeNull();

    await expect(
      repository.submitOwnRequest({
        ...asOrganizationA,
        submittedAt: new Date(),
        submittableStatuses: SUBMITTABLE_STATUSES,
      }),
    ).resolves.toBeNull();

    await expect(
      repository.cancelOwnRequest({
        ...asOrganizationA,
        cancelledAt: new Date(),
        cancellableStatuses: REQUESTER_CANCELLABLE_STATUSES,
      }),
    ).resolves.toBeNull();

    await expect(repository.deleteOwnDraft(asOrganizationA)).resolves.toBe(
      false,
    );

    // Untouched, in every respect.
    const unchanged = await database.purchaseRequest.findUniqueOrThrow({
      where: { id: foreign.id },
      select: { status: true, justification: true, _count: { select: { items: true } } },
    });
    expect(unchanged.status).toBe("DRAFT");
    expect(unchanged.justification).toBe(
      "Replacement laptops for the onboarding cohort",
    );
    expect(unchanged._count.items).toBe(2);
  });

  it("lets exactly one of two concurrent submissions win", async () => {
    const draft = await createDraftFor(organizationA);
    const criteria = {
      organizationId: organizationA.organizationId,
      requesterId: organizationA.userId,
      purchaseRequestId: draft.id,
      submittableStatuses: SUBMITTABLE_STATUSES,
    };

    const [first, second] = await Promise.all([
      repository.submitOwnRequest({ ...criteria, submittedAt: new Date() }),
      repository.submitOwnRequest({ ...criteria, submittedAt: new Date() }),
    ]);

    expect([first, second].filter((result) => result !== null)).toHaveLength(1);
    expect([first, second].filter((result) => result === null)).toHaveLength(1);
  });

  it("removes a draft's items with it through the declared cascade", async () => {
    const draft = await createDraftFor(organizationA);

    await expect(
      repository.deleteOwnDraft({
        organizationId: organizationA.organizationId,
        requesterId: organizationA.userId,
        purchaseRequestId: draft.id,
      }),
    ).resolves.toBe(true);

    await expect(
      database.purchaseRequestItem.count({
        where: { purchaseRequestId: draft.id },
      }),
    ).resolves.toBe(0);
  });

  it("refuses to delete a request that is no longer a draft", async () => {
    const draft = await createDraftFor(organizationA);
    await repository.submitOwnRequest({
      organizationId: organizationA.organizationId,
      requesterId: organizationA.userId,
      purchaseRequestId: draft.id,
      submittedAt: new Date(),
      submittableStatuses: SUBMITTABLE_STATUSES,
    });

    await expect(
      repository.deleteOwnDraft({
        organizationId: organizationA.organizationId,
        requesterId: organizationA.userId,
        purchaseRequestId: draft.id,
      }),
    ).resolves.toBe(false);
  });

  describe("PostgreSQL refuses a cross-tenant relationship regardless of the caller", () => {
    it("rejects a request whose requester belongs to another organization", async () => {
      await expect(
        database.purchaseRequest.create({
          data: {
            organizationId: organizationA.organizationId,
            requesterId: organizationB.userId,
            departmentId: organizationA.departmentId,
            justification: "Cross-tenant requester",
            neededBy: new Date("2026-11-30T00:00:00.000Z"),
            estimatedTotalCents: 0n,
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
    });

    it("rejects a request whose department belongs to another organization", async () => {
      await expect(
        database.purchaseRequest.create({
          data: {
            organizationId: organizationA.organizationId,
            requesterId: organizationA.userId,
            departmentId: organizationB.departmentId,
            justification: "Cross-tenant department",
            neededBy: new Date("2026-11-30T00:00:00.000Z"),
            estimatedTotalCents: 0n,
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
    });

    it("rejects an item attached to another organization's request, even from raw SQL", async () => {
      const foreign = await createDraftFor(organizationB);

      // ADR-002 verification item 9: the constraint, not the application, is what refuses
      // this. Parameterized throughout; nothing is interpolated into the statement.
      await expect(
        database.$executeRaw`
          INSERT INTO "purchase_request_items"
            ("id", "organization_id", "purchase_request_id", "position", "description",
             "unit_of_measure", "quantity", "estimated_unit_price_cents", "updated_at")
          VALUES (${randomUUID()}::uuid, ${organizationA.organizationId}::uuid,
                  ${foreign.id}::uuid, 99, 'Cross-tenant item', 'UN', 1, 100, now())
        `,
      ).rejects.toThrow(/foreign key constraint/i);
    });

    it("rejects a negative total and a non-positive quantity at the database", async () => {
      await expect(
        database.$executeRaw`
          INSERT INTO "purchase_requests"
            ("id", "organization_id", "requester_id", "department_id", "justification",
             "needed_by", "estimated_total_cents", "updated_at")
          VALUES (${randomUUID()}::uuid, ${organizationA.organizationId}::uuid,
                  ${organizationA.userId}::uuid, ${organizationA.departmentId}::uuid,
                  'Negative total', DATE '2026-11-30', -1, now())
        `,
      ).rejects.toThrow(/purchase_requests_estimated_total_cents_check/);

      const request = await createDraftFor(organizationA);

      await expect(
        database.$executeRaw`
          INSERT INTO "purchase_request_items"
            ("id", "organization_id", "purchase_request_id", "position", "description",
             "unit_of_measure", "quantity", "estimated_unit_price_cents", "updated_at")
          VALUES (${randomUUID()}::uuid, ${organizationA.organizationId}::uuid,
                  ${request.id}::uuid, 99, 'Zero quantity', 'UN', 0, 100, now())
        `,
      ).rejects.toThrow(/purchase_request_items_quantity_check/);

      await expect(
        database.$executeRaw`
          INSERT INTO "purchase_request_items"
            ("id", "organization_id", "purchase_request_id", "position", "description",
             "unit_of_measure", "quantity", "estimated_unit_price_cents", "updated_at")
          VALUES (${randomUUID()}::uuid, ${organizationA.organizationId}::uuid,
                  ${request.id}::uuid, 98, 'Negative price', 'UN', 1, -1, now())
        `,
      ).rejects.toThrow(
        /purchase_request_items_estimated_unit_price_cents_check/,
      );
    });

    it("accepts fractional quantities and rejects a scale PostgreSQL cannot keep", async () => {
      const request = await createDraftFor(organizationA);

      // The declared scale is what the column keeps; a value inside it is stored verbatim.
      await expect(
        database.$executeRaw`
          INSERT INTO "purchase_request_items"
            ("id", "organization_id", "purchase_request_id", "position", "description",
             "unit_of_measure", "quantity", "estimated_unit_price_cents", "updated_at")
          VALUES (${randomUUID()}::uuid, ${organizationA.organizationId}::uuid,
                  ${request.id}::uuid, 97, 'Fractional', 'KG', 0.125, 100, now())
        `,
      ).resolves.toBe(1);

      // Beyond the declared precision of 20 digits, PostgreSQL refuses rather than truncates
      // the integer part.
      await expect(
        database.$executeRaw`
          INSERT INTO "purchase_request_items"
            ("id", "organization_id", "purchase_request_id", "position", "description",
             "unit_of_measure", "quantity", "estimated_unit_price_cents", "updated_at")
          VALUES (${randomUUID()}::uuid, ${organizationA.organizationId}::uuid,
                  ${request.id}::uuid, 96, 'Too wide', 'KG', 999999999999999999.999, 100, now())
        `,
      ).rejects.toThrow(/numeric field overflow/i);
    });

    it("rejects a DRAFT that claims to have been submitted", async () => {
      await expect(
        database.$executeRaw`
          INSERT INTO "purchase_requests"
            ("id", "organization_id", "requester_id", "department_id", "justification",
             "needed_by", "estimated_total_cents", "status", "submitted_at", "updated_at")
          VALUES (${randomUUID()}::uuid, ${organizationA.organizationId}::uuid,
                  ${organizationA.userId}::uuid, ${organizationA.departmentId}::uuid,
                  'Impossible draft', DATE '2026-11-30', 0, 'DRAFT', now(), now())
        `,
      ).rejects.toThrow(/purchase_requests_draft_not_submitted_check/);
    });
  });
});

import { randomUUID } from "node:crypto";
import { DatabaseService } from "@vendorflow/database";
import {
  ApiIntegrationTestHarness,
  idempotencyHeaders,
  type HttpTestResponse,
} from "./api-test-harness";
import { createTenant, type TenantFixture } from "./identity-fixtures";
import { PostgreSqlIntegrationTestHarness } from "./postgresql-test-harness";

interface DraftBody {
  readonly justification: string;
  readonly neededBy: string;
  readonly items: readonly {
    readonly description: string;
    readonly unitOfMeasure: string;
    readonly quantity: string;
    readonly estimatedUnitPriceCents: string;
  }[];
}

function draftBody(overrides: Partial<DraftBody> = {}): DraftBody {
  return {
    justification: "Replacement laptops for the onboarding cohort",
    neededBy: "2026-11-30",
    items: [
      {
        description: "Laptop, 16 GB RAM",
        unitOfMeasure: "UN",
        quantity: "4",
        estimatedUnitPriceCents: "549900",
      },
      {
        description: "Docking station",
        unitOfMeasure: "UN",
        quantity: "4",
        estimatedUnitPriceCents: "89900",
      },
    ],
    ...overrides,
  };
}

// Amounts cross the API as strings: a JSON number cannot hold an exact decimal quantity, and
// cannot hold a centavo amount above 2^53 at all.
const EXPECTED_TOTAL_CENTS = (4 * 549_900 + 4 * 89_900).toString();

describe("purchase request HTTP surface (PostgreSQL)", () => {
  let postgres: PostgreSqlIntegrationTestHarness;
  let api: ApiIntegrationTestHarness;
  let database: DatabaseService;
  let organizationA: TenantFixture;
  let organizationB: TenantFixture;
  let tokenA: string;
  let tokenB: string;
  /** Authenticates perfectly well and holds no EMPLOYEE role (FR-020, AUTHZ-003). */
  let nonEmployee: TenantFixture;
  let nonEmployeeToken: string;

  beforeAll(async () => {
    postgres = await PostgreSqlIntegrationTestHarness.start();
    database = postgres.database;
    api = await ApiIntegrationTestHarness.start();
  }, 180_000);

  beforeEach(async () => {
    await postgres.clean();
    organizationA = await createTenant(database, { suffix: "A" });
    organizationB = await createTenant(database, { suffix: "B" });
    nonEmployee = await createTenant(database, {
      suffix: "NoEmployeeRole",
      roles: ["MANAGER", "BUYER", "FINANCE", "ADMIN"],
    });
    tokenA = await login(organizationA);
    tokenB = await login(organizationB);
    nonEmployeeToken = await login(nonEmployee);
  }, 60_000);

  afterAll(async () => {
    if (api !== undefined) {
      await api.stop();
    }

    if (postgres !== undefined) {
      await postgres.stop();
    }
  });

  async function login(tenant: TenantFixture): Promise<string> {
    const response = await api.post("/auth/login", {
      body: { email: tenant.email, password: tenant.password },
    });
    const body = response.body as { readonly accessToken: string };

    return body.accessToken;
  }

  async function createDraft(
    accessToken: string,
    body: DraftBody = draftBody(),
  ): Promise<{ readonly id: string; readonly response: HttpTestResponse }> {
    const response = await api.post("/purchase-requests", {
      accessToken,
      body,
    });
    const created = response.body as { readonly id: string };

    return { id: created.id, response };
  }

  describe("authentication", () => {
    it("refuses every route without an access token (default deny)", async () => {
      const id = randomUUID();

      for (const response of await Promise.all([
        api.post("/purchase-requests", { body: draftBody() }),
        api.get("/purchase-requests"),
        api.get(`/purchase-requests/${id}`),
        api.put(`/purchase-requests/${id}`, { body: draftBody() }),
        api.post(`/purchase-requests/${id}/submit`),
        api.post(`/purchase-requests/${id}/cancel`),
        api.delete(`/purchase-requests/${id}`),
      ])) {
        expect(response.status).toBe(401);
      }
    });
  });

  describe("POST /purchase-requests", () => {
    it("creates a DRAFT whose total the server computed in centavos", async () => {
      const { response } = await createDraft(tokenA);

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        status: "DRAFT",
        requesterId: organizationA.userId,
        departmentId: organizationA.departmentId,
        neededBy: "2026-11-30",
        estimatedTotalCents: EXPECTED_TOTAL_CENTS,
        submittedAt: null,
        cancelledAt: null,
        items: [
          expect.objectContaining({
            position: 1,
            description: "Laptop, 16 GB RAM",
            quantity: "4.000",
            estimatedUnitPriceCents: "549900",
            estimatedLineTotalCents: (4 * 549_900).toString(),
          }),
          expect.objectContaining({ position: 2 }),
        ],
      });
    });

    it("accepts fractional quantities and rounds each line half-up once (BR-033)", async () => {
      const response = await api.post("/purchase-requests", {
        accessToken: tokenA,
        body: draftBody({
          items: [
            // 1.25 x 1999 = 2498.75 -> 2499
            {
              description: "Copper cable",
              unitOfMeasure: "M",
              quantity: "1.25",
              estimatedUnitPriceCents: "1999",
            },
            // 0.005 x 100 = 0.5 -> 1, twice. Summing first would give 1, not 2.
            {
              description: "Pigment",
              unitOfMeasure: "KG",
              quantity: "0.005",
              estimatedUnitPriceCents: "100",
            },
            {
              description: "Pigment, second batch",
              unitOfMeasure: "KG",
              quantity: "0.005",
              estimatedUnitPriceCents: "100",
            },
          ],
        }),
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        estimatedTotalCents: "2501",
        items: [
          expect.objectContaining({
            quantity: "1.250",
            estimatedLineTotalCents: "2499",
          }),
          expect.objectContaining({
            quantity: "0.005",
            estimatedLineTotalCents: "1",
          }),
          expect.objectContaining({ estimatedLineTotalCents: "1" }),
        ],
      });
      // No representation of 0.005 or 1.25 anywhere in the response went through a double.
      expect(response.rawBody).not.toContain("0.004999");
      expect(response.rawBody).not.toContain("1.2500000");
    });

    it("keeps an amount larger than Number.MAX_SAFE_INTEGER exact end to end", async () => {
      // 2^53 + 1 centavos. As a JSON number this would come back as ...992.
      const beyondSafeInteger = "9007199254740993";
      const response = await api.post("/purchase-requests", {
        accessToken: tokenA,
        body: draftBody({
          items: [
            {
              description: "Aircraft",
              unitOfMeasure: "UN",
              quantity: "1",
              estimatedUnitPriceCents: beyondSafeInteger,
            },
          ],
        }),
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        estimatedTotalCents: beyondSafeInteger,
        items: [
          expect.objectContaining({
            estimatedUnitPriceCents: beyondSafeInteger,
            estimatedLineTotalCents: beyondSafeInteger,
          }),
        ],
      });
      // The digits survive in the raw payload, not only after a lossy JSON.parse.
      expect(response.rawBody).toContain(`"${beyondSafeInteger}"`);
      expect(response.rawBody).not.toContain("9007199254740992");
    });

    it("rejects a body that tries to supply server-owned authority (SEC-004)", async () => {
      const forbiddenFields: readonly Record<string, unknown>[] = [
        { organizationId: organizationB.organizationId },
        { requesterId: organizationB.userId },
        { departmentId: organizationB.departmentId },
        { status: "APPROVED" },
        { estimatedTotalCents: "1" },
        // A role supplied in the body is data, not authority: roles come from user_roles.
        { roles: ["EMPLOYEE"] },
        { userId: organizationB.userId },
        { items: [{ ...draftBody().items[0], position: 7 }] },
      ];

      for (const field of forbiddenFields) {
        const response = await api.post("/purchase-requests", {
          accessToken: tokenA,
          body: { ...draftBody(), ...field },
        });

        expect(response.status).toBe(400);
      }

      await expect(database.purchaseRequest.count()).resolves.toBe(0);
    });

    it("rejects a malformed payload at the boundary, before the domain sees it", async () => {
      for (const body of [
        draftBody({ items: [] }),
        draftBody({ justification: "" }),
        draftBody({ neededBy: "30/11/2026" }),
        draftBody({
          items: [{ ...draftBody().items[0]!, quantity: "-2.5" }],
        }),
        draftBody({
          items: [{ ...draftBody().items[0]!, quantity: "1e3" }],
        }),
        draftBody({
          items: [{ ...draftBody().items[0]!, quantity: "" }],
        }),
        draftBody({
          items: [{ ...draftBody().items[0]!, estimatedUnitPriceCents: "-1" }],
        }),
        draftBody({
          items: [{ ...draftBody().items[0]!, estimatedUnitPriceCents: "1.5" }],
        }),
      ]) {
        const response = await api.post("/purchase-requests", {
          accessToken: tokenA,
          body,
        });

        expect(response.status).toBe(400);
      }

      await expect(database.purchaseRequest.count()).resolves.toBe(0);
    });

    it("rejects a quantity wider than storage with 422 and no driver error", async () => {
      const response = await api.post("/purchase-requests", {
        accessToken: tokenA,
        body: draftBody({
          items: [
            {
              description: "Absurd quantity",
              unitOfMeasure: "UN",
              quantity: "100000000000000000.000",
              // A zero unit price makes the request total 0, so the amount check cannot
              // catch this: only the quantity rule stands between the payload and a
              // PostgreSQL numeric overflow.
              estimatedUnitPriceCents: "0",
            },
          ],
        }),
      });

      expect(response.status).toBe(422);
      expect(response.body).toEqual({
        statusCode: 422,
        message:
          "An item quantity may not exceed 99999999999999999.999, the largest quantity this system stores exactly",
      });
      await expect(database.purchaseRequest.count()).resolves.toBe(0);

      // The refusal is a domain answer, not a leaked persistence failure.
      for (const leak of [
        "numeric field overflow",
        "Prisma",
        "prisma",
        "PostgreSQL",
        "P2000",
        "invocation",
      ]) {
        expect(response.rawBody).not.toContain(leak);
      }

      // The largest storable quantity is accepted, so the boundary is exactly the column's.
      const accepted = await api.post("/purchase-requests", {
        accessToken: tokenA,
        body: draftBody({
          items: [
            {
              description: "Enormous but storable",
              unitOfMeasure: "UN",
              quantity: "99999999999999999.999",
              estimatedUnitPriceCents: "0",
            },
          ],
        }),
      });

      expect(accepted.status).toBe(201);
      expect(accepted.body).toMatchObject({
        estimatedTotalCents: "0",
        items: [expect.objectContaining({ quantity: "99999999999999999.999" })],
      });
    });

    it("rejects a well-formed quantity that BR-012 refuses with 422, not 400", async () => {
      // "0" is a perfectly valid decimal representation; it is the business rule that
      // refuses it, so the two failures are not conflated.
      const response = await api.post("/purchase-requests", {
        accessToken: tokenA,
        body: draftBody({
          items: [{ ...draftBody().items[0]!, quantity: "0" }],
        }),
      });

      expect(response.status).toBe(422);
      await expect(database.purchaseRequest.count()).resolves.toBe(0);
    });

    it("rejects a needed-by value that is well formed but not a real date", async () => {
      const response = await api.post("/purchase-requests", {
        accessToken: tokenA,
        body: draftBody({ neededBy: "2026-02-30" }),
      });

      // Shape is fine, so the pipe lets it through; the domain rule refuses it.
      expect(response.status).toBe(422);
    });

    it("rejects more quantity precision than the system keeps, rather than rounding it", async () => {
      const response = await api.post("/purchase-requests", {
        accessToken: tokenA,
        body: draftBody({
          items: [{ ...draftBody().items[0]!, quantity: "1.2345" }],
        }),
      });

      // A representation the wire format does not define, so it is refused at the boundary.
      expect(response.status).toBe(400);
      await expect(database.purchaseRequest.count()).resolves.toBe(0);

      // And the boundary keeps the precision it does define.
      const accepted = await api.post("/purchase-requests", {
        accessToken: tokenA,
        body: draftBody({
          items: [{ ...draftBody().items[0]!, quantity: "1.234" }],
        }),
      });
      expect(accepted.status).toBe(201);
    });
  });

  describe("creation authorization (FR-020)", () => {
    it("lets a principal holding EMPLOYEE create", async () => {
      const { response } = await createDraft(tokenA);

      expect(response.status).toBe(201);
      await expect(database.purchaseRequest.count()).resolves.toBe(1);
    });

    it("refuses a principal that authenticated without EMPLOYEE, and writes nothing", async () => {
      const response = await api.post("/purchase-requests", {
        accessToken: nonEmployeeToken,
        body: draftBody(),
      });

      expect(response.status).toBe(403);
      // The refusal names no resource and no role, so it confirms nothing.
      expect(response.body).toEqual({
        statusCode: 403,
        message: "Not allowed to perform this action",
      });
      await expect(database.purchaseRequest.count()).resolves.toBe(0);
    });

    it("cannot be bypassed by a role, user or organization field in the body", async () => {
      for (const field of [
        { roles: ["EMPLOYEE"] },
        { role: "EMPLOYEE" },
        { requesterId: organizationA.userId },
        { organizationId: organizationA.organizationId },
      ]) {
        const response = await api.post("/purchase-requests", {
          accessToken: nonEmployeeToken,
          body: { ...draftBody(), ...field },
        });

        // Rejected by the closed-world DTO before authorization is even consulted; either
        // way nothing is created.
        expect([400, 403]).toContain(response.status);
      }

      await expect(database.purchaseRequest.count()).resolves.toBe(0);
    });

    it("does not revoke a role change retroactively: a non-EMPLOYEE still owns their request", async () => {
      // Raised while the principal still held EMPLOYEE; the role has since been removed.
      const existing = await database.purchaseRequest.create({
        data: {
          organizationId: nonEmployee.organizationId,
          requesterId: nonEmployee.userId,
          departmentId: nonEmployee.departmentId,
          justification: "Raised before the role changed",
          neededBy: new Date("2026-11-30T00:00:00.000Z"),
          estimatedTotalCents: 1_000n,
          items: {
            create: [
              {
                position: 1,
                description: "Stationery",
                unitOfMeasure: "UN",
                quantity: "10.000",
                estimatedUnitPriceCents: 100n,
              },
            ],
          },
        },
        select: { id: true },
      });

      const read = await api.get(`/purchase-requests/${existing.id}`, {
        accessToken: nonEmployeeToken,
      });
      expect(read.status).toBe(200);

      const submitted = await api.post(
        `/purchase-requests/${existing.id}/submit`,
        { headers: idempotencyHeaders(), accessToken: nonEmployeeToken },
      );
      expect(submitted.status).toBe(200);

      const cancelled = await api.post(
        `/purchase-requests/${existing.id}/cancel`,
        { accessToken: nonEmployeeToken },
      );
      expect(cancelled.status).toBe(200);
    });
  });

  describe("the requester lifecycle", () => {
    it("moves DRAFT to SUBMITTED and then refuses every edit (FR-023)", async () => {
      const { id } = await createDraft(tokenA);

      const submitted = await api.post(`/purchase-requests/${id}/submit`, {
        headers: idempotencyHeaders(),
        accessToken: tokenA,
      });
      expect(submitted.status).toBe(200);
      expect(submitted.body).toMatchObject({
        status: "SUBMITTED",
        submittedAt: expect.any(String),
        estimatedTotalCents: EXPECTED_TOTAL_CENTS,
      });

      const edited = await api.put(`/purchase-requests/${id}`, {
        accessToken: tokenA,
        body: draftBody({ justification: "Changed my mind" }),
      });
      expect(edited.status).toBe(409);

      const deleted = await api.delete(`/purchase-requests/${id}`, {
        accessToken: tokenA,
      });
      expect(deleted.status).toBe(409);

      const resubmitted = await api.post(`/purchase-requests/${id}/submit`, {
        headers: idempotencyHeaders(),
        accessToken: tokenA,
      });
      expect(resubmitted.status).toBe(409);

      const stored = await database.purchaseRequest.findUniqueOrThrow({
        where: { id },
        select: { justification: true, status: true },
      });
      expect(stored.status).toBe("SUBMITTED");
      expect(stored.justification).toBe(
        "Replacement laptops for the onboarding cohort",
      );
    });

    it("replaces a draft's content and recomputes the total (FR-022, BR-032)", async () => {
      const { id } = await createDraft(tokenA);

      const response = await api.put(`/purchase-requests/${id}`, {
        accessToken: tokenA,
        body: draftBody({
          justification: "Two chairs instead",
          neededBy: "2026-12-15",
          items: [
            {
              description: "Ergonomic chair",
              unitOfMeasure: "UN",
              quantity: "2",
              estimatedUnitPriceCents: "120000",
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: "DRAFT",
        justification: "Two chairs instead",
        neededBy: "2026-12-15",
        estimatedTotalCents: "240000",
        items: [expect.objectContaining({ position: 1, quantity: "2.000" })],
      });

      // The replaced lines are gone, not orphaned.
      await expect(
        database.purchaseRequestItem.count({
          where: { purchaseRequestId: id },
        }),
      ).resolves.toBe(1);
    });

    it("cancels from DRAFT and from SUBMITTED, and never twice (FR-025)", async () => {
      const fromDraft = await createDraft(tokenA);
      const cancelledDraft = await api.post(
        `/purchase-requests/${fromDraft.id}/cancel`,
        { accessToken: tokenA },
      );
      expect(cancelledDraft.status).toBe(200);
      expect(cancelledDraft.body).toMatchObject({
        status: "CANCELLED",
        cancelledAt: expect.any(String),
      });

      const fromSubmitted = await createDraft(tokenA);
      await api.post(`/purchase-requests/${fromSubmitted.id}/submit`, {
        headers: idempotencyHeaders(),
        accessToken: tokenA,
      });
      const cancelledSubmitted = await api.post(
        `/purchase-requests/${fromSubmitted.id}/cancel`,
        { accessToken: tokenA },
      );
      expect(cancelledSubmitted.status).toBe(200);

      const again = await api.post(
        `/purchase-requests/${fromDraft.id}/cancel`,
        {
          accessToken: tokenA,
        },
      );
      expect(again.status).toBe(409);
    });

    it("deletes a draft and leaves nothing behind (FR-022)", async () => {
      const { id } = await createDraft(tokenA);

      const deleted = await api.delete(`/purchase-requests/${id}`, {
        accessToken: tokenA,
      });
      expect(deleted.status).toBe(204);
      expect(deleted.rawBody).toBe("");

      const afterwards = await api.get(`/purchase-requests/${id}`, {
        accessToken: tokenA,
      });
      expect(afterwards.status).toBe(404);
      await expect(database.purchaseRequestItem.count()).resolves.toBe(0);
    });
  });

  describe("object-level authorization", () => {
    it("answers a foreign tenant's identifier exactly as it answers an unknown one", async () => {
      const { id } = await createDraft(tokenA);
      const unknownId = randomUUID();

      for (const target of [id, unknownId]) {
        const read = await api.get(`/purchase-requests/${target}`, {
          accessToken: tokenB,
        });
        const edited = await api.put(`/purchase-requests/${target}`, {
          accessToken: tokenB,
          body: draftBody(),
        });
        const submitted = await api.post(
          `/purchase-requests/${target}/submit`,
          { headers: idempotencyHeaders(), accessToken: tokenB },
        );
        const cancelled = await api.post(
          `/purchase-requests/${target}/cancel`,
          { accessToken: tokenB },
        );
        const deleted = await api.delete(`/purchase-requests/${target}`, {
          accessToken: tokenB,
        });

        for (const response of [read, edited, submitted, cancelled, deleted]) {
          expect(response.status).toBe(404);
          // Same status and same body: the response cannot be used to tell a foreign row
          // from a missing one (MT-004).
          expect(response.body).toEqual({
            statusCode: 404,
            message: "Not Found",
          });
        }
      }

      const untouched = await database.purchaseRequest.findUniqueOrThrow({
        where: { id },
        select: { status: true },
      });
      expect(untouched.status).toBe("DRAFT");
    });
  });

  describe("GET /purchase-requests", () => {
    it("paginates, orders newest first and never leaks another tenant", async () => {
      const mine: string[] = [];

      for (let index = 0; index < 3; index += 1) {
        mine.push((await createDraft(tokenA)).id);
      }

      const foreign = await createDraft(tokenB);

      const firstPage = await api.get("/purchase-requests?limit=2", {
        accessToken: tokenA,
      });
      expect(firstPage.status).toBe(200);
      const first = firstPage.body as {
        readonly items: readonly { readonly id: string }[];
        readonly nextCursor: string;
      };
      expect(first.items.map((item) => item.id)).toEqual(
        [...mine].reverse().slice(0, 2),
      );
      expect(first.nextCursor).toEqual(expect.any(String));

      const secondPage = await api.get(
        `/purchase-requests?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
        { accessToken: tokenA },
      );
      const second = secondPage.body as {
        readonly items: readonly { readonly id: string }[];
        readonly nextCursor: string | null;
      };
      expect(second.items.map((item) => item.id)).toEqual([mine[0]]);
      expect(second.nextCursor).toBeNull();

      // Nothing of organization B appears on any page of organization A.
      expect(
        [...first.items, ...second.items].map((item) => item.id),
      ).not.toContain(foreign.id);
    });

    it("returns summaries without the justification or the item lines", async () => {
      await createDraft(tokenA);

      const response = await api.get("/purchase-requests", {
        accessToken: tokenA,
      });
      const body = response.body as {
        readonly items: readonly Record<string, unknown>[];
      };

      expect(Object.keys(body.items[0] ?? {}).sort()).toEqual([
        "cancelledAt",
        "createdAt",
        "estimatedTotalCents",
        "id",
        "itemCount",
        "neededBy",
        "status",
        "submittedAt",
        "updatedAt",
      ]);
    });

    it("bounds the page size and rejects an unusable cursor (NFR-004)", async () => {
      await createDraft(tokenA);

      const tooLarge = await api.get("/purchase-requests?limit=101", {
        accessToken: tokenA,
      });
      expect(tooLarge.status).toBe(400);

      const unknownParameter = await api.get("/purchase-requests?all=true", {
        accessToken: tokenA,
      });
      expect(unknownParameter.status).toBe(400);

      const badCursor = await api.get(
        "/purchase-requests?cursor=not-a-cursor",
        {
          accessToken: tokenA,
        },
      );
      expect(badCursor.status).toBe(400);
    });
  });
});

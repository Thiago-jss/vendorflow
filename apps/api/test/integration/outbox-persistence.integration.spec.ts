import { randomUUID } from "node:crypto";
import { DatabaseService } from "@vendorflow/database";
import {
  ApiIntegrationTestHarness,
  idempotencyHeaders,
} from "./api-test-harness";
import {
  createTenant,
  createUser,
  type TenantFixture,
  type UserFixture,
} from "./identity-fixtures";
import { PostgreSqlIntegrationTestHarness } from "./postgresql-test-harness";

/** R$ 1,000.00: the tier whose ladder is one MANAGER step, which is the one that can decide. */
const TIER_ONE_CENTS = "100000";

const JUSTIFICATION = "Replacement laptops for the onboarding cohort";
const REJECTION_REASON = "Budget for this quarter is already committed";

function draftBody(estimatedUnitPriceCents = TIER_ONE_CENTS) {
  return {
    justification: JUSTIFICATION,
    neededBy: "2026-11-30",
    items: [
      {
        description: "Laptop, 16 GB RAM",
        unitOfMeasure: "UN",
        quantity: "1",
        estimatedUnitPriceCents,
      },
    ],
  };
}

/**
 * REL-002 against real PostgreSQL, through the real HTTP application.
 *
 * The point of testing this end to end rather than at the repository is that the guarantee is
 * about a *transaction*, and a transaction is exactly what a mocked persistence layer cannot
 * have. Everything here asks the same question in different ways: does the committed intent
 * appear exactly when the business change does, and never otherwise?
 */
describe("transactional outbox (PostgreSQL)", () => {
  let postgres: PostgreSqlIntegrationTestHarness;
  let api: ApiIntegrationTestHarness;
  let database: DatabaseService;

  let requester: TenantFixture;
  let manager: UserFixture;
  let foreignManager: TenantFixture;
  let requesterToken: string;
  let managerToken: string;

  beforeAll(async () => {
    postgres = await PostgreSqlIntegrationTestHarness.start();
    database = postgres.database;
    api = await ApiIntegrationTestHarness.start();
  }, 180_000);

  beforeEach(async () => {
    await postgres.clean();

    requester = await createTenant(database, {
      suffix: "OutboxA",
      roles: ["EMPLOYEE"],
    });
    manager = await createUser(database, {
      organizationId: requester.organizationId,
      branchId: requester.branchId,
      departmentId: requester.departmentId,
      suffix: "OutboxManager",
      roles: ["MANAGER"],
    });
    foreignManager = await createTenant(database, {
      suffix: "OutboxB",
      roles: ["EMPLOYEE", "MANAGER"],
    });

    requesterToken = await login(requester);
    managerToken = await login(manager);
  }, 120_000);

  afterAll(async () => {
    if (api !== undefined) {
      await api.stop();
    }

    if (postgres !== undefined) {
      await postgres.stop();
    }
  });

  async function login(account: {
    readonly email: string;
    readonly password: string;
  }): Promise<string> {
    const response = await api.post("/auth/login", {
      body: { email: account.email, password: account.password },
    });

    return (response.body as { readonly accessToken: string }).accessToken;
  }

  async function submit(): Promise<{
    readonly purchaseRequestId: string;
    readonly correlationId: string;
  }> {
    const created = await api.post("/purchase-requests", {
      accessToken: requesterToken,
      body: draftBody(),
    });
    expect(created.status).toBe(201);

    const { id } = created.body as { readonly id: string };
    const submitted = await api.post(`/purchase-requests/${id}/submit`, {
      headers: idempotencyHeaders(),
      accessToken: requesterToken,
    });
    expect(submitted.status).toBe(200);

    return {
      purchaseRequestId: id,
      correlationId: submitted.headers["x-correlation-id"] ?? "",
    };
  }

  describe("committed intent", () => {
    it("writes exactly one claimable row for a submission, with the request's coordinates", async () => {
      const { purchaseRequestId, correlationId } = await submit();
      const messages = await database.outboxMessage.findMany({
        where: { organizationId: requester.organizationId },
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        organizationId: requester.organizationId,
        eventType: "PURCHASE_REQUEST_SUBMITTED",
        aggregateType: "PURCHASE_REQUEST",
        aggregateId: purchaseRequestId,
        schemaVersion: 1,
        status: "PENDING",
        attemptCount: 0,
        leasedBy: null,
        leaseExpiresAt: null,
        publishedAt: null,
        lastError: null,
      });
      // Claimable immediately: a committed intent does not wait for a backoff it never earned.
      expect(messages[0]?.nextAttemptAt.getTime()).toBeLessThanOrEqual(
        Date.now(),
      );
      expect(messages[0]?.correlationId).toBe(correlationId);
    });

    it("carries the same correlation identifier the caller was told about (NFR-008)", async () => {
      const { correlationId } = await submit();

      expect(correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      const message = await database.outboxMessage.findFirstOrThrow({
        where: { organizationId: requester.organizationId },
      });

      expect(message.correlationId).toBe(correlationId);
    });

    it("writes one row for a decision and never repeats the decision reason", async () => {
      const { purchaseRequestId } = await submit();
      const decided = await api.post(
        `/purchase-requests/${purchaseRequestId}/approval-decision`,
        {
          headers: idempotencyHeaders(),
          accessToken: managerToken,
          body: { decision: "REJECTED", reason: REJECTION_REASON },
        },
      );
      expect(decided.status).toBe(200);

      const messages = await database.outboxMessage.findMany({
        where: { organizationId: requester.organizationId },
        orderBy: { createdAt: "asc" },
      });

      expect(messages.map((message) => message.eventType)).toEqual([
        "PURCHASE_REQUEST_SUBMITTED",
        "PURCHASE_REQUEST_APPROVAL_DECIDED",
      ]);

      const decision = messages[1];
      expect(decision).toMatchObject({
        aggregateId: purchaseRequestId,
        status: "PENDING",
      });
      expect(decision?.payload).toMatchObject({
        decision: "REJECTED",
        resultingStatus: "REJECTED",
        approvalFlowState: "REJECTED",
        evaluatedAmountCents: TIER_ONE_CENTS,
        decidedById: manager.userId,
        requesterId: requester.userId,
      });

      // The reason exists — in the audit trail, where it is tenant-scoped and access
      // controlled — and it is deliberately absent from the copy that leaves the process.
      const serialized = JSON.stringify(decision?.payload);
      expect(serialized).not.toContain(REJECTION_REASON);
      expect(serialized).not.toContain(JUSTIFICATION);

      const auditEvent = await database.auditEvent.findFirstOrThrow({
        where: { eventType: "APPROVAL_STEP_REJECTED" },
      });
      expect(JSON.stringify(auditEvent.payload)).toContain(REJECTION_REASON);
    });

    it("keeps money out of JSON numbers (BR-031)", async () => {
      await submit();
      const message = await database.outboxMessage.findFirstOrThrow({
        where: { eventType: "PURCHASE_REQUEST_SUBMITTED" },
      });

      expect(
        (message.payload as Record<string, unknown>).estimatedTotalCents,
      ).toBe(TIER_ONE_CENTS);
    });
  });

  describe("a rolled-back transition leaves nothing behind", () => {
    it("records no second intent when a repeated submission loses the race", async () => {
      const { purchaseRequestId } = await submit();
      const repeated = await api.post(
        `/purchase-requests/${purchaseRequestId}/submit`,
        { headers: idempotencyHeaders(), accessToken: requesterToken },
      );

      expect(repeated.status).toBe(409);
      expect(
        await database.outboxMessage.count({
          where: { aggregateId: purchaseRequestId },
        }),
      ).toBe(1);
    });

    it("records nothing when a decision is refused before it can be written", async () => {
      const { purchaseRequestId } = await submit();
      const refused = await api.post(
        `/purchase-requests/${purchaseRequestId}/approval-decision`,
        {
          headers: idempotencyHeaders(),
          accessToken: managerToken,
          // FR-031's ten-character minimum. Refused at the boundary, so no transaction opens.
          body: { decision: "REJECTED", reason: "no" },
        },
      );

      expect(refused.status).toBe(422);
      expect(
        await database.outboxMessage.count({
          where: { aggregateId: purchaseRequestId },
        }),
      ).toBe(1);
      expect(
        await database.auditEvent.count({
          where: { aggregateId: purchaseRequestId },
        }),
      ).toBe(1);
    });

    it("records nothing for a decision by a manager of another tenant", async () => {
      const { purchaseRequestId } = await submit();
      const foreignToken = await login(foreignManager);
      const refused = await api.post(
        `/purchase-requests/${purchaseRequestId}/approval-decision`,
        {
          headers: idempotencyHeaders(),
          accessToken: foreignToken,
          body: { decision: "APPROVED" },
        },
      );

      expect(refused.status).toBe(404);
      expect(
        await database.outboxMessage.count({
          where: { organizationId: foreignManager.organizationId },
        }),
      ).toBe(0);
      expect(
        await database.outboxMessage.count({
          where: { aggregateId: purchaseRequestId },
        }),
      ).toBe(1);
    });
  });

  describe("tenant isolation", () => {
    it("cannot be reached through another organization's identity", async () => {
      const { purchaseRequestId } = await submit();
      const message = await database.outboxMessage.findFirstOrThrow({
        where: { aggregateId: purchaseRequestId },
      });

      const foreign = await database.outboxMessage.findUnique({
        where: {
          organizationId_id: {
            organizationId: foreignManager.organizationId,
            id: message.id,
          },
        },
      });

      expect(foreign).toBeNull();
    });

    it("refuses a row belonging to no organization", async () => {
      await expect(
        database.$executeRaw`
          INSERT INTO "outbox_messages"
            ("organization_id", "event_type", "aggregate_type", "aggregate_id",
             "correlation_id", "occurred_at", "payload", "updated_at")
          VALUES (${randomUUID()}::uuid, 'PURCHASE_REQUEST_SUBMITTED', 'PURCHASE_REQUEST',
                  ${randomUUID()}::uuid, ${randomUUID()}::uuid, now(), '{}'::jsonb, now())
        `,
      ).rejects.toThrow();
    });
  });

  describe("the lifecycle is a database invariant, not a relay convention", () => {
    async function insertPending(): Promise<string> {
      await submit();
      const message = await database.outboxMessage.findFirstOrThrow({
        where: { organizationId: requester.organizationId },
      });

      return message.id;
    }

    it("refuses a PENDING row that still holds a lease", async () => {
      const id = await insertPending();

      await expect(
        database.$executeRaw`
          UPDATE "outbox_messages"
          SET "leased_by" = 'relay-1', "lease_expires_at" = now() + interval '30 seconds'
          WHERE "id" = ${id}::uuid
        `,
      ).rejects.toThrow(/outbox_messages_status_check/);
    });

    it("refuses a PUBLISHING row with no lease to expire", async () => {
      const id = await insertPending();

      await expect(
        database.$executeRaw`
          UPDATE "outbox_messages"
          SET "status" = 'PUBLISHING'::"outbox_message_status"
          WHERE "id" = ${id}::uuid
        `,
      ).rejects.toThrow(/outbox_messages_status_check/);
    });

    it("refuses a PUBLISHED row with no publication timestamp", async () => {
      const id = await insertPending();

      await expect(
        database.$executeRaw`
          UPDATE "outbox_messages"
          SET "status" = 'PUBLISHED'::"outbox_message_status"
          WHERE "id" = ${id}::uuid
        `,
      ).rejects.toThrow(/outbox_messages_status_check/);
    });

    it("refuses a negative attempt counter", async () => {
      const id = await insertPending();

      await expect(
        database.$executeRaw`
          UPDATE "outbox_messages" SET "attempt_count" = -1 WHERE "id" = ${id}::uuid
        `,
      ).rejects.toThrow(/outbox_messages_attempt_count_check/);
    });

    it("is mutable operational state, unlike the audit trail", async () => {
      const id = await insertPending();

      // The relay rewrites these columns for the life of a row. The audit trail refuses the
      // same operation from any caller; the difference is deliberate and is what keeps the
      // two from being confused for one another (AUD-003).
      await expect(
        database.$executeRaw`
          UPDATE "outbox_messages"
          SET "status" = 'PUBLISHED'::"outbox_message_status", "published_at" = now()
          WHERE "id" = ${id}::uuid
        `,
      ).resolves.toBe(1);

      const auditEvent = await database.auditEvent.findFirstOrThrow({
        where: { organizationId: requester.organizationId },
      });
      await expect(
        database.$executeRaw`
          UPDATE "audit_events" SET "sequence" = 99 WHERE "id" = ${auditEvent.id}::uuid
        `,
      ).rejects.toThrow(/append-only/);
    });
  });
});

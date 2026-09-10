import { randomUUID } from "node:crypto";
import { DatabaseService } from "@vendorflow/database";
import {
  IdempotencyKeyConflictError,
  IdempotencyReservationConflictError,
} from "../../src/platform/idempotency/application/contracts/idempotency.errors";
import type { IdempotencyOutcome } from "../../src/platform/idempotency/application/contracts/idempotent-operation";
import { ExecuteIdempotently } from "../../src/platform/idempotency/application/use-cases/execute-idempotently";
import { PrismaIdempotencyRecordRepository } from "../../src/platform/idempotency/infrastructure/persistence/prisma-idempotency-record.repository";
import {
  PrismaTransactionRunner,
  transactionClient,
} from "../../src/platform/persistence/prisma-transaction-runner";
import type { TransactionScope } from "../../src/platform/persistence/transaction-scope";
import type { TrustedPrincipal } from "../../src/platform/tenancy/trusted-principal";
import { createTenant, createUser, type TenantFixture } from "./identity-fixtures";
import { PostgreSqlIntegrationTestHarness } from "./postgresql-test-harness";
import { createPurchaseRequest, createSupplier } from "./quotation-fixtures";

const KEY = "idempotency-key-0000000000000001";

/**
 * REL-004 against a real PostgreSQL.
 *
 * The properties under test are all properties of the database: a unique index that two
 * concurrent transactions cannot both satisfy, a deferred constraint trigger that refuses to
 * commit a reservation with no outcome, and the fact that a rolled-back business transaction
 * leaves no record for a later retry to replay.
 *
 * The business effect is stood in for by an ordinary insert — a supplier — because what is
 * being proven is the wrapper, not any one operation it wraps. A duplicated supplier row is as
 * good a witness to a duplicated effect as a duplicated purchase order, and far cheaper to set
 * up.
 */
describe("client idempotency persistence (PostgreSQL)", () => {
  let harness: PostgreSqlIntegrationTestHarness;
  let database: DatabaseService;
  let transactions: PrismaTransactionRunner;
  let records: PrismaIdempotencyRecordRepository;
  let executeIdempotently: ExecuteIdempotently;
  let organizationA: TenantFixture;
  let organizationB: TenantFixture;

  beforeAll(async () => {
    harness = await PostgreSqlIntegrationTestHarness.start();
    database = harness.database;
    transactions = new PrismaTransactionRunner(database);
    records = new PrismaIdempotencyRecordRepository(database);
    executeIdempotently = new ExecuteIdempotently(records, transactions);
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

  function principalOf(tenant: TenantFixture, userId?: string): TrustedPrincipal {
    return {
      userId: userId ?? tenant.userId,
      organizationId: tenant.organizationId,
      roles: ["BUYER"],
    };
  }

  /**
   * One durable effect, with a counter beside it so a second execution is observable rather
   * than merely improbable.
   */
  function registerSupplierOnce(
    tenant: TenantFixture,
    suffix: string,
    counters: { executions: number },
  ) {
    return {
      async run(scope: TransactionScope): Promise<{
        value: string;
        outcome: IdempotencyOutcome;
      }> {
        counters.executions += 1;

        // The same seam a persistence adapter uses. Application code cannot do this — that is
        // what makes `TransactionScope` opaque — but a test standing in for an adapter can.
        const created = await transactionClient(scope).supplier.create({
          data: {
            organizationId: tenant.organizationId,
            legalName: `Supplier ${suffix} Ltda`,
            tradeName: `Supplier ${suffix}`,
            taxIdentifierType: "OTHER",
            taxIdentifier: `VF-${suffix}`,
            taxIdentifierNormalized: `VF${suffix.toUpperCase()}`,
            contactEmail: `supplier-${suffix}@example.com`,
            contactPhone: "+55 11 4002-8922",
          },
          select: { id: true },
        });

        return {
          value: created.id,
          outcome: { supplierId: created.id },
        };
      },
      replay(outcome: IdempotencyOutcome): Promise<string> {
        return Promise.resolve(String(outcome.supplierId));
      },
    };
  }

  describe("REL-004 replay", () => {
    it("executes once and replays the same result for a retry", async () => {
      const counters = { executions: 0 };
      const request = {
        operation: "QUOTE_SELECTION" as const,
        idempotencyKey: KEY,
        fingerprintParts: ["request-1", "quote-1"],
      };

      const first = await executeIdempotently.execute(
        principalOf(organizationA),
        request,
        registerSupplierOnce(organizationA, "one", counters),
      );
      const replayed = await executeIdempotently.execute(
        principalOf(organizationA),
        request,
        registerSupplierOnce(organizationA, "one", counters),
      );

      expect(replayed).toBe(first);
      expect(counters.executions).toBe(1);
      // One business effect, and one record.
      await expect(database.supplier.count()).resolves.toBe(1);
      await expect(database.idempotencyRecord.count()).resolves.toBe(1);
    });

    it("stores only two digests and a bounded scalar outcome", async () => {
      await executeIdempotently.execute(
        principalOf(organizationA),
        {
          operation: "QUOTE_SELECTION",
          idempotencyKey: KEY,
          fingerprintParts: ["request-1", "quote-1", "a private rationale"],
        },
        registerSupplierOnce(organizationA, "one", { executions: 0 }),
      );

      const record = await database.idempotencyRecord.findFirstOrThrow({
        select: {
          idempotencyKeyHash: true,
          requestFingerprint: true,
          outcome: true,
          completedAt: true,
        },
      });

      // The raw key is never persisted; only its SHA-256.
      expect(record.idempotencyKeyHash).toHaveLength(32);
      expect(record.requestFingerprint).toHaveLength(32);
      expect(Buffer.from(record.idempotencyKeyHash).toString("utf8")).not.toContain(
        KEY,
      );
      // Neither is the free text that went into the fingerprint.
      expect(JSON.stringify(record.outcome)).not.toContain("a private rationale");
      expect(record.completedAt).not.toBeNull();
    });
  });

  describe("REL-004 fails closed on a reused key", () => {
    it("refuses the same key for a different semantic request", async () => {
      const counters = { executions: 0 };

      await executeIdempotently.execute(
        principalOf(organizationA),
        {
          operation: "QUOTE_SELECTION",
          idempotencyKey: KEY,
          fingerprintParts: ["request-1", "quote-1"],
        },
        registerSupplierOnce(organizationA, "one", counters),
      );

      await expect(
        executeIdempotently.execute(
          principalOf(organizationA),
          {
            operation: "QUOTE_SELECTION",
            idempotencyKey: KEY,
            // A different quote: replaying the first answer would report an event that did not
            // happen, and executing would defeat the key.
            fingerprintParts: ["request-1", "quote-2"],
          },
          registerSupplierOnce(organizationA, "two", counters),
        ),
      ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);

      expect(counters.executions).toBe(1);
      await expect(database.supplier.count()).resolves.toBe(1);
    });

    it("keeps records separate per actor, so one user cannot replay another's", async () => {
      const counters = { executions: 0 };
      const colleague = await createUser(database, {
        organizationId: organizationA.organizationId,
        branchId: organizationA.branchId,
        departmentId: organizationA.departmentId,
        suffix: "colleague",
        roles: ["BUYER"],
      });
      const request = {
        operation: "QUOTE_SELECTION" as const,
        idempotencyKey: KEY,
        fingerprintParts: ["request-1", "quote-1"],
      };

      await executeIdempotently.execute(
        principalOf(organizationA),
        request,
        registerSupplierOnce(organizationA, "one", counters),
      );
      await executeIdempotently.execute(
        principalOf(organizationA, colleague.userId),
        request,
        registerSupplierOnce(organizationA, "two", counters),
      );

      // Two actors, two operations: the second executed rather than replaying the first's.
      expect(counters.executions).toBe(2);
      await expect(database.idempotencyRecord.count()).resolves.toBe(2);
    });

    it("keeps records separate per tenant (MT-002)", async () => {
      const counters = { executions: 0 };
      const request = {
        operation: "QUOTE_SELECTION" as const,
        idempotencyKey: KEY,
        fingerprintParts: ["request-1", "quote-1"],
      };

      await executeIdempotently.execute(
        principalOf(organizationA),
        request,
        registerSupplierOnce(organizationA, "one", counters),
      );
      await executeIdempotently.execute(
        principalOf(organizationB),
        request,
        registerSupplierOnce(organizationB, "two", counters),
      );

      expect(counters.executions).toBe(2);
      await expect(
        database.idempotencyRecord.count({
          where: { organizationId: organizationA.organizationId },
        }),
      ).resolves.toBe(1);
      await expect(
        database.idempotencyRecord.count({
          where: { organizationId: organizationB.organizationId },
        }),
      ).resolves.toBe(1);
    });

    it("keeps records separate per operation", async () => {
      const counters = { executions: 0 };

      await executeIdempotently.execute(
        principalOf(organizationA),
        {
          operation: "QUOTE_SELECTION",
          idempotencyKey: KEY,
          fingerprintParts: ["request-1"],
        },
        registerSupplierOnce(organizationA, "one", counters),
      );
      await executeIdempotently.execute(
        principalOf(organizationA),
        {
          operation: "PURCHASE_ORDER_ISSUANCE",
          idempotencyKey: KEY,
          fingerprintParts: ["request-1"],
        },
        registerSupplierOnce(organizationA, "two", counters),
      );

      expect(counters.executions).toBe(2);
    });
  });

  describe("REL-004 under concurrency and rollback", () => {
    it("produces one business outcome and one replay for two simultaneous calls", async () => {
      const counters = { executions: 0 };
      const request = {
        operation: "QUOTE_SELECTION" as const,
        idempotencyKey: KEY,
        fingerprintParts: ["request-1", "quote-1"],
      };

      const [first, second] = await Promise.all([
        executeIdempotently.execute(
          principalOf(organizationA),
          request,
          registerSupplierOnce(organizationA, "one", counters),
        ),
        executeIdempotently.execute(
          principalOf(organizationA),
          request,
          registerSupplierOnce(organizationA, "two", counters),
        ),
      ]);

      // Both callers get the same answer, and only one of them caused it.
      expect(first).toBe(second);
      await expect(database.supplier.count()).resolves.toBe(1);
      await expect(database.idempotencyRecord.count()).resolves.toBe(1);
    });

    it("leaves no record when the business transaction rolls back", async () => {
      await expect(
        executeIdempotently.execute(
          principalOf(organizationA),
          {
            operation: "QUOTE_SELECTION",
            idempotencyKey: KEY,
            fingerprintParts: ["request-1"],
          },
          {
            run() {
              return Promise.reject(new Error("audit storage is unavailable"));
            },
            replay() {
              return Promise.reject(new Error("must not replay"));
            },
          },
        ),
      ).rejects.toThrow("audit storage is unavailable");

      // Nothing to replay: the reservation went with the transaction.
      await expect(database.idempotencyRecord.count()).resolves.toBe(0);

      // And the same key is usable again, because nothing happened under it.
      const counters = { executions: 0 };
      await executeIdempotently.execute(
        principalOf(organizationA),
        {
          operation: "QUOTE_SELECTION",
          idempotencyKey: KEY,
          fingerprintParts: ["request-1"],
        },
        registerSupplierOnce(organizationA, "one", counters),
      );
      expect(counters.executions).toBe(1);
    });

    it("refuses at COMMIT a reservation whose outcome was never written", async () => {
      // The deferred constraint trigger is what makes "a committed record is replayable" an
      // invariant of the table rather than a sequencing assumption about this code.
      await expect(
        transactions.run((scope) =>
          records.reserve(scope, {
            organizationId: organizationA.organizationId,
            actorId: organizationA.userId,
            operation: "QUOTE_SELECTION",
            idempotencyKeyHash: Buffer.alloc(32, 1),
            requestFingerprint: Buffer.alloc(32, 2),
          }),
        ),
      ).rejects.toThrow(/reserved but never completed/);

      await expect(database.idempotencyRecord.count()).resolves.toBe(0);
    });

    it("translates the reservation's unique violation into a domain conflict, never a 500", async () => {
      const criteria = {
        organizationId: organizationA.organizationId,
        actorId: organizationA.userId,
        operation: "QUOTE_SELECTION" as const,
        idempotencyKeyHash: Buffer.alloc(32, 1),
        requestFingerprint: Buffer.alloc(32, 2),
      };

      await transactions.run(async (scope) => {
        const recordId = await records.reserve(scope, criteria);
        await records.complete(scope, {
          recordId,
          organizationId: organizationA.organizationId,
          outcome: { supplierId: randomUUID() },
          completedAt: new Date(),
        });
      });

      await expect(
        transactions.run((scope) => records.reserve(scope, criteria)),
      ).rejects.toBeInstanceOf(IdempotencyReservationConflictError);
    });
  });

  describe("the record is tenant-owned and actor-bound in the database too", () => {
    it("refuses an actor from another organization", async () => {
      await expect(
        transactions.run(async (scope) => {
          const recordId = await records.reserve(scope, {
            organizationId: organizationA.organizationId,
            actorId: organizationB.userId,
            operation: "QUOTE_SELECTION",
            idempotencyKeyHash: Buffer.alloc(32, 1),
            requestFingerprint: Buffer.alloc(32, 2),
          });
          await records.complete(scope, {
            recordId,
            organizationId: organizationA.organizationId,
            outcome: {},
            completedAt: new Date(),
          });
        }),
      ).rejects.toThrow(/idempotency_records_organization_id_actor_id_fkey/);
    });

    it("refuses a digest that is not a SHA-256", async () => {
      await expect(
        transactions.run(async (scope) => {
          const recordId = await records.reserve(scope, {
            organizationId: organizationA.organizationId,
            actorId: organizationA.userId,
            operation: "QUOTE_SELECTION",
            idempotencyKeyHash: Buffer.alloc(16, 1),
            requestFingerprint: Buffer.alloc(32, 2),
          });
          await records.complete(scope, {
            recordId,
            organizationId: organizationA.organizationId,
            outcome: {},
            completedAt: new Date(),
          });
        }),
      ).rejects.toThrow(/idempotency_records_key_hash_check/);
    });

    it("finds a record only under its full uniqueness boundary", async () => {
      // Deliberately exercised through the repository rather than through a raw query: the
      // point is that the contract offers no way to look one up by key alone.
      await createPurchaseRequest(database, organizationA);
      await createSupplier(database, organizationA, { suffix: "seed" });

      const criteria = {
        organizationId: organizationA.organizationId,
        actorId: organizationA.userId,
        operation: "QUOTE_SELECTION" as const,
        idempotencyKeyHash: Buffer.alloc(32, 7),
      };

      await transactions.run(async (scope) => {
        const recordId = await records.reserve(scope, {
          ...criteria,
          requestFingerprint: Buffer.alloc(32, 8),
        });
        await records.complete(scope, {
          recordId,
          organizationId: organizationA.organizationId,
          outcome: { supplierId: "abc" },
          completedAt: new Date(),
        });
      });

      await expect(records.find(criteria)).resolves.not.toBeNull();
      await expect(
        records.find({ ...criteria, actorId: organizationB.userId }),
      ).resolves.toBeNull();
      await expect(
        records.find({
          ...criteria,
          organizationId: organizationB.organizationId,
        }),
      ).resolves.toBeNull();
      await expect(
        records.find({ ...criteria, operation: "PURCHASE_ORDER_ISSUANCE" }),
      ).resolves.toBeNull();
    });
  });
});

import { createHash, randomUUID } from "node:crypto";
import { DatabaseService } from "@vendorflow/database";
import { RefreshAuthSession } from "../../src/identity-access/application/use-cases/refresh-auth-session";
import { InvalidRefreshSessionError } from "../../src/identity-access/application/contracts/authentication.errors";
import { generateRefreshToken } from "../../src/identity-access/application/support/refresh-token";
import { JoseAccessTokenService } from "../../src/identity-access/infrastructure/authentication/services/jose-access-token.service";
import { PrismaAuthSessionRepository } from "../../src/identity-access/infrastructure/authentication/persistence/prisma-auth-session.repository";
import {
  createTenant,
  hashPassword,
  type TenantFixture,
} from "./identity-fixtures";
import { PostgreSqlIntegrationTestHarness } from "./postgresql-test-harness";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

describe("authentication session persistence (PostgreSQL)", () => {
  let harness: PostgreSqlIntegrationTestHarness;
  let database: DatabaseService;
  let repository: PrismaAuthSessionRepository;
  let refreshAuthSession: RefreshAuthSession;
  let organizationA: TenantFixture;
  let organizationB: TenantFixture;

  beforeAll(async () => {
    harness = await PostgreSqlIntegrationTestHarness.start();
    database = harness.database;
    repository = new PrismaAuthSessionRepository(database);
    refreshAuthSession = new RefreshAuthSession(
      repository,
      new JoseAccessTokenService({
        secret: "integration-test-access-token-signing-key-0123456789",
        issuer: "vendorflow-test",
        audience: "vendorflow-api-test",
        ttlSeconds: 900,
      }),
    );
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

  describe("credential column", () => {
    it("keeps password_hash nullable so identities may exist without credentials", async () => {
      const [column] = await database.$queryRaw<
        Array<{
          readonly isNullable: string;
          readonly columnDefault: string | null;
          readonly dataType: string;
          readonly maximumLength: number | null;
        }>
      >`
        SELECT is_nullable AS "isNullable",
               column_default AS "columnDefault",
               data_type AS "dataType",
               character_maximum_length AS "maximumLength"
        FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'password_hash'
      `;

      expect(column).toEqual({
        isNullable: "YES",
        // No default: the migration must not manufacture a credential for anyone.
        columnDefault: null,
        dataType: "character varying",
        maximumLength: 255,
      });
    });

    it("creates no credential for existing identities", async () => {
      const credentialless = await database.user.create({
        data: {
          organizationId: organizationA.organizationId,
          branchId: organizationA.branchId,
          departmentId: organizationA.departmentId,
          name: "No Credentials",
          email: "no-credentials@example.com",
        },
      });

      expect(credentialless.passwordHash).toBeNull();
      await expect(
        database.user.count({ where: { passwordHash: { not: null } } }),
      ).resolves.toBe(2);
    });

    it.each([
      ["plaintext", "correct horse battery staple"],
      ["a bcrypt digest", "$2b$12$abcdefghijklmnopqrstuv"],
      ["a bare sha-256 digest", createHash("sha256").update("x").digest("hex")],
      ["an argon2i digest", "$argon2i$v=19$m=19456,p=1,t=2$c2FsdA$ZGlnZXN0"],
      ["an empty string", ""],
    ])("refuses %s at the database boundary", async (_case, value) => {
      await expect(
        database.user.update({
          where: { id: organizationA.userId },
          data: { passwordHash: value },
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("users_password_hash_check"),
      });
    });

    it("accepts an Argon2id digest produced by the application hasher", async () => {
      const digest = await hashPassword("correct horse battery staple");

      await expect(
        database.user.update({
          where: { id: organizationA.userId },
          data: { passwordHash: digest },
        }),
      ).resolves.toMatchObject({ passwordHash: digest });
    });
  });

  describe("session table constraints", () => {
    it("rejects a session whose user belongs to another organization", async () => {
      await expect(
        createSession({
          organizationId: organizationA.organizationId,
          userId: organizationB.userId,
        }),
      ).rejects.toMatchObject({ code: "P2003" });
    });

    it("rejects a duplicate token digest", async () => {
      const token = generateRefreshToken();

      await createSession({ tokenHash: token.tokenHash });

      await expect(
        createSession({
          organizationId: organizationB.organizationId,
          userId: organizationB.userId,
          tokenHash: token.tokenHash,
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("rejects a digest that is not 32 bytes", async () => {
      await expect(
        createSession({ tokenHash: Buffer.alloc(31, 1) }),
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          "auth_sessions_token_hash_length_check",
        ),
      });
    });

    it("rejects a session that expires before it was issued", async () => {
      await expect(
        createSession({ expiresAt: new Date(Date.now() - 60_000) }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("auth_sessions_lifetime_check"),
      });
    });

    it("rejects a revocation timestamp without a reason, and a reason without a timestamp", async () => {
      const session = await createSession({});

      await expect(
        database.authSession.update({
          where: { id: session.id },
          data: { revokedAt: new Date() },
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("auth_sessions_revocation_check"),
      });

      await expect(
        database.authSession.update({
          where: { id: session.id },
          data: { revocationReason: "LOGOUT" },
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("auth_sessions_revocation_check"),
      });
    });
  });

  describe("atomic rotation", () => {
    it("consumes the presented session and issues exactly one successor", async () => {
      const { token, session } = await startSession(organizationA);

      const result = await refreshAuthSession.execute({
        presentedToken: token,
      });

      const sessions = await sessionsOfFamily(session.familyId);
      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toMatchObject({
        id: session.id,
        revocationReason: "ROTATED",
      });
      expect(sessions[0]?.revokedAt).not.toBeNull();
      expect(sessions[1]).toMatchObject({
        organizationId: organizationA.organizationId,
        userId: organizationA.userId,
        familyId: session.familyId,
        revokedAt: null,
        revocationReason: null,
      });
      // The successor inherits the absolute lifetime instead of starting a new one.
      expect(sessions[1]?.expiresAt).toEqual(session.expiresAt);
      expect(sessions[1]?.tokenHash).toEqual(
        createHash("sha256").update(result.refreshToken, "utf8").digest(),
      );
    });

    it("lets exactly one of two concurrent refreshes succeed", async () => {
      const { token, session } = await startSession(organizationA);

      const outcomes = await Promise.allSettled([
        refreshAuthSession.execute({ presentedToken: token }),
        refreshAuthSession.execute({ presentedToken: token }),
      ]);

      expect(
        outcomes.filter(({ status }) => status === "fulfilled"),
      ).toHaveLength(1);

      const rejected = outcomes.find(({ status }) => status === "rejected");
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
        InvalidRefreshSessionError,
      );

      // The decisive assertion: the losing transaction persisted nothing. One predecessor,
      // one successor, and no second successor from the transaction that lost the race.
      const sessions = await sessionsOfFamily(session.familyId);
      expect(sessions).toHaveLength(2);
      expect(sessions[0]?.id).toBe(session.id);
    });

    it("leaves no active successor after a concurrent refresh, because the loser reports reuse", async () => {
      const { token, session } = await startSession(organizationA);

      await Promise.allSettled([
        refreshAuthSession.execute({ presentedToken: token }),
        refreshAuthSession.execute({ presentedToken: token }),
      ]);

      const sessions = await sessionsOfFamily(session.familyId);
      // Detection is strict by design: a replayed token is treated as stolen, and the
      // successor the winner just issued is revoked with the rest of the family.
      expect(sessions.every(({ revokedAt }) => revokedAt !== null)).toBe(true);
      expect(sessions[1]?.revocationReason).toBe("REUSE_DETECTED");
    });

    it("serializes the conditional update at the PostgreSQL row lock", async () => {
      // Proves the premise the rotation design rests on, without the application layer:
      // under READ COMMITTED the second UPDATE blocks on the first transaction's row lock,
      // then re-evaluates its predicate against the committed row version and matches
      // nothing. If this ever stopped holding, two refreshes could both consume one session.
      const { session } = await startSession(organizationA);
      const first = new DatabaseService();
      const second = new DatabaseService();

      try {
        const firstHasLocked = deferred();
        const firstMayCommit = deferred();
        let secondRowCount: number | undefined;

        const firstTransaction = first.$transaction(
          async (transaction) => {
            await revoke(transaction, session.tokenHash);
            firstHasLocked.resolve();
            await firstMayCommit.promise;
          },
          { timeout: 30_000, maxWait: 30_000 },
        );

        // Only start the contender once the lock is provably held; otherwise the two
        // statements race and the test proves nothing about serialization.
        await firstHasLocked.promise;

        const secondTransaction = second.$transaction(
          async (transaction) => {
            secondRowCount = await revoke(transaction, session.tokenHash);
          },
          { timeout: 30_000, maxWait: 30_000 },
        );

        await waitForBlockedStatement(first, session.tokenHash);
        expect(secondRowCount).toBeUndefined();

        firstMayCommit.resolve();
        await Promise.all([firstTransaction, secondTransaction]);

        expect(secondRowCount).toBe(0);
      } finally {
        await Promise.all([first.$disconnect(), second.$disconnect()]);
      }
    }, 60_000);

    it("revokes the whole family when an already rotated token is presented again", async () => {
      const { token, session } = await startSession(organizationA);

      const first = await refreshAuthSession.execute({ presentedToken: token });
      const second = await refreshAuthSession.execute({
        presentedToken: first.refreshToken,
      });

      await expect(
        refreshAuthSession.execute({ presentedToken: token }),
      ).rejects.toBeInstanceOf(InvalidRefreshSessionError);

      const sessions = await sessionsOfFamily(session.familyId);
      expect(sessions).toHaveLength(3);
      expect(sessions.every(({ revokedAt }) => revokedAt !== null)).toBe(true);
      expect(sessions[2]?.revocationReason).toBe("REUSE_DETECTED");

      // The successor the attacker did not hold is dead too, so the legitimate client is
      // forced to authenticate again rather than sharing a session with the replayer.
      await expect(
        refreshAuthSession.execute({ presentedToken: second.refreshToken }),
      ).rejects.toBeInstanceOf(InvalidRefreshSessionError);
    });

    it("does not create a successor for a principal that is no longer active", async () => {
      const { token, session } = await startSession(organizationA);
      await database.user.update({
        where: { id: organizationA.userId },
        data: { isActive: false },
      });

      await expect(
        refreshAuthSession.execute({ presentedToken: token }),
      ).rejects.toBeInstanceOf(InvalidRefreshSessionError);

      const sessions = await sessionsOfFamily(session.familyId);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.revocationReason).toBe("PRINCIPAL_INACTIVE");
    });

    it("serializes the principal decision against a concurrent deactivation", async () => {
      // The race this closes: rotation consumes the session, reads the User, a deactivation
      // commits, and rotation then issues a fresh access token and a live successor for an
      // identity that no longer exists. The `FOR UPDATE` on the User row is what makes the
      // two orderings mutually exclusive, and this test forces the hostile one — the
      // deactivation is already holding the row lock when rotation reaches it.
      const { token, session } = await startSession(organizationA);
      const deactivator = new DatabaseService();

      try {
        const deactivationHasLocked = deferred();
        const deactivationMayCommit = deferred();

        const deactivation = deactivator.$transaction(
          async (transaction) => {
            await transaction.$executeRaw`
              UPDATE "users"
              SET "is_active" = false
              WHERE "organization_id" = ${organizationA.organizationId}::uuid
                AND "id" = ${organizationA.userId}::uuid
            `;
            deactivationHasLocked.resolve();
            await deactivationMayCommit.promise;
          },
          { timeout: 30_000, maxWait: 30_000 },
        );

        // Only start the refresh once the User row is provably locked; otherwise the two
        // statements race and the test proves nothing about ordering.
        await deactivationHasLocked.promise;

        let refreshSettled = false;
        const refresh = refreshAuthSession
          .execute({ presentedToken: token })
          .then(
            (result) => {
              refreshSettled = true;
              return { rejectedWith: null, result };
            },
            (error: unknown) => {
              refreshSettled = true;
              return { rejectedWith: error, result: null };
            },
          );

        // PostgreSQL itself is the evidence, not a sleep: it reports a backend blocked
        // behind another transaction, and the statement it is blocked on is the User-row
        // lock rotation takes before deciding the principal is active.
        const blocked = await waitForBlockedQuery(
          database,
          /FROM "users"[\s\S]*FOR UPDATE/,
        );
        expect(blocked).toContain("FOR UPDATE");
        // It cannot have issued anything while it waits.
        expect(refreshSettled).toBe(false);

        deactivationMayCommit.resolve();
        await deactivation;

        const outcome = await refresh;
        expect(outcome.result).toBeNull();
        expect(outcome.rejectedWith).toBeInstanceOf(InvalidRefreshSessionError);

        const sessions = await sessionsOfFamily(session.familyId);
        // No successor: the deactivation won, so nothing was issued behind it.
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.id).toBe(session.id);
        // Including the predecessor the compare-and-swap had already marked ROTATED, which
        // the rejection path converts as the lifecycle constraint requires.
        expect(sessions.every(({ revokedAt }) => revokedAt !== null)).toBe(
          true,
        );
        expect(
          sessions.every(
            ({ revocationReason }) => revocationReason === "PRINCIPAL_INACTIVE",
          ),
        ).toBe(true);
      } finally {
        await deactivator.$disconnect();
      }
    }, 60_000);

    it("refuses an expired session and leaves it untouched", async () => {
      const token = generateRefreshToken();
      // Written directly, because the lifetime check forbids inserting an already-expired
      // row through the ordinary path.
      await database.$executeRaw`
        INSERT INTO "auth_sessions" ("id", "organization_id", "user_id", "family_id",
                                     "token_hash", "issued_at", "expires_at")
        VALUES (${randomUUID()}::uuid, ${organizationA.organizationId}::uuid,
                ${organizationA.userId}::uuid, ${randomUUID()}::uuid, ${token.tokenHash},
                now() - interval '31 days', now() - interval '1 day')
      `;

      await expect(
        refreshAuthSession.execute({ presentedToken: token.token }),
      ).rejects.toBeInstanceOf(InvalidRefreshSessionError);

      const [stored] = await database.authSession.findMany();
      expect(stored?.revokedAt).toBeNull();
    });

    it("refuses an unknown token without persisting anything", async () => {
      const before = await database.authSession.count();

      await expect(
        refreshAuthSession.execute({
          presentedToken: generateRefreshToken().token,
        }),
      ).rejects.toBeInstanceOf(InvalidRefreshSessionError);

      await expect(database.authSession.count()).resolves.toBe(before);
    });

    it("refuses a session that was revoked by logout and does not escalate to reuse", async () => {
      const { token, session } = await startSession(organizationA);

      await repository.revokePresentedSession({
        presentedTokenHash: session.tokenHash,
      });

      await expect(
        refreshAuthSession.execute({ presentedToken: token }),
      ).rejects.toBeInstanceOf(InvalidRefreshSessionError);

      const sessions = await sessionsOfFamily(session.familyId);
      expect(sessions[0]?.revocationReason).toBe("LOGOUT");
    });

    it("makes logout idempotent and never resurrects a revoked session", async () => {
      const { session } = await startSession(organizationA);

      await repository.revokePresentedSession({
        presentedTokenHash: session.tokenHash,
      });
      const afterFirst = await database.authSession.findUniqueOrThrow({
        where: { id: session.id },
      });

      await repository.revokePresentedSession({
        presentedTokenHash: session.tokenHash,
      });
      const afterSecond = await database.authSession.findUniqueOrThrow({
        where: { id: session.id },
      });

      expect(afterSecond.revokedAt).toEqual(afterFirst.revokedAt);
      expect(afterSecond.revocationReason).toBe("LOGOUT");
    });

    it("ignores an unknown token on logout", async () => {
      await expect(
        repository.revokePresentedSession({
          presentedTokenHash: generateRefreshToken().tokenHash,
        }),
      ).resolves.toBeUndefined();
    });

    it("does not touch another tenant's family when revoking for reuse", async () => {
      const compromised = await startSession(organizationA);
      const untouched = await startSession(organizationB);

      await refreshAuthSession.execute({ presentedToken: compromised.token });
      await expect(
        refreshAuthSession.execute({ presentedToken: compromised.token }),
      ).rejects.toBeInstanceOf(InvalidRefreshSessionError);

      const foreign = await sessionsOfFamily(untouched.session.familyId);
      expect(foreign).toHaveLength(1);
      expect(foreign[0]?.revokedAt).toBeNull();
    });
  });

  async function createSession(overrides: {
    readonly organizationId?: string;
    readonly userId?: string;
    readonly familyId?: string;
    readonly tokenHash?: Uint8Array;
    readonly expiresAt?: Date;
  }) {
    return database.authSession.create({
      data: {
        organizationId:
          overrides.organizationId ?? organizationA.organizationId,
        userId: overrides.userId ?? organizationA.userId,
        familyId: overrides.familyId ?? randomUUID(),
        tokenHash: overrides.tokenHash ?? generateRefreshToken().tokenHash,
        expiresAt: overrides.expiresAt ?? new Date(Date.now() + THIRTY_DAYS_MS),
      },
    });
  }

  async function startSession(tenant: TenantFixture) {
    const token = generateRefreshToken();
    const session = await database.authSession.create({
      data: {
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        familyId: randomUUID(),
        tokenHash: token.tokenHash,
        expiresAt: new Date(Date.now() + THIRTY_DAYS_MS),
      },
    });

    return { token: token.token, session };
  }

  async function sessionsOfFamily(familyId: string) {
    return database.authSession.findMany({
      where: { familyId },
      orderBy: { issuedAt: "asc" },
    });
  }

  function deferred(): {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
  } {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((settle) => {
      resolve = settle;
    });

    return { promise, resolve: () => resolve() };
  }

  /**
   * Waits until PostgreSQL itself reports a backend waiting on a lock, so the assertion
   * that follows is about real contention rather than about an arbitrary sleep.
   */
  async function waitForBlockedStatement(
    client: DatabaseService,
    tokenHash: Uint8Array,
  ): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [waiting] = await client.$queryRaw<
        Array<{ readonly total: bigint }>
      >`
        SELECT count(*) AS "total"
        FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND state = 'active'
      `;

      if ((waiting?.total ?? 0n) > 0n) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(
      `Expected a statement to block on the row lock for session ${Buffer.from(tokenHash).toString("hex")}`,
    );
  }

  /**
   * Waits until PostgreSQL reports a backend blocked behind another transaction and returns
   * the statement it is stuck on, so the assertion that follows is about real contention on
   * a known statement rather than about an arbitrary sleep.
   */
  async function waitForBlockedQuery(
    client: DatabaseService,
    statement: RegExp,
  ): Promise<string> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const blocked = await client.$queryRaw<Array<{ readonly query: string }>>`
        SELECT activity.query AS "query"
        FROM pg_stat_activity AS activity
        WHERE activity.wait_event_type = 'Lock'
          AND cardinality(pg_blocking_pids(activity.pid)) > 0
      `;

      const waiting = blocked.find(({ query }) => statement.test(query));

      if (waiting !== undefined) {
        return waiting.query;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(
      `Expected a statement matching ${statement.source} to block on a lock`,
    );
  }

  async function revoke(
    transaction: { $executeRaw: DatabaseService["$executeRaw"] },
    tokenHash: Uint8Array,
  ): Promise<number> {
    return transaction.$executeRaw`
      UPDATE "auth_sessions"
      SET "revoked_at" = now(),
          "revocation_reason" = 'ROTATED'::"auth_session_revocation_reason"
      WHERE "token_hash" = ${tokenHash}
        AND "revoked_at" IS NULL
        AND "expires_at" > now()
    `;
  }
});

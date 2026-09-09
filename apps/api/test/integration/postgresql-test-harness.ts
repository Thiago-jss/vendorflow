import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { DatabaseService } from "@vendorflow/database";

const execFileAsync = promisify(execFile);

export class PostgreSqlIntegrationTestHarness {
  private constructor(
    private readonly container: StartedPostgreSqlContainer,
    readonly database: DatabaseService,
    private readonly previousDatabaseUrl: string | undefined,
  ) {}

  static async start(): Promise<PostgreSqlIntegrationTestHarness> {
    const container = await new PostgreSqlContainer("postgres:17-alpine")
      .withDatabase("vendorflow_test")
      .withUsername("vendorflow_test")
      .withPassword("vendorflow_test")
      .start();
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const databaseUrl = container.getConnectionUri();

    process.env.DATABASE_URL = databaseUrl;

    try {
      await this.applyMigrations(databaseUrl);

      const database = new DatabaseService();
      await database.$connect();

      return new PostgreSqlIntegrationTestHarness(
        container,
        database,
        previousDatabaseUrl,
      );
    } catch (error: unknown) {
      this.restoreDatabaseUrl(previousDatabaseUrl);
      await container.stop();
      throw error;
    }
  }

  async clean(): Promise<void> {
    await this.database.$transaction([
      // AUD-003 makes audit_events append-only with a trigger that refuses DELETE, so a test
      // database is reset with TRUNCATE — which is not a row operation and does not fire it.
      // Nothing references audit_events, so it can go first. The statement is a fixed
      // template literal with no interpolation; it is not string-built SQL.
      this.database.$executeRaw`TRUNCATE TABLE "audit_events"`,
      // Children before parents throughout: every foreign key here is RESTRICT except
      // items -> requests, and relying on that one cascade would leave the order of the
      // rest silently wrong the first time it changes.
      // Outbox rows and consumer receipts hold RESTRICT foreign keys to organizations and
      // nothing references them, so they go first. Unlike audit_events they are ordinary
      // mutable rows, so an ordinary delete is enough.
      this.database.outboxConsumerReceipt.deleteMany(),
      this.database.outboxMessage.deleteMany(),
      this.database.approvalStep.deleteMany(),
      // Steps hold RESTRICT foreign keys to flows, requests and users.
      this.database.approvalFlow.deleteMany(),
      this.database.purchaseRequestItem.deleteMany(),
      // Requests hold RESTRICT foreign keys to users and departments.
      this.database.purchaseRequest.deleteMany(),
      // Sessions first: they carry a RESTRICT foreign key to users.
      this.database.authSession.deleteMany(),
      this.database.userRole.deleteMany(),
      this.database.user.deleteMany(),
      this.database.department.deleteMany(),
      this.database.branch.deleteMany(),
      this.database.organization.deleteMany(),
    ]);
  }

  async stop(): Promise<void> {
    try {
      await this.database.$disconnect();
    } finally {
      try {
        await this.container.stop();
      } finally {
        PostgreSqlIntegrationTestHarness.restoreDatabaseUrl(
          this.previousDatabaseUrl,
        );
      }
    }
  }

  private static async applyMigrations(databaseUrl: string): Promise<void> {
    const repositoryRoot = resolve(__dirname, "../../../..");
    const schemaPath = resolve(
      repositoryRoot,
      "packages/database/prisma/schema.prisma",
    );

    await execFileAsync(
      "pnpm",
      [
        "--filter",
        "@vendorflow/database",
        "exec",
        "prisma",
        "migrate",
        "deploy",
        "--schema",
        schemaPath,
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
        },
        timeout: 120_000,
      },
    );
  }

  private static restoreDatabaseUrl(previousDatabaseUrl: string | undefined) {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
      return;
    }

    process.env.DATABASE_URL = previousDatabaseUrl;
  }
}

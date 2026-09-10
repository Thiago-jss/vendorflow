import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { INestApplication, Type } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import {
  RabbitMQContainer,
  type StartedRabbitMQContainer,
} from "@testcontainers/rabbitmq";
import { DatabaseService } from "@vendorflow/database";
import { connect, type Channel, type ChannelModel } from "amqplib";
import type { TopologyNames } from "../../src/messaging/topology";

const execFileAsync = promisify(execFile);

/**
 * Short enough that the whole retry ladder can be exercised inside a test, long enough that
 * the delay is observably a delay. The production ladder is 10s/60s/300s; proving the ladder
 * escalates does not require proving that RabbitMQ can count to three hundred.
 */
const TEST_RETRY_DELAYS_MS = "300,600,900";

/**
 * Real PostgreSQL and a real RabbitMQ broker, because everything this phase claims is a
 * property of those two systems together. `FOR UPDATE SKIP LOCKED`, a CHECK constraint, a
 * publisher confirm, a `mandatory` return, `x-death` accumulation and a per-queue TTL cannot
 * be demonstrated against a mock — a mock would only demonstrate the mock.
 */
export class WorkerIntegrationTestHarness {
  private constructor(
    private readonly postgres: StartedPostgreSqlContainer,
    private readonly rabbit: StartedRabbitMQContainer,
    private readonly restoreEnvironment: () => void,
    readonly application: INestApplication,
    readonly database: DatabaseService,
    readonly topologyPrefix: string,
  ) {}

  static async start(
    environmentOverrides: Readonly<Record<string, string>> = {},
  ): Promise<WorkerIntegrationTestHarness> {
    const [postgres, rabbit] = await Promise.all([
      new PostgreSqlContainer("postgres:17-alpine")
        .withDatabase("vendorflow_test")
        .withUsername("vendorflow_test")
        .withPassword("vendorflow_test")
        .start(),
      new RabbitMQContainer("rabbitmq:4-management-alpine").start(),
    ]);

    const databaseUrl = postgres.getConnectionUri();
    // Its own namespace per harness: declaring a queue whose arguments differ from an
    // existing one is a channel-level error, and every suite tunes the ladder differently.
    const topologyPrefix = `test-${randomUUID().slice(0, 8)}`;
    const applied: Record<string, string> = {
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      RABBITMQ_URL: rabbit.getAmqpUrl(),
      RABBITMQ_TOPOLOGY_PREFIX: topologyPrefix,
      CONSUMER_RETRY_DELAYS_MS: TEST_RETRY_DELAYS_MS,
      // The loop is driven explicitly by the tests; an interval sweep racing the assertions
      // would make failures depend on timing rather than on behaviour.
      OUTBOX_POLL_INTERVAL_MS: "3600000",
      OUTBOX_LEASE_SECONDS: "30",
      OUTBOX_PUBLISH_CONFIRM_TIMEOUT_MS: "5000",
      OUTBOX_MAX_PUBLISH_ATTEMPTS: "3",
      OUTBOX_RETRY_BASE_DELAY_MS: "50",
      OUTBOX_RETRY_MAX_DELAY_MS: "200",
      ...environmentOverrides,
    };
    const previous = new Map<string, string | undefined>();

    for (const [name, value] of Object.entries(applied)) {
      previous.set(name, process.env[name]);
      process.env[name] = value;
    }

    const restoreEnvironment = () => {
      for (const [name, value] of previous) {
        if (value === undefined) {
          delete process.env[name];
          continue;
        }

        process.env[name] = value;
      }
    };

    try {
      await WorkerIntegrationTestHarness.applyMigrations(databaseUrl);

      // Imported after the overrides are in place: the config module validates the
      // environment while the application module is evaluated.
      const { AppModule } = await import("../../src/app.module");
      const moduleReference = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      const application = moduleReference.createNestApplication({
        logger: false,
      });

      await application.init();

      const harness = new WorkerIntegrationTestHarness(
        postgres,
        rabbit,
        restoreEnvironment,
        application,
        application.get(DatabaseService),
        topologyPrefix,
      );

      await harness.waitUntilBrokerReady();

      return harness;
    } catch (error: unknown) {
      restoreEnvironment();
      await Promise.all([postgres.stop(), rabbit.stop()]);
      throw error;
    }
  }

  get<T>(token: Type<T>): T {
    return this.application.get(token);
  }

  amqpUrl(): string {
    return this.rabbit.getAmqpUrl();
  }

  /** A connection of the test's own, so assertions never borrow the worker's channels. */
  async openInspectionChannel(): Promise<{
    readonly connection: ChannelModel;
    readonly channel: Channel;
  }> {
    const connection = await connect(this.amqpUrl());
    // Without a listener, a heartbeat timeout after the suite finishes becomes an unhandled
    // 'error' event and takes the whole Jest process down after the results are printed.
    connection.on("error", () => undefined);
    const channel = await connection.createChannel();
    channel.on("error", () => undefined);

    return { connection, channel };
  }

  async clean(): Promise<void> {
    await this.database.$transaction([
      this.database.outboxConsumerReceipt.deleteMany(),
      this.database.outboxMessage.deleteMany(),
      this.database.user.deleteMany(),
      this.database.department.deleteMany(),
      this.database.branch.deleteMany(),
      this.database.organization.deleteMany(),
    ]);
  }

  async stop(): Promise<void> {
    try {
      await this.application.close();
    } finally {
      try {
        await Promise.all([this.postgres.stop(), this.rabbit.stop()]);
      } finally {
        this.restoreEnvironment();
      }
    }
  }

  /** An Organization to own the tenant-scoped rows every test writes. */
  async createOrganization(name: string): Promise<string> {
    const organization = await this.database.organization.create({
      data: { name },
      select: { id: true },
    });

    return organization.id;
  }

  private async waitUntilBrokerReady(): Promise<void> {
    const { RabbitMqService } = await import("../../src/messaging/rabbitmq.service");
    const rabbitMq = this.application.get(RabbitMqService);

    await waitFor(() => rabbitMq.isUsable(), "the broker connection to open");
  }

  topology(): TopologyNames {
    return {
      eventsExchange: `${this.topologyPrefix}.events`,
      deadLetterExchange: `${this.topologyPrefix}.events.dlx`,
      retryExchanges: [1, 2, 3].map(
        (tier) => `${this.topologyPrefix}.events.retry.${tier}`,
      ),
      workQueue: `${this.topologyPrefix}.purchase-request-events`,
      retryQueues: [1, 2, 3].map(
        (tier) => `${this.topologyPrefix}.purchase-request-events.retry.${tier}`,
      ),
      deadLetterQueue: `${this.topologyPrefix}.purchase-request-events.dlq`,
      bindingPatterns: ["purchase_request.#", "purchase_order.#"],
    };
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
        env: { ...process.env, DATABASE_URL: databaseUrl },
        timeout: 120_000,
      },
    );
  }
}

/**
 * Polling rather than a fixed sleep. A broker delivers when it delivers, and a test that
 * sleeps long enough to be safe is a test that is slow when it passes and misleading when it
 * fails.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 15_000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await condition()) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

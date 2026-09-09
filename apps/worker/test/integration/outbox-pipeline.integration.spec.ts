import { randomUUID } from "node:crypto";
import type { Channel, ChannelModel, GetMessage } from "amqplib";
import { ConsumerReceiptRepository } from "../../src/consumers/consumer-receipt.repository";
import { OUTBOX_DELIVERY_RECORDER } from "../../src/consumers/outbox-delivery-recorder.consumer";
import { OutboxMessageRepository } from "../../src/outbox/outbox-message.repository";
import { OutboxPublisherService } from "../../src/outbox/outbox-publisher.service";
import { RabbitMqService } from "../../src/messaging/rabbitmq.service";
import {
  WorkerIntegrationTestHarness,
  waitFor,
} from "./worker-test-harness";

const SUBMITTED_ROUTING_KEY = "purchase_request.submitted";

/**
 * The whole pipeline against a real PostgreSQL and a real RabbitMQ: claim, confirm, record,
 * deliver, deduplicate, retry, dead-letter.
 *
 * Every assertion here is about a property no unit test can hold. A lease that survives a
 * dead process, a `SKIP LOCKED` claim two relays cannot both win, a publisher confirm, an
 * unroutable `mandatory` return, RabbitMQ's own `x-death` accumulation across three queues
 * with three different TTLs — all of them are behaviours of the two servers, not of this code.
 */
describe("outbox pipeline (PostgreSQL + RabbitMQ)", () => {
  let harness: WorkerIntegrationTestHarness;
  let publisher: OutboxPublisherService;
  let outboxMessages: OutboxMessageRepository;
  let receipts: ConsumerReceiptRepository;
  let rabbitMq: RabbitMqService;
  let inspection: { connection: ChannelModel; channel: Channel };
  let organizationId: string;
  let otherOrganizationId: string;
  /** Bound alongside the work queue, so a test can read what the relay published. */
  let spyQueue: string;

  beforeAll(async () => {
    harness = await WorkerIntegrationTestHarness.start();
    publisher = harness.get(OutboxPublisherService);
    outboxMessages = harness.get(OutboxMessageRepository);
    receipts = harness.get(ConsumerReceiptRepository);
    rabbitMq = harness.get(RabbitMqService);
    inspection = await harness.openInspectionChannel();

    spyQueue = `${harness.topologyPrefix}.spy`;
    // Durable and auto-deleting: RabbitMQ 4 refuses transient non-exclusive queues outright,
    // and a refusal closes the whole connection rather than just the operation.
    await inspection.channel.assertQueue(spyQueue, {
      durable: true,
      autoDelete: true,
    });
    await inspection.channel.bindQueue(
      spyQueue,
      harness.topology().eventsExchange,
      harness.topology().bindingPattern,
    );
  }, 300_000);

  beforeEach(async () => {
    await harness.clean();
    await inspection.channel.purgeQueue(spyQueue);
    await inspection.channel.purgeQueue(harness.topology().deadLetterQueue);
    for (const retryQueue of harness.topology().retryQueues) {
      await inspection.channel.purgeQueue(retryQueue);
    }

    organizationId = await harness.createOrganization("Relay Tenant A");
    otherOrganizationId = await harness.createOrganization("Relay Tenant B");
  });

  afterAll(async () => {
    if (inspection !== undefined) {
      await inspection.connection.close();
    }

    if (harness !== undefined) {
      await harness.stop();
    }
  }, 120_000);

  async function insertIntent(
    overrides: {
      readonly organizationId?: string;
      readonly schemaVersion?: number;
    } = {},
  ): Promise<string> {
    const created = await harness.database.outboxMessage.create({
      data: {
        organizationId: overrides.organizationId ?? organizationId,
        eventType: "PURCHASE_REQUEST_SUBMITTED",
        schemaVersion: overrides.schemaVersion ?? 1,
        aggregateType: "PURCHASE_REQUEST",
        aggregateId: randomUUID(),
        correlationId: randomUUID(),
        occurredAt: new Date(),
        payload: { status: "SUBMITTED", estimatedTotalCents: "100000" },
      },
      select: { id: true },
    });

    return created.id;
  }

  function readOutboxRow(id: string) {
    return harness.database.outboxMessage.findUniqueOrThrow({ where: { id } });
  }

  async function drainSpyQueue(): Promise<GetMessage[]> {
    const messages: GetMessage[] = [];

    for (;;) {
      const message = await inspection.channel.get(spyQueue, { noAck: true });

      if (message === false) {
        return messages;
      }

      messages.push(message);
    }
  }

  async function nextDeadLetter(): Promise<GetMessage> {
    let received: GetMessage | undefined;

    await waitFor(async () => {
      const message = await inspection.channel.get(
        harness.topology().deadLetterQueue,
        { noAck: true },
      );

      if (message === false) {
        return false;
      }

      received = message;

      return true;
    }, "a message in the dead-letter queue", 30_000);

    if (received === undefined) {
      throw new Error("No dead-lettered message was captured");
    }

    return received;
  }

  function publishRaw(
    body: Buffer,
    options: { readonly messageId?: string; readonly routingKey?: string } = {},
  ): void {
    inspection.channel.publish(
      harness.topology().eventsExchange,
      options.routingKey ?? SUBMITTED_ROUTING_KEY,
      body,
      { persistent: true, messageId: options.messageId, contentType: "application/json" },
    );
  }

  describe("relay", () => {
    it("publishes a committed intent and records the publication", async () => {
      const id = await insertIntent();

      expect(await publisher.sweepOnce()).toBe(1);

      const row = await readOutboxRow(id);
      expect(row.status).toBe("PUBLISHED");
      expect(row.publishedAt).not.toBeNull();
      // The lease is released with the same statement that records the publication, so no
      // FAILED-looking remnants survive a successful publish.
      expect(row.leasedBy).toBeNull();
      expect(row.leaseExpiresAt).toBeNull();
      expect(row.attemptCount).toBe(1);

      const [published] = await drainSpyQueue();
      expect(published?.properties.messageId).toBe(id);
      expect(published?.properties.correlationId).toBe(row.correlationId);
      expect(published?.properties.type).toBe(SUBMITTED_ROUTING_KEY);
      // Durable message on a durable queue: a broker restart must not lose a committed fact.
      expect(published?.properties.deliveryMode).toBe(2);

      const envelope = JSON.parse(published?.content.toString("utf8") ?? "{}");
      expect(envelope).toMatchObject({
        eventId: id,
        schemaVersion: 1,
        eventType: "PURCHASE_REQUEST_SUBMITTED",
        organizationId,
        correlationId: row.correlationId,
      });
    });

    it("never lets two relays claim the same row", async () => {
      await Promise.all([insertIntent(), insertIntent(), insertIntent()]);

      const [first, second] = await Promise.all([
        outboxMessages.claimPublishableBatch({
          leaseOwner: "relay-one",
          leaseSeconds: 30,
          batchSize: 10,
        }),
        outboxMessages.claimPublishableBatch({
          leaseOwner: "relay-two",
          leaseSeconds: 30,
          batchSize: 10,
        }),
      ]);

      const claimedIds = [...first, ...second].map((message) => message.id);
      expect(new Set(claimedIds).size).toBe(claimedIds.length);
      expect(claimedIds).toHaveLength(3);
    });

    it("recovers a row from a relay that died holding the lease", async () => {
      const id = await insertIntent();
      await harness.database.$executeRaw`
        UPDATE "outbox_messages"
        SET "status" = 'PUBLISHING'::"outbox_message_status",
            "leased_by" = 'relay-that-died',
            "lease_expires_at" = now() - interval '1 second'
        WHERE "id" = ${id}::uuid
      `;

      const claimed = await outboxMessages.claimPublishableBatch({
        leaseOwner: "relay-that-lived",
        leaseSeconds: 30,
        batchSize: 10,
      });

      expect(claimed.map((message) => message.id)).toEqual([id]);
      expect((await readOutboxRow(id)).leasedBy).toBe("relay-that-lived");
    });

    it("refuses to record a publication whose lease was taken over", async () => {
      const id = await insertIntent();
      await outboxMessages.claimPublishableBatch({
        leaseOwner: "relay-one",
        leaseSeconds: 30,
        batchSize: 10,
      });

      // The relay that lost the lease must not be able to overwrite the state of the one that
      // took it. Its publication becomes a duplicate the consumer absorbs, not a lost row.
      expect(
        await outboxMessages.markPublished({ id, leaseOwner: "relay-two" }),
      ).toBe(false);
      expect((await readOutboxRow(id)).status).toBe("PUBLISHING");
    });

    it("retries an unroutable publication with backoff instead of losing it", async () => {
      const topology = harness.topology();
      await inspection.channel.unbindQueue(
        topology.workQueue,
        topology.eventsExchange,
        topology.bindingPattern,
      );
      await inspection.channel.unbindQueue(
        spyQueue,
        topology.eventsExchange,
        topology.bindingPattern,
      );

      try {
        const id = await insertIntent();
        await publisher.sweepOnce();

        const row = await readOutboxRow(id);
        expect(row.status).toBe("PENDING");
        expect(row.attemptCount).toBe(1);
        expect(row.leasedBy).toBeNull();
        expect(row.lastError).toContain("No queue is bound");
        expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      } finally {
        await inspection.channel.bindQueue(
          topology.workQueue,
          topology.eventsExchange,
          topology.bindingPattern,
        );
        await inspection.channel.bindQueue(
          spyQueue,
          topology.eventsExchange,
          topology.bindingPattern,
        );
      }
    });

    it("parks an exhausted publication as FAILED and stops claiming it (REL-006)", async () => {
      const topology = harness.topology();
      await inspection.channel.unbindQueue(
        topology.workQueue,
        topology.eventsExchange,
        topology.bindingPattern,
      );
      await inspection.channel.unbindQueue(
        spyQueue,
        topology.eventsExchange,
        topology.bindingPattern,
      );

      try {
        const id = await insertIntent();

        // OUTBOX_MAX_PUBLISH_ATTEMPTS is 3 in this harness. The backoff is skipped forward so
        // the test proves exhaustion rather than proving that waiting works.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await harness.database.$executeRaw`
            UPDATE "outbox_messages" SET "next_attempt_at" = now() WHERE "id" = ${id}::uuid
          `;
          await publisher.sweepOnce();
        }

        const row = await readOutboxRow(id);
        expect(row.status).toBe("FAILED");
        expect(row.attemptCount).toBe(3);
        expect(row.lastError).not.toBeNull();

        // Durable, inspectable and never silently republished: an operator decides.
        expect(await publisher.sweepOnce()).toBe(0);
        expect((await readOutboxRow(id)).status).toBe("FAILED");
      } finally {
        await inspection.channel.bindQueue(
          topology.workQueue,
          topology.eventsExchange,
          topology.bindingPattern,
        );
        await inspection.channel.bindQueue(
          spyQueue,
          topology.eventsExchange,
          topology.bindingPattern,
        );
      }
    });

    it("fails a row it can never publish without burning the retry ladder", async () => {
      const id = await insertIntent({ schemaVersion: 2 });

      await publisher.sweepOnce();

      const row = await readOutboxRow(id);
      expect(row.status).toBe("FAILED");
      expect(row.attemptCount).toBe(1);
      expect(row.lastError).toContain("Unsupported event type or schema version");
    });
  });

  describe("consumer", () => {
    it("records exactly one receipt for a delivered event", async () => {
      const id = await insertIntent();
      await publisher.sweepOnce();

      await waitFor(
        async () =>
          (await harness.database.outboxConsumerReceipt.count({
            where: { eventId: id },
          })) === 1,
        "the delivery receipt",
      );

      const receipt = await harness.database.outboxConsumerReceipt.findFirstOrThrow(
        { where: { eventId: id } },
      );
      expect(receipt).toMatchObject({
        consumer: OUTBOX_DELIVERY_RECORDER,
        organizationId,
        eventType: "PURCHASE_REQUEST_SUBMITTED",
        deliveryCount: 1,
      });
    });

    it("absorbs a duplicate delivery without a second effect (REL-003)", async () => {
      const id = await insertIntent();
      await publisher.sweepOnce();

      await waitFor(
        async () =>
          (await harness.database.outboxConsumerReceipt.count({
            where: { eventId: id },
          })) === 1,
        "the first receipt",
      );

      const [published] = await drainSpyQueue();
      const firstReceipt =
        await harness.database.outboxConsumerReceipt.findFirstOrThrow({
          where: { eventId: id },
        });

      // The same message again, exactly as the broker would redeliver it after a crash
      // between the consumer's commit and its acknowledgement.
      publishRaw(published?.content ?? Buffer.from("{}"), { messageId: id });

      await waitFor(async () => (await drainSpyQueue()).length > 0, "the replay to arrive");
      await new Promise((resolve) => setTimeout(resolve, 500));

      const receipts = await harness.database.outboxConsumerReceipt.findMany({
        where: { eventId: id },
      });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.processedAt).toEqual(firstReceipt.processedAt);
    });

    it("dead-letters an event whose tenant does not match the committed row", async () => {
      const id = await insertIntent();
      await publisher.sweepOnce();
      await waitFor(
        async () =>
          (await harness.database.outboxConsumerReceipt.count({
            where: { eventId: id },
          })) === 1,
        "the genuine delivery",
      );

      const [published] = await drainSpyQueue();
      const envelope = JSON.parse(published?.content.toString("utf8") ?? "{}");
      // A message claiming another organization. The tenant is provenance to validate, never
      // authority to act on (ADR-002).
      const forged = { ...envelope, organizationId: otherOrganizationId };

      publishRaw(Buffer.from(JSON.stringify(forged)), { messageId: id });

      const deadLettered = await nextDeadLetter();
      expect(deadLettered.properties.headers?.["x-vf-failure-reason"]).toBe(
        "unknown-or-foreign-event",
      );
      expect(
        await harness.database.outboxConsumerReceipt.count({
          where: { organizationId: otherOrganizationId },
        }),
      ).toBe(0);
    });

    it("dead-letters an event that no committed intent produced", async () => {
      const envelope = {
        eventId: randomUUID(),
        schemaVersion: 1,
        eventType: "PURCHASE_REQUEST_SUBMITTED",
        occurredAt: new Date().toISOString(),
        organizationId,
        aggregateType: "PURCHASE_REQUEST",
        aggregateId: randomUUID(),
        correlationId: randomUUID(),
        payload: { status: "SUBMITTED" },
      };

      publishRaw(Buffer.from(JSON.stringify(envelope)), {
        messageId: envelope.eventId,
      });

      const deadLettered = await nextDeadLetter();
      expect(deadLettered.properties.headers?.["x-vf-failure-reason"]).toBe(
        "unknown-or-foreign-event",
      );
    });

    it("dead-letters a body that is not an envelope, without retrying it", async () => {
      publishRaw(Buffer.from("this is not json"));

      const deadLettered = await nextDeadLetter();
      expect(deadLettered.properties.headers?.["x-vf-failure-reason"]).toBe(
        "unparseable-body",
      );
      // Poison is terminal on the first delivery: it never entered the retry ladder.
      expect(deadLettered.properties.headers?.["x-death"]).toBeUndefined();
    });

    it("dead-letters a schema version it does not implement", async () => {
      const envelope = {
        eventId: randomUUID(),
        schemaVersion: 99,
        eventType: "PURCHASE_REQUEST_SUBMITTED",
        occurredAt: new Date().toISOString(),
        organizationId,
        aggregateType: "PURCHASE_REQUEST",
        aggregateId: randomUUID(),
        correlationId: randomUUID(),
        payload: {},
      };

      publishRaw(Buffer.from(JSON.stringify(envelope)));

      const deadLettered = await nextDeadLetter();
      expect(deadLettered.properties.headers?.["x-vf-failure-reason"]).toBe(
        "unsupported-schema-version",
      );
    });
  });

  describe("bounded retry with real backoff", () => {
    it("recovers on a later tier when the failure was transient", async () => {
      const id = await insertIntent();
      const failOnce = jest
        .spyOn(receipts, "recordDelivery")
        .mockRejectedValueOnce(new Error("PostgreSQL is unreachable"));

      try {
        await publisher.sweepOnce();

        await waitFor(
          async () =>
            (await harness.database.outboxConsumerReceipt.count({
              where: { eventId: id },
            })) === 1,
          "the retried delivery to succeed",
          20_000,
        );

        const receipt =
          await harness.database.outboxConsumerReceipt.findFirstOrThrow({
            where: { eventId: id },
          });
        // One completed trip through the first retry tier, counted from RabbitMQ's own
        // dead-letter bookkeeping rather than from a header this worker maintains.
        expect(receipt.deliveryCount).toBe(2);
      } finally {
        failOnce.mockRestore();
      }
    }, 40_000);

    it("escalates through every tier and then dead-letters (REL-006)", async () => {
      const id = await insertIntent();
      const alwaysFail = jest
        .spyOn(receipts, "recordDelivery")
        .mockRejectedValue(new Error("PostgreSQL is unreachable"));

      try {
        await publisher.sweepOnce();

        const deadLettered = await nextDeadLetter();
        expect(deadLettered.properties.messageId).toBe(id);
        expect(deadLettered.properties.headers?.["x-vf-failure-reason"]).toBe(
          "retries-exhausted",
        );

        // Every tier was served. The count is stated on the message because RabbitMQ discards
        // a client-supplied `x-death` on publish, so the terminal queue would otherwise not
        // record how far the ladder got.
        expect(
          deadLettered.properties.headers?.["x-vf-completed-retry-tiers"],
        ).toBe(harness.topology().retryQueues.length);

        expect(
          await harness.database.outboxConsumerReceipt.count({
            where: { eventId: id },
          }),
        ).toBe(0);
      } finally {
        alwaysFail.mockRestore();
      }
    }, 60_000);
  });

  describe("readiness", () => {
    it("is ready while both dependencies are usable (REL-008)", async () => {
      expect(rabbitMq.isUsable()).toBe(true);
      expect(await harness.database.isHealthy()).toBe(true);
    });
  });

  /**
   * Last, because it deliberately takes the broker connection down and does not bring it back.
   */
  describe("broker outage", () => {
    it("claims nothing while the broker is unusable, so no retry budget is spent", async () => {
      const id = await insertIntent();
      await rabbitMq.onModuleDestroy();

      expect(rabbitMq.isUsable()).toBe(false);
      expect(await publisher.sweepOnce()).toBe(0);

      const row = await readOutboxRow(id);
      expect(row.status).toBe("PENDING");
      expect(row.attemptCount).toBe(0);
      expect(row.lastError).toBeNull();
    });
  });
});

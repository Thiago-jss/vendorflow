import { randomUUID } from "node:crypto";
import type { ConsumeMessage } from "amqplib";
import { OutboxDeliveryRecorderConsumer } from "./outbox-delivery-recorder.consumer";
import type { ConsumerReceiptRepository } from "./consumer-receipt.repository";
import type { ConsumerDelivery, RabbitMqService } from "../messaging/rabbitmq.service";
import { topologyNames } from "../messaging/topology";

const environment = {
  CONSUMER_RETRY_DELAYS_MS: [10, 20, 30],
  OUTBOX_PUBLISH_CONFIRM_TIMEOUT_MS: 5_000,
};

const config = {
  get: (name: keyof typeof environment) => environment[name],
};

function envelopeBuffer(): Buffer {
  return Buffer.from(
    JSON.stringify({
      eventId: randomUUID(),
      schemaVersion: 1,
      eventType: "PURCHASE_REQUEST_SUBMITTED",
      occurredAt: new Date().toISOString(),
      organizationId: randomUUID(),
      aggregateType: "PurchaseRequest",
      aggregateId: randomUUID(),
      correlationId: randomUUID(),
      payload: { status: "SUBMITTED" },
    }),
    "utf8",
  );
}

/**
 * A settlement context the test controls, exactly as the messaging layer hands one over: the
 * consumer can only settle through it, and it can be closed mid-transaction to stand in for a
 * connection that died while PostgreSQL was working.
 */
function fakeDelivery(content = envelopeBuffer()) {
  let open = true;
  let settled = false;
  const calls: string[] = [];
  const message = {
    content,
    fields: {
      deliveryTag: 1,
      redelivered: false,
      exchange: "test.events",
      routingKey: "purchase_request.submitted",
      consumerTag: "fake-consumer",
    },
    properties: { headers: {} },
  } as unknown as ConsumeMessage;

  const settle = (operation: string): boolean => {
    if (settled || !open) {
      return false;
    }

    settled = true;
    calls.push(operation);

    return true;
  };

  const delivery: ConsumerDelivery = {
    message,
    isSettleable: () => !settled && open,
    ack: () => settle("ack"),
    rejectToDeadLetter: () => settle("reject"),
  };

  return {
    delivery,
    calls,
    closeChannel: () => {
      open = false;
    },
  };
}

/**
 * The consumer's half of the settlement contract: it settles through the context it was
 * handed, only after the receipt transaction commits, and it does nothing at all when that
 * context has died while the transaction was running.
 */
describe("OutboxDeliveryRecorderConsumer settlement", () => {
  const names = topologyNames("test", 3);
  let publishConfirmed: jest.Mock;
  let recordDelivery: jest.Mock;
  let consumer: OutboxDeliveryRecorderConsumer;

  beforeEach(() => {
    publishConfirmed = jest.fn().mockResolvedValue(undefined);
    recordDelivery = jest.fn().mockResolvedValue("RECORDED");

    const rabbitMq = {
      names,
      publishConfirmed,
      registerConsumer: jest.fn().mockResolvedValue(undefined),
    } as unknown as RabbitMqService;
    const receipts = {
      recordDelivery,
    } as unknown as ConsumerReceiptRepository;
    const logger = {
      setContext: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    consumer = new OutboxDeliveryRecorderConsumer(
      config as unknown as ConstructorParameters<
        typeof OutboxDeliveryRecorderConsumer
      >[0],
      rabbitMq,
      receipts,
      logger as unknown as ConstructorParameters<
        typeof OutboxDeliveryRecorderConsumer
      >[3],
    );
  });

  it("acknowledges through the delivery context, and only after the receipt commits", async () => {
    const order: string[] = [];
    const { delivery, calls } = fakeDelivery();

    recordDelivery.mockImplementation(async () => {
      order.push("commit");

      return "RECORDED";
    });

    await consumer.handle(delivery);
    order.push(...calls);

    expect(order).toEqual(["commit", "ack"]);
  });

  it("settles nothing when the delivering channel died during the transaction", async () => {
    const { delivery, calls, closeChannel } = fakeDelivery();

    // The receipt is written and committed; the connection is lost in the same instant. The
    // work is durable, the delivery tag is not, and the redelivery is absorbed by the receipt.
    recordDelivery.mockImplementation(async () => {
      closeChannel();

      return "RECORDED";
    });

    await consumer.handle(delivery);

    expect(recordDelivery).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it("does not schedule a retry it could never acknowledge", async () => {
    const { delivery, calls, closeChannel } = fakeDelivery();

    recordDelivery.mockImplementation(async () => {
      closeChannel();

      throw new Error("PostgreSQL is unreachable");
    });

    await consumer.handle(delivery);

    // Republishing to the next tier plus a redelivery of the original would put the same
    // event on the ladder twice. The broker's own redelivery is enough.
    expect(publishConfirmed).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("does not dead-letter a message it could never acknowledge", async () => {
    const { delivery, calls, closeChannel } = fakeDelivery(
      Buffer.from("not json", "utf8"),
    );

    closeChannel();
    await consumer.handle(delivery);

    expect(publishConfirmed).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("still publishes the retry and acknowledges while the channel is alive", async () => {
    const { delivery, calls } = fakeDelivery();

    recordDelivery.mockRejectedValue(new Error("PostgreSQL is unreachable"));

    await consumer.handle(delivery);

    expect(publishConfirmed).toHaveBeenCalledTimes(1);
    expect(publishConfirmed.mock.calls[0]?.[0]).toBe(names.retryExchanges[0]);
    expect(calls).toEqual(["ack"]);
  });

  it("rejects to the dead-letter route when the retry publication fails", async () => {
    const { delivery, calls } = fakeDelivery();

    recordDelivery.mockRejectedValue(new Error("PostgreSQL is unreachable"));
    publishConfirmed.mockRejectedValue(new Error("the broker refused it"));

    await consumer.handle(delivery);

    expect(calls).toEqual(["reject"]);
  });
});

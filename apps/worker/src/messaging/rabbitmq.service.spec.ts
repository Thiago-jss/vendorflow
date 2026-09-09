import { EventEmitter } from "node:events";
import { connect, type ConsumeMessage } from "amqplib";
import {
  RabbitMqService,
  type ConsumerDelivery,
} from "./rabbitmq.service";

jest.mock("amqplib", () => ({ connect: jest.fn() }));

const connectMock = connect as unknown as jest.Mock;

/**
 * A channel that remembers who acknowledged what, so a test can ask the question that
 * matters: did a delivery tag from a dead channel ever reach a live one?
 */
class FakeChannel extends EventEmitter {
  readonly ack = jest.fn();
  readonly nack = jest.fn();
  readonly prefetch = jest.fn().mockResolvedValue(undefined);
  readonly assertExchange = jest.fn().mockResolvedValue(undefined);
  readonly assertQueue = jest.fn().mockResolvedValue(undefined);
  readonly bindQueue = jest.fn().mockResolvedValue(undefined);
  readonly publish = jest.fn();
  private onMessage: ((message: ConsumeMessage | null) => void) | undefined;

  readonly consume = jest.fn(
    async (_queue: string, handler: (message: ConsumeMessage | null) => void) => {
      this.onMessage = handler;

      return { consumerTag: "fake-consumer" };
    },
  );

  deliver(message: ConsumeMessage): void {
    if (this.onMessage === undefined) {
      throw new Error("Nothing is consuming this channel");
    }

    this.onMessage(message);
  }
}

class FakeConnection extends EventEmitter {
  readonly publishChannel = new FakeChannel();
  readonly consumeChannel = new FakeChannel();

  createConfirmChannel = jest.fn(async () => this.publishChannel);
  createChannel = jest.fn(async () => this.consumeChannel);
  close = jest.fn().mockResolvedValue(undefined);

  /** What amqplib does when the socket goes: the channels die, then the connection does. */
  drop(): void {
    this.consumeChannel.emit("close");
    this.publishChannel.emit("close");
    this.emit("close");
  }
}

const environment = {
  RABBITMQ_URL: "amqp://localhost:5672",
  RABBITMQ_TOPOLOGY_PREFIX: "test",
  RABBITMQ_PREFETCH: 10,
  RABBITMQ_RECONNECT_DELAY_MS: 5,
  CONSUMER_RETRY_DELAYS_MS: [10, 20, 30],
};

const config = {
  get: (name: keyof typeof environment) => environment[name],
};

const logger = {
  setContext: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

function deliveryMessage(deliveryTag: number): ConsumeMessage {
  return {
    content: Buffer.from("{}", "utf8"),
    fields: {
      deliveryTag,
      redelivered: false,
      exchange: "test.events",
      routingKey: "purchase_request.submitted",
      consumerTag: "fake-consumer",
    },
    properties: { headers: {} },
  } as unknown as ConsumeMessage;
}

async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A handler the test finishes on demand, standing in for a slow PostgreSQL transaction. */
function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

/**
 * The settlement boundary, and only the settlement boundary.
 *
 * A delivery tag is meaningful only on the channel that issued it. These tests hold the
 * dangerous sequence still — deliver on A, keep the handler pending, lose the connection,
 * let the reconnect install B, then finish the handler — and check that nothing from A's
 * lifetime is ever applied to B.
 */
describe("RabbitMqService delivery settlement", () => {
  let service: RabbitMqService;
  let connections: FakeConnection[];

  beforeEach(() => {
    connections = [];
    connectMock.mockReset();
    connectMock.mockImplementation(async () => {
      const connection = new FakeConnection();
      connections.push(connection);

      return connection;
    });
    logger.warn.mockClear();

    service = new RabbitMqService(
      config as unknown as ConstructorParameters<typeof RabbitMqService>[0],
      logger as unknown as ConstructorParameters<typeof RabbitMqService>[1],
    );
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  async function start(handler: (delivery: ConsumerDelivery) => Promise<void>) {
    service.onApplicationBootstrap();
    await waitFor(() => service.isUsable(), "the first connection");
    await service.registerConsumer("test.purchase-request-events", handler);
  }

  async function reconnect(): Promise<FakeConnection> {
    const previous = connections.length;
    connections[previous - 1]?.drop();
    await waitFor(
      () => connections.length > previous && service.isUsable(),
      "the replacement connection",
    );

    return connections[connections.length - 1] as FakeConnection;
  }

  it("acknowledges on the channel that delivered the message", async () => {
    const gate = deferred();
    const settled: boolean[] = [];

    await start(async (delivery) => {
      await gate.promise;
      settled.push(delivery.ack());
    });

    const first = connections[0] as FakeConnection;
    const message = deliveryMessage(1);

    first.consumeChannel.deliver(message);
    gate.resolve();
    await waitFor(() => settled.length === 1, "the handler to settle");

    expect(settled[0]).toBe(true);
    expect(first.consumeChannel.ack).toHaveBeenCalledWith(message);
  });

  it("never acknowledges a dead channel's delivery on its replacement", async () => {
    const gate = deferred();
    const settled: boolean[] = [];

    await start(async (delivery) => {
      await gate.promise;
      settled.push(delivery.ack());
    });

    const first = connections[0] as FakeConnection;
    const message = deliveryMessage(7);

    first.consumeChannel.deliver(message);

    const replacement = await reconnect();

    // The handler only now finishes, holding a delivery tag that belongs to a channel which
    // no longer exists. On the replacement channel that same tag would settle a stranger.
    gate.resolve();
    await waitFor(() => settled.length === 1, "the handler to settle");

    expect(settled[0]).toBe(false);
    expect(replacement.consumeChannel.ack).not.toHaveBeenCalled();
    expect(replacement.consumeChannel.nack).not.toHaveBeenCalled();
    expect(first.consumeChannel.ack).not.toHaveBeenCalled();
    expect(first.consumeChannel.nack).not.toHaveBeenCalled();
  });

  it("never rejects a dead channel's delivery on its replacement", async () => {
    const gate = deferred();

    await start(async (delivery) => {
      // Touching the delivery keeps the parameter honest: the handler holds the context, and
      // the service's own failure path must still use that context and not a current channel.
      expect(delivery.message.fields.deliveryTag).toBe(9);
      await gate.promise;
    });

    const first = connections[0] as FakeConnection;

    first.consumeChannel.deliver(deliveryMessage(9));

    const replacement = await reconnect();

    // A handler that throws after the reconnect: the service's backstop rejection must find
    // the channel gone rather than nack a tag on the new one.
    gate.reject(new Error("handler could not classify the message"));
    await waitFor(
      () =>
        logger.warn.mock.calls.some((call) =>
          String(call[1]).includes("closed before settlement"),
        ),
      "the skipped settlement to be reported",
    );

    expect(replacement.consumeChannel.nack).not.toHaveBeenCalled();
    expect(replacement.consumeChannel.ack).not.toHaveBeenCalled();
    expect(first.consumeChannel.nack).not.toHaveBeenCalled();
  });

  it("keeps each delivery on its own channel across a reconnect", async () => {
    const gates = [deferred(), deferred()];
    const deliveries: ConsumerDelivery[] = [];

    await start(async (delivery) => {
      const gate = gates[deliveries.length];
      deliveries.push(delivery);
      await gate?.promise;
      delivery.ack();
    });

    const first = connections[0] as FakeConnection;
    const oldMessage = deliveryMessage(3);

    first.consumeChannel.deliver(oldMessage);

    const replacement = await reconnect();
    const newMessage = deliveryMessage(3);

    // Deliberately the same delivery tag: on the broker's side these are unrelated messages
    // on unrelated channels, and only the capture at delivery time can tell them apart.
    replacement.consumeChannel.deliver(newMessage);
    gates[1]?.resolve();
    await waitFor(
      () => replacement.consumeChannel.ack.mock.calls.length === 1,
      "the new delivery to be acknowledged",
    );

    gates[0]?.resolve();
    await waitFor(() => deliveries.length === 2, "both handlers to run");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(replacement.consumeChannel.ack).toHaveBeenCalledTimes(1);
    expect(replacement.consumeChannel.ack).toHaveBeenCalledWith(newMessage);
    expect(first.consumeChannel.ack).not.toHaveBeenCalled();
  });

  it("reports a closed delivering channel as unsettleable before any work is attempted", async () => {
    const gate = deferred();
    const observed: boolean[] = [];

    await start(async (delivery) => {
      await gate.promise;
      observed.push(delivery.isSettleable());
    });

    const first = connections[0] as FakeConnection;

    first.consumeChannel.deliver(deliveryMessage(11));
    await reconnect();
    gate.resolve();
    await waitFor(() => observed.length === 1, "the handler to check the context");

    expect(observed[0]).toBe(false);
  });

  it("settles a delivery once", async () => {
    const gate = deferred();
    const results: boolean[] = [];

    await start(async (delivery) => {
      await gate.promise;
      results.push(delivery.ack());
      results.push(delivery.ack());
      results.push(delivery.rejectToDeadLetter());
    });

    const first = connections[0] as FakeConnection;

    first.consumeChannel.deliver(deliveryMessage(2));
    gate.resolve();
    await waitFor(() => results.length === 3, "the handler to settle");

    expect(results).toEqual([true, false, false]);
    expect(first.consumeChannel.ack).toHaveBeenCalledTimes(1);
    expect(first.consumeChannel.nack).not.toHaveBeenCalled();
  });

  it("is unusable while the consuming channel is gone", async () => {
    await start(async () => undefined);

    const first = connections[0] as FakeConnection;

    first.drop();

    expect(service.isUsable()).toBe(false);
  });
});

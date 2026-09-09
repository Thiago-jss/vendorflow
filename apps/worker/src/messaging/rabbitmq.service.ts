import {
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  connect,
  type Channel,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
  type Options,
} from "amqplib";
import { PinoLogger } from "nestjs-pino";
import type { Environment } from "../config/env";
import { assertTopology, topologyNames, type TopologyNames } from "./topology";

/** The broker is not usable right now. The caller retries later; it does not lose work. */
export class BrokerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerUnavailableError";
  }
}

/**
 * The broker accepted the publication but no queue was bound to route it. A confirmed message
 * nobody can receive is a topology defect, and treating it as success would hide it.
 */
export class UnroutableMessageError extends Error {
  constructor(routingKey: string) {
    super(`No queue is bound for routing key ${routingKey}`);
    this.name = "UnroutableMessageError";
  }
}

/**
 * The confirm did not arrive in time, the channel closed, or the broker returned a nack. The
 * publication is **ambiguous**: it may or may not have reached a queue.
 *
 * This is the single most important error in the pipeline, because how it is handled is what
 * makes delivery at-least-once. It is never treated as success (which would lose the fact) and
 * never assumed to be a failure that undid itself (there is no such thing). The row stays
 * eligible, and a duplicate is the accepted price (REL-003).
 */
export class AmbiguousPublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousPublicationError";
  }
}

/**
 * A delivery, and the only two things that may be done with it, bound at delivery time to the
 * exact channel that carried it.
 *
 * An AMQP delivery tag means nothing outside the channel that issued it. Tag 3 on a channel
 * that has since closed is not "that message": on a replacement channel it is whatever that
 * channel happened to deliver third, or nothing at all. Settling through a mutable "current
 * channel" field therefore risks acknowledging a stranger's delivery — the one failure mode
 * that turns at-least-once into silent loss.
 *
 * So the settlement context travels with the delivery instead of being looked up afterwards,
 * and a delivery whose channel has closed is not settled at all. RabbitMQ requeues everything
 * left unacknowledged on a closed channel by itself; letting it do that is both correct and
 * free, and the durable receipt absorbs the redelivery.
 */
export interface ConsumerDelivery {
  readonly message: ConsumeMessage;
  /** False once the delivering channel is gone, or once this delivery has been settled. */
  isSettleable(): boolean;
  /** Acknowledges on the delivering channel. Reports whether the settlement happened. */
  ack(): boolean;
  /**
   * Rejects without requeue on the delivering channel, so the queue's own dead-letter route
   * takes it. `requeue: true` is never used anywhere in this worker — an immediate requeue is
   * a hot loop with no backoff, which is the failure mode REL-006 exists to prevent.
   */
  rejectToDeadLetter(): boolean;
}

export type ConsumerHandler = (delivery: ConsumerDelivery) => Promise<void>;

interface ConsumerRegistration {
  readonly queue: string;
  readonly handler: ConsumerHandler;
}

/**
 * One consuming channel, and whether it is still the channel it was.
 *
 * The identity is the object: a reconnect builds a new session and the old one stays closed
 * for good. Nothing can refresh a session into pointing at a replacement channel, which is
 * exactly what stops a delivery captured under it from leaking onto a later connection.
 */
class ConsumeSession {
  private open = true;

  constructor(readonly channel: Channel) {
    // 'error' is listened to as well as 'close': an unhandled channel error is a process-level
    // throw in amqplib, and a channel that has errored is already unusable for settlement.
    channel.on("close", () => this.close());
    channel.on("error", () => this.close());
  }

  get isOpen(): boolean {
    return this.open;
  }

  close(): void {
    this.open = false;
  }
}

/**
 * The worker's only contact with RabbitMQ. Everything above it — the relay, the consumer —
 * speaks in exchanges, routing keys and buffers, and never sees an `amqplib` type.
 *
 * Two channels, deliberately. Publishing needs confirms; consuming needs prefetch and
 * acknowledgement, and a channel that dies handling a message must not take the relay's
 * confirms with it.
 *
 * Connecting never blocks startup and a lost connection never ends the process. A broker
 * outage must not crash-loop a worker whose other half — the PostgreSQL outbox — is still
 * accumulating work perfectly well (REL-007). Readiness reports it instead (REL-008).
 */
@Injectable()
export class RabbitMqService implements OnApplicationBootstrap, OnModuleDestroy {
  private connection: ChannelModel | undefined;
  private publishChannel: ConfirmChannel | undefined;
  private consumeSession: ConsumeSession | undefined;
  private connecting = false;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly consumers: ConsumerRegistration[] = [];
  /**
   * Message identifiers RabbitMQ handed back as unroutable. A `basic.return` for a mandatory
   * publication precedes its `basic.ack`, so the confirm callback can ask whether this exact
   * message came back before deciding the publication succeeded.
   */
  private readonly returnedMessageIds = new Set<string>();
  readonly names: TopologyNames;

  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RabbitMqService.name);
    this.names = topologyNames(
      this.config.get("RABBITMQ_TOPOLOGY_PREFIX", { infer: true }),
      this.config.get("CONSUMER_RETRY_DELAYS_MS", { infer: true }).length,
    );
  }

  onApplicationBootstrap(): void {
    void this.connectOnce();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;

    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const connection = this.connection;
    this.connection = undefined;
    this.publishChannel = undefined;
    this.consumeSession?.close();
    this.consumeSession = undefined;

    try {
      await connection?.close();
    } catch (error: unknown) {
      this.logger.warn({ err: error }, "RabbitMQ connection close failed");
    }
  }

  /** REL-008. Usable means both channels exist, not merely that a socket once opened. */
  isUsable(): boolean {
    return (
      this.connection !== undefined &&
      this.publishChannel !== undefined &&
      this.consumeSession?.isOpen === true
    );
  }

  /**
   * Registers a durable consumer. Safe to call before the broker is reachable: the
   * registration is remembered and re-established on every reconnect, so a consumer does not
   * have to know whether it started before or after the connection did.
   */
  async registerConsumer(
    queue: string,
    handler: ConsumerHandler,
  ): Promise<void> {
    this.consumers.push({ queue, handler });

    const session = this.consumeSession;

    if (session !== undefined && session.isOpen) {
      await this.startConsumer(session, { queue, handler });
    }
  }

  /**
   * Publishes and waits for the broker to confirm, with `mandatory` set so an unroutable
   * message is an error rather than a silent discard.
   *
   * Every outcome that is not an explicit confirm is reported as ambiguous. The caller must
   * treat ambiguity as "not published" and stay eligible for retry; that is what makes a
   * crash-after-confirm produce a duplicate instead of a loss.
   */
  async publishConfirmed(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Options.Publish,
    confirmTimeoutMs: number,
  ): Promise<void> {
    const channel = this.publishChannel;

    if (channel === undefined) {
      throw new BrokerUnavailableError("No publish channel is open");
    }

    const messageId = options.messageId;

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);

        if (error === undefined) {
          resolve();
          return;
        }

        reject(error);
      };

      const timer = setTimeout(
        () =>
          finish(
            new AmbiguousPublicationError(
              "The broker did not confirm the publication in time",
            ),
          ),
        confirmTimeoutMs,
      );

      try {
        channel.publish(
          exchange,
          routingKey,
          content,
          { ...options, persistent: true, mandatory: true },
          (error) => {
            if (error !== null) {
              finish(
                new AmbiguousPublicationError(
                  "The broker did not acknowledge the publication",
                ),
              );
              return;
            }

            if (
              messageId !== undefined &&
              this.returnedMessageIds.delete(messageId)
            ) {
              finish(new UnroutableMessageError(routingKey));
              return;
            }

            finish();
          },
        );
      } catch (error: unknown) {
        finish(
          new AmbiguousPublicationError(
            error instanceof Error
              ? error.message
              : "The publish channel rejected the publication",
          ),
        );
      }
    });
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped || this.connecting || this.connection !== undefined) {
      return;
    }

    this.connecting = true;

    try {
      const connection = await connect(
        this.config.get("RABBITMQ_URL", { infer: true }),
      );

      connection.on("error", (error: Error) => {
        this.logger.error({ err: error }, "RabbitMQ connection error");
      });
      connection.on("close", () => {
        this.logger.warn("RabbitMQ connection closed");
        this.handleConnectionLost();
      });

      const publishChannel = await connection.createConfirmChannel();
      publishChannel.on("return", (message) => {
        const messageId = message.properties.messageId;

        if (typeof messageId === "string") {
          this.returnedMessageIds.add(messageId);
        }
      });

      await assertTopology(
        publishChannel,
        this.names,
        this.config.get("CONSUMER_RETRY_DELAYS_MS", { infer: true }),
      );

      const consumeChannel = await connection.createChannel();
      await consumeChannel.prefetch(
        this.config.get("RABBITMQ_PREFETCH", { infer: true }),
      );

      const consumeSession = new ConsumeSession(consumeChannel);

      this.connection = connection;
      this.publishChannel = publishChannel;
      this.consumeSession = consumeSession;

      for (const registration of this.consumers) {
        await this.startConsumer(consumeSession, registration);
      }

      this.logger.info(
        { exchange: this.names.eventsExchange },
        "RabbitMQ connection established and topology asserted",
      );
    } catch (error: unknown) {
      this.logger.error(
        { err: error },
        "RabbitMQ connection attempt failed; the outbox keeps accumulating",
      );
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private handleConnectionLost(): void {
    this.connection = undefined;
    this.publishChannel = undefined;
    // Closed, not merely forgotten. Handlers still running hold this session, and marking it
    // closed is what tells them their delivery tags died with the connection.
    this.consumeSession?.close();
    this.consumeSession = undefined;
    this.returnedMessageIds.clear();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectOnce();
    }, this.config.get("RABBITMQ_RECONNECT_DELAY_MS", { infer: true }));
    this.reconnectTimer.unref();
  }

  private async startConsumer(
    session: ConsumeSession,
    registration: ConsumerRegistration,
  ): Promise<void> {
    await session.channel.consume(
      registration.queue,
      (message) => {
        if (message === null) {
          return;
        }

        const delivery = this.createDelivery(session, message);

        void registration.handler(delivery).catch((error: unknown) => {
          // The handler owns retry and dead-lettering. Reaching here means it failed while
          // deciding what to do, so the message goes down the queue's own dead-letter route
          // rather than being dropped or requeued in a loop.
          this.logger.error(
            { err: error, queue: registration.queue },
            "Consumer handler failed to classify a message",
          );
          delivery.rejectToDeadLetter();
        });
      },
      { noAck: false },
    );
  }

  /**
   * Captures the settlement context at delivery time.
   *
   * The channel is held by the closure and can never be swapped, so an `ack` issued long
   * after a reconnect either reaches the channel that delivered the message or reaches
   * nothing at all. It never reaches the replacement.
   */
  private createDelivery(
    session: ConsumeSession,
    message: ConsumeMessage,
  ): ConsumerDelivery {
    let settled = false;

    const settle = (
      apply: (channel: Channel) => void,
      operation: "ack" | "reject",
    ): boolean => {
      if (settled) {
        this.logger.warn(
          { operation, deliveryTag: message.fields.deliveryTag },
          "Delivery was already settled; ignoring a second settlement",
        );

        return false;
      }

      if (!session.isOpen) {
        // Deliberately not settled anywhere. The tag belongs to a channel that no longer
        // exists, the broker has already requeued the delivery, and applying the tag to the
        // replacement channel would settle whatever it delivered under the same number.
        this.logger.warn(
          { operation, deliveryTag: message.fields.deliveryTag },
          "The delivering channel closed before settlement; leaving the message to be redelivered",
        );

        return false;
      }

      try {
        apply(session.channel);
        settled = true;

        return true;
      } catch (error: unknown) {
        // The channel died between the check and the call — the same situation, one instant
        // later, and the same answer.
        this.logger.warn(
          { err: error, operation, deliveryTag: message.fields.deliveryTag },
          "Settlement failed on the delivering channel; leaving the message to be redelivered",
        );

        return false;
      }
    };

    return {
      message,
      isSettleable: () => !settled && session.isOpen,
      ack: () => settle((channel) => channel.ack(message), "ack"),
      rejectToDeadLetter: () =>
        settle((channel) => channel.nack(message, false, false), "reject"),
    };
  }
}

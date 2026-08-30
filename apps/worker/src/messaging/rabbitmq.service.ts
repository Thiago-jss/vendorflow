import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { connect, type ChannelModel } from "amqplib";
import { PinoLogger } from "nestjs-pino";
import type { Environment } from "../config/env";

@Injectable()
export class RabbitMqService implements OnApplicationBootstrap, OnModuleDestroy {
  private connection: ChannelModel | undefined;

  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(RabbitMqService.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    const url = this.config.get("RABBITMQ_URL", { infer: true });
    const connection = await connect(url);
    this.connection = connection;
    connection.on("error", (error: Error) => {
      this.logger.error({ err: error }, "RabbitMQ connection error");
    });
    connection.on("close", () => {
      this.logger.warn("RabbitMQ connection closed");
    });
    this.logger.info("RabbitMQ connection established");
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.close();
  }
}

import { Module } from "@nestjs/common";
import { DatabaseModule } from "@vendorflow/database";
import { RabbitMqModule } from "../messaging/rabbitmq.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [DatabaseModule, RabbitMqModule],
  controllers: [HealthController]
})
export class HealthModule {}

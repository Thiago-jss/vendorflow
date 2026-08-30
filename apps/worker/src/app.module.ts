import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { ApplicationConfigModule } from "./config/config.module";
import { RabbitMqModule } from "./messaging/rabbitmq.module";

@Module({
  imports: [
    ApplicationConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === "production" ? "info" : "debug",
        redact: {
          paths: ["password", "token", "accessToken", "refreshToken", "authorization", "cookie"],
          censor: "[REDACTED]"
        }
      }
    }),
    RabbitMqModule
  ]
})
export class AppModule {}

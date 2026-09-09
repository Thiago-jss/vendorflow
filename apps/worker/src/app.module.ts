import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { ApplicationConfigModule } from "./config/config.module";
import { HealthModule } from "./health/health.module";
import { OutboxModule } from "./outbox/outbox.module";

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
    OutboxModule,
    HealthModule
  ]
})
export class AppModule {}

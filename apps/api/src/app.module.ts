import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { ApplicationConfigModule } from "./config/config.module";
import { HealthModule } from "./health/health.module";
import { PrismaModule } from "./platform/prisma/prisma.module";

@Module({
  imports: [
    ApplicationConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === "production" ? "info" : "debug",
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "req.body.password",
            "req.body.token",
            "req.body.accessToken",
            "req.body.refreshToken",
            "res.headers['set-cookie']"
          ],
          censor: "[REDACTED]"
        },
        customProps: (request) => ({ correlationId: request.id })
      }
    }),
    PrismaModule,
    HealthModule
  ]
})
export class AppModule {}

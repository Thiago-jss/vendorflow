import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { ApplicationConfigModule } from "./config/config.module";
import { HealthModule } from "./health/health.module";
import { IdentityAccessModule } from "./identity-access/identity-access.module";
import { ProcurementModule } from "./procurement/procurement.module";
import { TenantContextModule } from "./platform/tenancy/tenant-context.module";

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
            // The whole body, not selected fields: an auth body is credentials end to
            // end, and a field-by-field list silently misses the next field added.
            "req.body",
            "res.headers['set-cookie']",
          ],
          censor: "[REDACTED]",
        },
        customProps: (request) => ({ correlationId: request.id }),
      },
    }),
    TenantContextModule,
    IdentityAccessModule,
    ProcurementModule,
    HealthModule,
  ],
})
export class AppModule {}

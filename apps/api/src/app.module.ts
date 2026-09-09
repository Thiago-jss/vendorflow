import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { ApplicationConfigModule } from "./config/config.module";
import { HealthModule } from "./health/health.module";
import { IdentityAccessModule } from "./identity-access/identity-access.module";
import { ProcurementModule } from "./procurement/procurement.module";
import {
  CORRELATION_HEADER,
  newCorrelationId,
} from "./platform/correlation/correlation-context";
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
        // NFR-008. The default generator is a per-process counter, which cannot identify a
        // request across a restart, across two API instances, or in the outbox row a request
        // leaves behind. A UUID can. `req.id` is reused when the correlation middleware has
        // already minted one, so the log line and the message always agree.
        genReqId: (request, response) => {
          const existing = (request as { id?: unknown }).id;

          if (typeof existing === "string") {
            return existing;
          }

          const correlationId = newCorrelationId();
          response.setHeader(CORRELATION_HEADER, correlationId);

          return correlationId;
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

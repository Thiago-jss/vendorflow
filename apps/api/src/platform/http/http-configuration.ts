import { ValidationPipe, type INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import type { Environment } from "../../config/env";
import { correlationMiddleware } from "../correlation/correlation.middleware";
import { configureOpenApi } from "./openapi";
import { SanitizedExceptionFilter } from "./sanitized-exception.filter";

/**
 * The single definition of the HTTP pipeline, shared by the production bootstrap and by
 * integration tests. Security behaviour that only exists in `main.ts` is behaviour no test
 * can prove, so CORS, cookie parsing, validation and error sanitization are configured here.
 */
export function configureHttpApplication(
  application: INestApplication,
  environment: Pick<Environment, "CORS_ORIGINS">,
): void {
  // First, so every later layer — including the error filter — runs inside a request that
  // already has a correlation identifier bound to it (NFR-008).
  application.use(correlationMiddleware);
  application.use(helmet());
  // Signed cookies are deliberately unused: the refresh token is opaque and its authority
  // comes from the server-side session row, not from a signature the client carries.
  application.use(cookieParser());
  application.enableCors({
    origin: environment.CORS_ORIGINS,
    credentials: true,
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  });
  application.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  application.useGlobalFilters(new SanitizedExceptionFilter());
  // After the pipes, so the document is built from the same application the pipeline runs.
  // Configured here rather than only in `main.ts` for the same reason as everything else in
  // this function: a contract that only exists in the production bootstrap is a contract no
  // test can prove (NFR-009).
  configureOpenApi(application);
}

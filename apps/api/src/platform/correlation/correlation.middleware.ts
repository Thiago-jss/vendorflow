import type { NextFunction, Request, Response } from "express";
import {
  CORRELATION_HEADER,
  newCorrelationId,
  runWithCorrelationId,
} from "./correlation-context";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Binds one correlation identifier to the request and to every asynchronous continuation of
 * it, and echoes it so a caller reporting a problem can quote it.
 *
 * The identifier is **generated server-side and never read from the request**. A client-
 * supplied correlation header is attacker-controlled text that would end up in log lines and
 * in a durable outbox row, and nothing in this system needs a client to choose it.
 *
 * The one value it adopts is `request.id`, which `pino-http` may already have generated from
 * this application's own `genReqId`. Ordering between the logger and this function is
 * therefore irrelevant: whichever runs first mints the identifier and the other reuses it, so
 * the log line and the outbox row always carry the same value.
 *
 * It is installed as plain middleware in `configureHttpApplication` rather than through
 * `MiddlewareConsumer`, for the same reason everything else in that function is: a request
 * property that only exists in the production bootstrap is a property no test can prove.
 */
export function correlationMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const carrier = request as Request & { id?: unknown };
  const existing = carrier.id;
  const correlationId =
    typeof existing === "string" && UUID_PATTERN.test(existing)
      ? existing
      : newCorrelationId();

  carrier.id = correlationId;

  if (!response.headersSent) {
    response.setHeader(CORRELATION_HEADER, correlationId);
  }

  runWithCorrelationId(correlationId, next);
}

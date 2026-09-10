import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

/** REL-004's header, spelled once. */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/**
 * Reads the raw `Idempotency-Key` header and hands it to the use case, which validates and
 * hashes it immediately.
 *
 * It is a parameter decorator rather than a guard or an interceptor because the key is an
 * *input to the operation*, not a gate on it: whether a key is usable is a question about the
 * request's meaning, and the answer belongs to the same use case that decides what the request
 * means. The header is never logged — the request-logger redaction list covers headers it is
 * told about, and this value is simply never written anywhere.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    const header = context
      .switchToHttp()
      .getRequest<Request>()
      .header(IDEMPOTENCY_KEY_HEADER);

    return header === undefined || header.length === 0 ? undefined : header;
  },
);

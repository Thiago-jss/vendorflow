import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  IdempotencyKeyConflictError,
  IdempotencyKeyInvalidError,
  IdempotencyReservationConflictError,
} from "../../application/contracts/idempotency.errors";

/**
 * REL-004's two client-visible failures, translated once.
 *
 * Every route that requires an Idempotency-Key can fail in exactly these ways, and a
 * translation copied into four controllers is four chances for one of them to answer
 * differently — which for a header a client retries on would be a genuinely confusing
 * inconsistency. So the mapping lives here and each controller's error translation defers to
 * it before its own module-specific cases.
 *
 * - A missing or malformed key is a **400**: the request is not well formed, and no business
 *   logic ran.
 * - A key reused for a different semantic request is a **409**: failing closed is the whole
 *   point (REL-004), because replaying would report an event that did not happen and executing
 *   would defeat the key.
 * - A lost reservation whose winner then rolled back is also a **409**, and genuinely
 *   retryable: nothing happened under that key after all.
 *
 * No message here ever contains the submitted key (SEC-009).
 */
export function rethrowIdempotencyFailure(error: unknown): void {
  if (error instanceof IdempotencyKeyInvalidError) {
    throw new BadRequestException(error.message);
  }

  if (
    error instanceof IdempotencyKeyConflictError ||
    error instanceof IdempotencyReservationConflictError
  ) {
    throw new ConflictException(error.message);
  }
}

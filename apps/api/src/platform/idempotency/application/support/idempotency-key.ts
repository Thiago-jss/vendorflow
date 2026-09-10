import { createHash, timingSafeEqual } from "node:crypto";
import { IdempotencyKeyInvalidError } from "../contracts/idempotency.errors";
import type { IdempotentOperation } from "../contracts/idempotent-operation";

/**
 * REL-004's key is an **opaque bounded token**, and this file is the only place that has an
 * opinion about it.
 *
 * Deliberately not a UUID: forcing a shape on a client-chosen token buys nothing — the token
 * is never parsed, only compared — and would refuse perfectly good keys such as a request
 * identifier from the caller's own tracing system. What is enforced is what actually matters:
 * it is present, it is bounded, and it carries no whitespace or control characters that could
 * be smuggled into a log line or a header echo.
 */
export const MINIMUM_IDEMPOTENCY_KEY_LENGTH = 8;
export const MAXIMUM_IDEMPOTENCY_KEY_LENGTH = 200;

/** Printable ASCII without whitespace. A key is a token, not a sentence. */
const IDEMPOTENCY_KEY_PATTERN = /^[!-~]+$/;

/** SHA-256, so the persisted digest is fixed width and the raw key is unrecoverable. */
const DIGEST_ALGORITHM = "sha256";

/** Field separator that cannot occur inside a length prefix, so the join is unambiguous. */
const FINGERPRINT_SEPARATOR = " ";

/**
 * Validates and digests in one step, because there is no legitimate use for a validated raw
 * key: the caller needs the digest, and every extra place the raw value travels is a place it
 * can be logged.
 */
export function hashIdempotencyKey(key: string | undefined): Buffer {
  if (key === undefined || key.length === 0) {
    throw new IdempotencyKeyInvalidError(
      "An Idempotency-Key header is required for this operation",
    );
  }

  if (
    key.length < MINIMUM_IDEMPOTENCY_KEY_LENGTH ||
    key.length > MAXIMUM_IDEMPOTENCY_KEY_LENGTH ||
    !IDEMPOTENCY_KEY_PATTERN.test(key)
  ) {
    throw new IdempotencyKeyInvalidError(
      `An Idempotency-Key must be ${MINIMUM_IDEMPOTENCY_KEY_LENGTH} to ${MAXIMUM_IDEMPOTENCY_KEY_LENGTH} printable non-whitespace characters`,
    );
  }

  return createHash(DIGEST_ALGORITHM).update(key, "utf8").digest();
}

/**
 * The **semantic** fingerprint: what the request asks the system to do, not how it was
 * written.
 *
 * The parts are supplied by the use case after validation and normalization, so a body whose
 * fields arrived in a different order or with different surrounding whitespace produces the
 * same fingerprint, while a genuinely different intent produces a different one. Route
 * resource identifiers are parts too: selecting quote A and selecting quote B are different
 * requests even under one key.
 *
 * Free text — a rejection reason, a selection rationale — is included here and stored nowhere.
 * It changes the outcome, so it must change the fingerprint, and a digest is how it does that
 * without the text ever being persisted.
 */
export function fingerprintSemanticRequest(input: {
  readonly organizationId: string;
  readonly actorId: string;
  readonly operation: IdempotentOperation;
  readonly parts: readonly string[];
}): Buffer {
  const digest = createHash(DIGEST_ALGORITHM);

  // Every part is length-prefixed as well as separated, so no arrangement of parts can be
  // rewritten into a different arrangement with the same digest.
  for (const part of [
    input.organizationId,
    input.actorId,
    input.operation,
    ...input.parts,
  ]) {
    digest.update(
      `${part.length}${FINGERPRINT_SEPARATOR}${part}${FINGERPRINT_SEPARATOR}`,
      "utf8",
    );
  }

  return digest.digest();
}

/**
 * Constant time, out of habit rather than necessity: anyone able to compare fingerprints byte
 * by byte would already have to know the actor's own key. The habit is cheap, and the
 * alternative is a comparison someone later copies somewhere it does matter.
 */
export function digestsMatch(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

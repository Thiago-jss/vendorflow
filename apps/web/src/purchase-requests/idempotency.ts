/**
 * REL-004's key, from the browser's side.
 *
 * The lifecycle is the whole point. A key is minted when the user first expresses an intent,
 * it survives every retry of *that* intent — including a retry after a timeout, where the
 * browser cannot know whether the first attempt was applied — and it is discarded as soon as
 * the API answers definitively or the intent itself changes.
 *
 * The fingerprint is what "the same intent" means here: the resource and the version of it
 * the user is acting on. Submitting request A and submitting request B are different intents,
 * and so is submitting the same request after editing it.
 *
 * The key lives in memory for as long as the intent does. It is never stored, never put in a
 * URL and never logged: a key is a credential for replaying a durable operation.
 */
export interface IdempotencyKeyStore {
  keyFor(fingerprint: string): string;
  currentKey(): string | null;
  discard(): void;
}

function generateOpaqueKey(): string {
  return globalThis.crypto.randomUUID();
}

export function createIdempotencyKeyStore(
  generateKey: () => string = generateOpaqueKey
): IdempotencyKeyStore {
  let currentFingerprint: string | null = null;
  let key: string | null = null;

  return {
    keyFor(fingerprint: string): string {
      if (key === null || currentFingerprint !== fingerprint) {
        currentFingerprint = fingerprint;
        key = generateKey();
      }

      return key;
    },

    currentKey(): string | null {
      return key;
    },

    discard(): void {
      currentFingerprint = null;
      key = null;
    }
  };
}

/**
 * The intent behind a submission: this request, in the state the browser last read. An edit
 * moves `updatedAt`, so the retry of a stale intent cannot reuse the earlier key.
 */
export function submissionFingerprint(request: {
  readonly id: string;
  readonly updatedAt: string;
}): string {
  return `submit:${request.id}:${request.updatedAt}`;
}

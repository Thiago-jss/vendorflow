import { describe, expect, it, vi } from "vitest";
import { createIdempotencyKeyStore, submissionFingerprint } from "./idempotency";

function countingGenerator() {
  let issued = 0;

  return () => {
    issued += 1;

    return `key-${issued}`;
  };
}

describe("idempotency key lifecycle", () => {
  it("keeps one key for repeated attempts at the same intent", () => {
    const store = createIdempotencyKeyStore(countingGenerator());
    const fingerprint = submissionFingerprint({
      id: "request-1",
      updatedAt: "2026-09-10T12:00:00.000Z"
    });

    expect(store.keyFor(fingerprint)).toBe("key-1");
    expect(store.keyFor(fingerprint)).toBe("key-1");
    expect(store.keyFor(fingerprint)).toBe("key-1");
  });

  it("mints a new key once the intent changes", () => {
    const store = createIdempotencyKeyStore(countingGenerator());

    expect(
      store.keyFor(
        submissionFingerprint({ id: "request-1", updatedAt: "2026-09-10T12:00:00.000Z" })
      )
    ).toBe("key-1");
    expect(
      store.keyFor(
        submissionFingerprint({ id: "request-1", updatedAt: "2026-09-10T12:05:00.000Z" })
      )
    ).toBe("key-2");
    expect(
      store.keyFor(
        submissionFingerprint({ id: "request-2", updatedAt: "2026-09-10T12:05:00.000Z" })
      )
    ).toBe("key-3");
  });

  it("mints a new key after a definitive answer discards the previous one", () => {
    const store = createIdempotencyKeyStore(countingGenerator());
    const fingerprint = submissionFingerprint({
      id: "request-1",
      updatedAt: "2026-09-10T12:00:00.000Z"
    });

    expect(store.keyFor(fingerprint)).toBe("key-1");

    store.discard();

    expect(store.currentKey()).toBeNull();
    expect(store.keyFor(fingerprint)).toBe("key-2");
  });

  it("issues an opaque bounded key by default", () => {
    const randomUUID = vi.spyOn(globalThis.crypto, "randomUUID");
    const store = createIdempotencyKeyStore();
    const key = store.keyFor("submit:request-1:2026-09-10T12:00:00.000Z");

    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(200);
    expect(key).toMatch(/^\S+$/);

    randomUUID.mockRestore();
  });
});

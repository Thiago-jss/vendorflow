import { IdempotencyKeyInvalidError } from "../contracts/idempotency.errors";
import type { IdempotentOperation } from "../contracts/idempotent-operation";
import {
  MAXIMUM_IDEMPOTENCY_KEY_LENGTH,
  MINIMUM_IDEMPOTENCY_KEY_LENGTH,
  digestsMatch,
  fingerprintSemanticRequest,
  hashIdempotencyKey,
} from "./idempotency-key";

const KEY = "1c1c9f6b-8d6e-4e5a-9a1c-2b3c4d5e6f70";

interface FingerprintIdentity {
  readonly organizationId: string;
  readonly actorId: string;
  readonly operation: IdempotentOperation;
}

const BASE: FingerprintIdentity = {
  organizationId: "organization-a",
  actorId: "user-a",
  operation: "QUOTE_SELECTION",
};

function fingerprint(
  parts: readonly string[],
  overrides: Partial<FingerprintIdentity> = {},
): Buffer {
  return fingerprintSemanticRequest({ ...BASE, ...overrides, parts });
}

describe("REL-004 key validation", () => {
  it("requires a key and says so rather than proceeding without one", () => {
    expect(() => hashIdempotencyKey(undefined)).toThrow(
      IdempotencyKeyInvalidError,
    );
    expect(() => hashIdempotencyKey("")).toThrow(IdempotencyKeyInvalidError);
  });

  it("bounds the token at both ends", () => {
    expect(() =>
      hashIdempotencyKey("a".repeat(MINIMUM_IDEMPOTENCY_KEY_LENGTH - 1)),
    ).toThrow(IdempotencyKeyInvalidError);
    expect(() =>
      hashIdempotencyKey("a".repeat(MAXIMUM_IDEMPOTENCY_KEY_LENGTH + 1)),
    ).toThrow(IdempotencyKeyInvalidError);
    expect(() =>
      hashIdempotencyKey("a".repeat(MAXIMUM_IDEMPOTENCY_KEY_LENGTH)),
    ).not.toThrow();
  });

  it("refuses whitespace and control characters, which do not belong in a header token", () => {
    expect(() => hashIdempotencyKey("has a space")).toThrow(
      IdempotencyKeyInvalidError,
    );
    expect(() => hashIdempotencyKey("line\nbreak")).toThrow(
      IdempotencyKeyInvalidError,
    );
    expect(() => hashIdempotencyKey("tab\tchar")).toThrow(
      IdempotencyKeyInvalidError,
    );
  });

  it("accepts any opaque printable token, not only a UUID", () => {
    // The token is never parsed, only compared, so imposing a shape would refuse perfectly good
    // keys such as a request identifier from the caller's own tracing system.
    expect(() => hashIdempotencyKey(KEY)).not.toThrow();
    expect(() => hashIdempotencyKey("req_01HX9ZQK7T8VZ2")).not.toThrow();
    expect(() => hashIdempotencyKey("a/b+c=d~e")).not.toThrow();
  });

  it("never returns the key itself: the digest is fixed width and one-way", () => {
    const digest = hashIdempotencyKey(KEY);

    expect(digest).toHaveLength(32);
    expect(digest.toString("utf8")).not.toContain(KEY);
    // Deterministic, so the same key finds the same record on a retry.
    expect(digestsMatch(digest, hashIdempotencyKey(KEY))).toBe(true);
  });

  it("gives different keys different digests", () => {
    expect(digestsMatch(hashIdempotencyKey(KEY), hashIdempotencyKey(`${KEY}1`))).toBe(
      false,
    );
  });

  it("never echoes the submitted key in its refusal (SEC-009)", () => {
    try {
      hashIdempotencyKey("short");
      throw new Error("expected a refusal");
    } catch (error: unknown) {
      expect((error as Error).message).not.toContain("short");
    }
  });
});

describe("REL-004 semantic fingerprinting", () => {
  it("is stable for the same intent", () => {
    expect(
      digestsMatch(
        fingerprint(["request-1", "quote-1", "lowest total offered"]),
        fingerprint(["request-1", "quote-1", "lowest total offered"]),
      ),
    ).toBe(true);
  });

  it("changes when a route resource identifier changes", () => {
    // Selecting quote A and selecting quote B are different requests even under one key.
    expect(
      digestsMatch(
        fingerprint(["request-1", "quote-1", "why"]),
        fingerprint(["request-1", "quote-2", "why"]),
      ),
    ).toBe(false);
    expect(
      digestsMatch(
        fingerprint(["request-1", "quote-1", "why"]),
        fingerprint(["request-2", "quote-1", "why"]),
      ),
    ).toBe(false);
  });

  it("changes when free text that affects the outcome changes", () => {
    // The rationale is recorded in the audit trail, so a different one is a different fact.
    // Including it here is how that is detected without the text ever being persisted.
    expect(
      digestsMatch(
        fingerprint(["request-1", "quote-1", "lowest total offered"]),
        fingerprint(["request-1", "quote-1", "shortest lead time offered"]),
      ),
    ).toBe(false);
  });

  it("is bound to the actor and the tenant, so a key is never shared", () => {
    expect(
      digestsMatch(
        fingerprint(["request-1"]),
        fingerprint(["request-1"], { actorId: "user-b" }),
      ),
    ).toBe(false);
    expect(
      digestsMatch(
        fingerprint(["request-1"]),
        fingerprint(["request-1"], { organizationId: "organization-b" }),
      ),
    ).toBe(false);
  });

  it("is bound to the operation, so one key cannot cross two of them", () => {
    expect(
      digestsMatch(
        fingerprint(["request-1"]),
        fingerprint(["request-1"], {
          operation: "PURCHASE_ORDER_ISSUANCE",
        }),
      ),
    ).toBe(false);
  });

  it("cannot be confused by rearranging the parts", () => {
    // Length-prefixed as well as separated: ["ab", "c"] and ["a", "bc"] must not collide, or a
    // caller could construct two different intents that replay each other's answers.
    expect(
      digestsMatch(fingerprint(["ab", "c"]), fingerprint(["a", "bc"])),
    ).toBe(false);
    expect(
      digestsMatch(fingerprint(["a", ""]), fingerprint(["", "a"])),
    ).toBe(false);
  });

  it("compares digests of different widths without throwing", () => {
    // `timingSafeEqual` rejects mismatched lengths, so the guard is the caller's job.
    expect(digestsMatch(Buffer.alloc(32), Buffer.alloc(16))).toBe(false);
  });
});

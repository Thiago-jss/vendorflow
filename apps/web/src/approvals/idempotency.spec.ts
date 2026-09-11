import { describe, expect, it } from "vitest";
import { createIdempotencyKeyStore } from "@/purchase-requests/idempotency";
import { approvalDecisionFingerprint } from "./idempotency";

const REQUEST_A = "1f8b7c62-5a4e-4f39-9a2b-0c6d1e5a7b31";
const REQUEST_B = "2c9d4e71-6b3f-4a28-8d5c-1e7f2a9b4c60";
const STEP_A = "7a1c3d55-2e4f-4b6a-ab8d-9f0e1c2d3a4b";
const STEP_B = "3e6f9a12-7b0c-4d8e-b1f2-6a3c9d0e4b57";

const baseIntent = {
  purchaseRequestId: REQUEST_A,
  approvalStepId: STEP_A,
  decision: "APPROVED",
  reason: ""
} as const;

function countingGenerator() {
  let issued = 0;

  return () => {
    issued += 1;

    return `key-${issued}`;
  };
}

describe("approval decision idempotency intent", () => {
  it("keeps one key while the decision is unchanged", () => {
    const store = createIdempotencyKeyStore(countingGenerator());
    const fingerprint = approvalDecisionFingerprint(baseIntent);

    expect(store.keyFor(fingerprint)).toBe("key-1");
    expect(store.keyFor(fingerprint)).toBe("key-1");
    expect(store.keyFor(approvalDecisionFingerprint({ ...baseIntent }))).toBe("key-1");
  });

  it("treats a different request, rung, direction or reason as a different decision", () => {
    const store = createIdempotencyKeyStore(countingGenerator());

    expect(store.keyFor(approvalDecisionFingerprint(baseIntent))).toBe("key-1");
    expect(
      store.keyFor(
        approvalDecisionFingerprint({ ...baseIntent, purchaseRequestId: REQUEST_B })
      )
    ).toBe("key-2");
    expect(
      store.keyFor(approvalDecisionFingerprint({ ...baseIntent, approvalStepId: STEP_B }))
    ).toBe("key-3");
    expect(
      store.keyFor(
        approvalDecisionFingerprint({
          ...baseIntent,
          decision: "REJECTED",
          reason: "Fora do orçamento"
        })
      )
    ).toBe("key-4");
    expect(
      store.keyFor(
        approvalDecisionFingerprint({
          ...baseIntent,
          decision: "REJECTED",
          reason: "Fora do orçamento deste trimestre"
        })
      )
    ).toBe("key-5");
  });

  it("mints a new key once a definitive answer discards the previous one", () => {
    const store = createIdempotencyKeyStore(countingGenerator());
    const fingerprint = approvalDecisionFingerprint(baseIntent);

    expect(store.keyFor(fingerprint)).toBe("key-1");

    store.discard();

    expect(store.currentKey()).toBeNull();
    expect(store.keyFor(fingerprint)).toBe("key-2");
  });

  /**
   * The reason is free text, so a separator typed inside it must not be able to spell a
   * neighbouring field's value and make two different decisions look like one.
   */
  it("cannot be confused by separators typed inside the reason", () => {
    const first = approvalDecisionFingerprint({
      ...baseIntent,
      decision: "REJECTED",
      reason: `a","${STEP_B}`
    });
    const second = approvalDecisionFingerprint({
      ...baseIntent,
      approvalStepId: STEP_B,
      decision: "REJECTED",
      reason: "a"
    });

    expect(first).not.toBe(second);
  });
});

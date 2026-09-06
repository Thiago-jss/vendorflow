import { Argon2PasswordHasher } from "./argon2-password-hasher";

describe("Argon2PasswordHasher", () => {
  const hasher = new Argon2PasswordHasher();

  it("produces an Argon2id PHC string the database check constraint accepts", async () => {
    const digest = await hasher.hash("correct horse battery staple");

    expect(digest.startsWith("$argon2id$")).toBe(true);
    expect(digest).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    // The column is VARCHAR(255); the configured parameters must fit with room to spare.
    expect(digest.length).toBeLessThanOrEqual(255);
  }, 20_000);

  it("salts every hash, so identical passwords do not produce identical digests", async () => {
    const [first, second] = await Promise.all([
      hasher.hash("same password"),
      hasher.hash("same password"),
    ]);

    expect(first).not.toEqual(second);
  }, 20_000);

  it("verifies the correct password and rejects a wrong one", async () => {
    const digest = await hasher.hash("correct horse battery staple");

    await expect(
      hasher.verify(digest, "correct horse battery staple"),
    ).resolves.toBe(true);
    await expect(
      hasher.verify(digest, "correct horse battery stapl"),
    ).resolves.toBe(false);
    await expect(hasher.verify(digest, "")).resolves.toBe(false);
  }, 20_000);

  it("treats an unparseable stored value as a failed verification, not an error", async () => {
    // A 500 here would tell a client that this particular account is different from
    // every other account whose password is simply wrong.
    await expect(hasher.verify("plaintext", "plaintext")).resolves.toBe(false);
    await expect(hasher.verify("$argon2id$broken", "anything")).resolves.toBe(
      false,
    );
  }, 20_000);

  it("verifies a decoy no password can match, so absent credentials cost the same as wrong ones", async () => {
    await expect(
      hasher.verifyDecoy("anything at all"),
    ).resolves.toBeUndefined();

    const withDecoy = await measure(() =>
      hasher.verifyDecoy("anything at all"),
    );
    const digest = await hasher.hash("a real password");
    const withRealHash = await measure(() =>
      hasher.verify(digest, "wrong password"),
    );

    // Same order of magnitude is the property that matters: the decoy must not be the
    // near-instant path that would identify a user without a password hash.
    expect(withDecoy).toBeGreaterThan(withRealHash / 4);
  }, 30_000);

  it("reports that a digest below the current parameters should be rehashed", async () => {
    const current = await hasher.hash("correct horse battery staple");
    // Produced by the previously common OWASP baseline of m=12288, t=3, p=1.
    const weaker =
      "$argon2id$v=19$m=12288,t=3,p=1$c29tZXNhbHRzb21lc2FsdA$4bnLNTuJ2LnO3lTBqZ7HTiJ6VBqiCzLB3H0i0Ix5yWQ";

    expect(hasher.needsRehash(current)).toBe(false);
    expect(hasher.needsRehash(weaker)).toBe(true);
    expect(hasher.needsRehash("not a digest")).toBe(true);
  }, 20_000);
});

async function measure(operation: () => Promise<unknown>): Promise<number> {
  const startedAt = process.hrtime.bigint();
  await operation();

  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

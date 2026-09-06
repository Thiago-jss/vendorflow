export const PASSWORD_HASHER = Symbol("PASSWORD_HASHER");

export interface PasswordHasher {
  hash(password: string): Promise<string>;

  verify(passwordHash: string, password: string): Promise<boolean>;

  /**
   * Performs the same work as {@link PasswordHasher.verify} against a hash no password can
   * match. Login calls it whenever there is no persisted hash to verify — unknown email,
   * inactive user, user without credentials — so that response time does not reveal which
   * of those happened. Without it, `password_hash IS NULL` becomes an account-enumeration
   * oracle: absent-credential rejections would return in about a millisecond while wrong
   * passwords take tens of milliseconds.
   */
  verifyDecoy(password: string): Promise<void>;

  /** True when the stored hash was produced with weaker parameters than the current policy. */
  needsRehash(passwordHash: string): boolean;
}

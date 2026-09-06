/**
 * Mirrors the `users_email_normalized_check` database constraint, so a lookup normalizes an
 * address exactly the way persistence stored it. Any other normalization here would make
 * legitimate logins miss.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

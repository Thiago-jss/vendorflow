/**
 * One error for every login rejection. Unknown email, inactive user, absent password hash
 * and wrong password must be indistinguishable at the product boundary, so they must be
 * indistinguishable here too: a caller cannot accidentally branch on a reason it never
 * receives.
 */
export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid credentials");
    this.name = "InvalidCredentialsError";
  }
}

/**
 * One error for every access-token rejection: missing, malformed, expired, wrongly signed,
 * wrong issuer or audience, invalid claims, unknown user, inactive user, or an organization
 * claim that disagrees with persisted identity.
 */
export class InvalidAccessTokenError extends Error {
  constructor() {
    super("Invalid access token");
    this.name = "InvalidAccessTokenError";
  }
}

/**
 * One error for every refresh rejection: missing, unknown, expired, already rotated,
 * logged out, revoked, reused, or belonging to a principal that is no longer active.
 */
export class InvalidRefreshSessionError extends Error {
  constructor() {
    super("Invalid refresh session");
    this.name = "InvalidRefreshSessionError";
  }
}

/** Raised when an abuse limit rejects the attempt, without saying which dimension did. */
export class AuthenticationRateLimitedError extends Error {
  constructor() {
    super("Too many requests");
    this.name = "AuthenticationRateLimitedError";
  }
}

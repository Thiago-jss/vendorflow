import type { PrincipalRole } from "../../../platform/tenancy/trusted-principal";

export const ACCESS_TOKEN_SERVICE = Symbol("ACCESS_TOKEN_SERVICE");

export interface AccessTokenSubject {
  readonly userId: string;
  readonly organizationId: string;
  readonly roles: readonly PrincipalRole[];
  readonly sessionId: string;
}

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Claims carried by a verified access token. They are signed metadata, satisfying SEC-001,
 * and they are the *input* to authorization, never its authority: `roles` may already be
 * stale, and `organizationId` is compared against persisted identity rather than trusted.
 */
export interface VerifiedAccessTokenClaims {
  readonly userId: string;
  readonly organizationId: string;
  readonly roles: readonly PrincipalRole[];
  readonly sessionId: string;
  readonly tokenId: string;
}

export interface AccessTokenService {
  issue(subject: AccessTokenSubject): Promise<IssuedAccessToken>;

  /** Rejects with {@link InvalidAccessTokenError} for every cryptographic or claim failure. */
  verify(token: string): Promise<VerifiedAccessTokenClaims>;
}

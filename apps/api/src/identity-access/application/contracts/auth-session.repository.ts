import type { AuthenticatedPrincipalRecord } from "./identity-access.repository";

export const AUTH_SESSION_REPOSITORY = Symbol("AUTH_SESSION_REPOSITORY");

export interface CreateAuthSessionInput {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly familyId: string;
  readonly tokenHash: Uint8Array;
  readonly expiresAt: Date;
}

export interface RotateAuthSessionInput {
  readonly presentedTokenHash: Uint8Array;
  readonly successorSessionId: string;
  readonly successorTokenHash: Uint8Array;
}

export interface RotatedAuthSession {
  readonly outcome: "ROTATED";
  readonly principal: AuthenticatedPrincipalRecord;
  readonly sessionId: string;
  readonly familyId: string;
  /** Inherited from the predecessor: rotation never extends the absolute lifetime. */
  readonly expiresAt: Date;
}

export interface RejectedAuthSessionRotation {
  readonly outcome: "REJECTED";
  /** True only when an already-rotated token was presented again. Drives security logging. */
  readonly reuseDetected: boolean;
  readonly organizationId: string | null;
  readonly familyId: string | null;
}

export type AuthSessionRotationResult =
  | RotatedAuthSession
  | RejectedAuthSessionRotation;

export interface AuthSessionRepository {
  createSession(input: CreateAuthSessionInput): Promise<void>;

  /**
   * Atomically consumes the presented refresh session and creates its successor, or rejects.
   *
   * The whole decision — consume, verify the principal is still active, create the
   * successor, or detect reuse and revoke the family — happens inside one PostgreSQL
   * transaction whose security-critical step is a conditional UPDATE. Read-then-write in
   * application code would let two concurrent refreshes both observe the same session as
   * active and each issue a successor.
   */
  rotateSession(
    input: RotateAuthSessionInput,
  ): Promise<AuthSessionRotationResult>;

  /**
   * Revokes the presented session if it is still active. Logout is idempotent and never
   * reports whether a usable session existed.
   */
  revokePresentedSession(input: {
    readonly presentedTokenHash: Uint8Array;
  }): Promise<void>;
}

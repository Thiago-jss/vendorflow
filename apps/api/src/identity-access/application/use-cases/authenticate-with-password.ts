import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  ACCESS_TOKEN_SERVICE,
  type AccessTokenService,
} from "../contracts/access-token.service";
import {
  AUTH_SESSION_REPOSITORY,
  type AuthSessionRepository,
} from "../contracts/auth-session.repository";
import type { AuthenticationResult } from "../contracts/authentication-result";
import {
  AUTHENTICATION_OPTIONS,
  type AuthenticationOptions,
} from "../contracts/authentication.options";
import {
  AuthenticationRateLimitedError,
  InvalidCredentialsError,
} from "../contracts/authentication.errors";
import { normalizeEmail } from "../support/email-normalization";
import { FailedLoginAttemptLimiter } from "../services/failed-login-attempt-limiter";
import {
  IDENTITY_ACCESS_REPOSITORY,
  type IdentityAccessRepository,
} from "../contracts/identity-access.repository";
import { PASSWORD_HASHER, type PasswordHasher } from "../contracts/password-hasher";
import { generateRefreshToken } from "../support/refresh-token";

export interface AuthenticateWithPasswordCommand {
  readonly email: string;
  readonly password: string;
}

@Injectable()
export class AuthenticateWithPassword {
  private readonly logger = new Logger(AuthenticateWithPassword.name);

  constructor(
    @Inject(IDENTITY_ACCESS_REPOSITORY)
    private readonly identityAccessRepository: IdentityAccessRepository,
    @Inject(AUTH_SESSION_REPOSITORY)
    private readonly authSessionRepository: AuthSessionRepository,
    @Inject(ACCESS_TOKEN_SERVICE)
    private readonly accessTokenService: AccessTokenService,
    @Inject(PASSWORD_HASHER)
    private readonly passwordHasher: PasswordHasher,
    private readonly failedLoginAttemptLimiter: FailedLoginAttemptLimiter,
    @Inject(AUTHENTICATION_OPTIONS)
    private readonly options: AuthenticationOptions,
  ) {}

  async execute(
    command: AuthenticateWithPasswordCommand,
  ): Promise<AuthenticationResult> {
    const email = normalizeEmail(command.email);

    if (this.failedLoginAttemptLimiter.isLocked(email)) {
      throw new AuthenticationRateLimitedError();
    }

    const credential =
      await this.identityAccessRepository.findCredentialByEmail({ email });

    // Unknown address, deactivated user, and a user that never received credentials all
    // take this branch, at the same cost, and produce the same error.
    if (
      credential === null ||
      !credential.isActive ||
      credential.passwordHash === null
    ) {
      await this.passwordHasher.verifyDecoy(command.password);
      this.failedLoginAttemptLimiter.recordFailure(email);
      throw new InvalidCredentialsError();
    }

    const passwordMatches = await this.passwordHasher.verify(
      credential.passwordHash,
      command.password,
    );

    if (!passwordMatches) {
      this.failedLoginAttemptLimiter.recordFailure(email);
      throw new InvalidCredentialsError();
    }

    // Reloaded through the authoritative principal query rather than trusting the record
    // read for password verification: it supplies the persisted roles the token must carry,
    // and it closes the window where the user is deactivated between the two reads.
    const principal =
      await this.identityAccessRepository.findAuthenticatedPrincipal({
        userId: credential.userId,
      });

    if (principal === null) {
      this.failedLoginAttemptLimiter.recordFailure(email);
      throw new InvalidCredentialsError();
    }

    this.failedLoginAttemptLimiter.reset(email);

    if (this.passwordHasher.needsRehash(credential.passwordHash)) {
      // Operational signal only. This slice has no credential-write path, so the actual
      // upgrade belongs to the future credential-management flow.
      this.logger.warn({
        event: "PASSWORD_HASH_BELOW_CURRENT_PARAMETERS",
        userId: principal.userId,
        organizationId: principal.organizationId,
      });
    }

    const sessionId = randomUUID();
    const refreshToken = generateRefreshToken();
    const expiresAt = new Date(
      Date.now() + this.options.refreshTokenTtlSeconds * 1000,
    );

    await this.authSessionRepository.createSession({
      sessionId,
      organizationId: principal.organizationId,
      userId: principal.userId,
      // A login starts a new family; it is not a continuation of an earlier session chain.
      familyId: randomUUID(),
      tokenHash: refreshToken.tokenHash,
      expiresAt,
    });

    const accessToken = await this.accessTokenService.issue({
      userId: principal.userId,
      organizationId: principal.organizationId,
      roles: principal.roles,
      sessionId,
    });

    return {
      accessToken: accessToken.token,
      accessTokenExpiresAt: accessToken.expiresAt,
      refreshToken: refreshToken.token,
      refreshTokenExpiresAt: expiresAt,
    };
  }
}

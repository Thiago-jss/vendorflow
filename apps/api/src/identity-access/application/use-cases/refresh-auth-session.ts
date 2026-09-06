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
import { InvalidRefreshSessionError } from "../contracts/authentication.errors";
import { generateRefreshToken, hashRefreshToken } from "../support/refresh-token";

export interface RefreshAuthSessionCommand {
  readonly presentedToken: string;
}

@Injectable()
export class RefreshAuthSession {
  private readonly logger = new Logger(RefreshAuthSession.name);

  constructor(
    @Inject(AUTH_SESSION_REPOSITORY)
    private readonly authSessionRepository: AuthSessionRepository,
    @Inject(ACCESS_TOKEN_SERVICE)
    private readonly accessTokenService: AccessTokenService,
  ) {}

  async execute(
    command: RefreshAuthSessionCommand,
  ): Promise<AuthenticationResult> {
    const successorSessionId = randomUUID();
    const successorToken = generateRefreshToken();

    // The successor's identifiers are generated before the transaction so the conditional
    // UPDATE and the successor INSERT are one round of decisions inside one transaction.
    // Nothing persists unless that UPDATE wins.
    const rotation = await this.authSessionRepository.rotateSession({
      presentedTokenHash: hashRefreshToken(command.presentedToken),
      successorSessionId,
      successorTokenHash: successorToken.tokenHash,
    });

    if (rotation.outcome === "REJECTED") {
      if (rotation.reuseDetected) {
        // Identifiers only. The presented token, its digest and the cookie never reach a log.
        this.logger.warn({
          event: "REFRESH_TOKEN_REUSE_DETECTED",
          organizationId: rotation.organizationId,
          familyId: rotation.familyId,
        });
      }

      throw new InvalidRefreshSessionError();
    }

    const accessToken = await this.accessTokenService.issue({
      userId: rotation.principal.userId,
      organizationId: rotation.principal.organizationId,
      roles: rotation.principal.roles,
      sessionId: rotation.sessionId,
    });

    return {
      accessToken: accessToken.token,
      accessTokenExpiresAt: accessToken.expiresAt,
      refreshToken: successorToken.token,
      refreshTokenExpiresAt: rotation.expiresAt,
    };
  }
}

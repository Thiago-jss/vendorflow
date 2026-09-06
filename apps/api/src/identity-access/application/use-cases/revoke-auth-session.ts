import { Inject, Injectable } from "@nestjs/common";
import {
  AUTH_SESSION_REPOSITORY,
  type AuthSessionRepository,
} from "../contracts/auth-session.repository";
import { hashRefreshToken } from "../support/refresh-token";

export interface RevokeAuthSessionCommand {
  readonly presentedToken: string;
}

/**
 * Logout. Revokes only the presented session — revoking every session of a user is a
 * separate capability with its own authorization question and is not in this slice.
 *
 * Deliberately returns nothing and never fails on an unusable token: a caller that could
 * distinguish "your session was revoked" from "there was nothing to revoke" would hand an
 * attacker a way to test stolen cookies.
 */
@Injectable()
export class RevokeAuthSession {
  constructor(
    @Inject(AUTH_SESSION_REPOSITORY)
    private readonly authSessionRepository: AuthSessionRepository,
  ) {}

  async execute(command: RevokeAuthSessionCommand): Promise<void> {
    await this.authSessionRepository.revokePresentedSession({
      presentedTokenHash: hashRefreshToken(command.presentedToken),
    });
  }
}

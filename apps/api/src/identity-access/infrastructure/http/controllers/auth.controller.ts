import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import type { Environment } from "../../../../config/env";
import { Public } from "../../../../platform/http/public-route.decorator";
import { AuthenticateWithPassword } from "../../../application/use-cases/authenticate-with-password";
import type { AuthenticationResult } from "../../../application/contracts/authentication-result";
import {
  AuthenticationRateLimitedError,
  InvalidCredentialsError,
  InvalidRefreshSessionError,
} from "../../../application/contracts/authentication.errors";
import { RefreshAuthSession } from "../../../application/use-cases/refresh-auth-session";
import { RevokeAuthSession } from "../../../application/use-cases/revoke-auth-session";
import { AuthOriginGuard } from "../guards/auth-origin.guard";
import { AuthThrottlerGuard } from "../guards/auth-throttler.guard";
import { LoginRequestDto } from "../dto/login.dto";
import { TooManyRequestsException } from "../../../../platform/http/too-many-requests.exception";
import {
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from "../cookies/refresh-cookie";

/** The refresh token is never part of this body; it exists only as an HttpOnly cookie. */
interface AccessTokenResponse {
  readonly accessToken: string;
  readonly expiresAt: string;
}

@Controller("auth")
// Every route here is cookie-bearing, so the CSRF check is controller-wide and — because
// Nest runs controller guards before handler guards — still refuses a cross-site attempt
// before any credential is read or any budget is spent. The address limit is deliberately
// *not* controller-wide: see the handlers below.
@UseGuards(AuthOriginGuard)
export class AuthController {
  private readonly useSecureCookies: boolean;

  constructor(
    private readonly authenticateWithPassword: AuthenticateWithPassword,
    private readonly refreshAuthSession: RefreshAuthSession,
    private readonly revokeAuthSession: RevokeAuthSession,
    configService: ConfigService<Environment, true>,
  ) {
    this.useSecureCookies =
      configService.get("NODE_ENV", { infer: true }) === "production";
  }

  @Public()
  @Post("login")
  // Password guessing happens here, so this is one of the two routes the address limit
  // guards. Its budget is the handler's own; refresh cannot spend it.
  @UseGuards(AuthThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: LoginRequestDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AccessTokenResponse> {
    let result: AuthenticationResult;

    try {
      result = await this.authenticateWithPassword.execute({
        email: body.email,
        password: body.password,
      });
    } catch (error: unknown) {
      if (error instanceof InvalidCredentialsError) {
        // Unknown address, deactivated user, user without a password hash, and wrong
        // password all arrive here and leave with the same status, body and headers.
        throw new UnauthorizedException("Invalid credentials");
      }

      if (error instanceof AuthenticationRateLimitedError) {
        // Identical to what the source-address limiter returns, so neither dimension is
        // identifiable from the response.
        throw new TooManyRequestsException();
      }

      throw error;
    }

    setRefreshCookie(
      response,
      result.refreshToken,
      result.refreshTokenExpiresAt,
      this.useSecureCookies,
    );

    return this.accessTokenResponse(result);
  }

  @Public()
  @Post("refresh")
  // Refresh accepts a bearer-equivalent credential from the cookie, so it is limited too,
  // on its own budget.
  @UseGuards(AuthThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AccessTokenResponse> {
    const presentedToken = readRefreshCookie(request);

    if (presentedToken === null) {
      throw this.rejectRefresh(response);
    }

    let result: AuthenticationResult;

    try {
      result = await this.refreshAuthSession.execute({ presentedToken });
    } catch (error: unknown) {
      if (error instanceof InvalidRefreshSessionError) {
        throw this.rejectRefresh(response);
      }

      throw error;
    }

    setRefreshCookie(
      response,
      result.refreshToken,
      result.refreshTokenExpiresAt,
      this.useSecureCookies,
    );

    return this.accessTokenResponse(result);
  }

  @Public()
  // Deliberately not throttled. Logout is the one auth route that *reduces* the attack
  // surface, and it carries no guessable secret: the worst a flood achieves is revoking
  // sessions whose tokens the caller already holds. Limiting it would let an attacker who
  // exhausts the address budget — trivially, from the same NAT or proxy as the victim —
  // pin a session open by making the sign-out button fail with 429 while the cookie
  // survives. Availability of revocation outweighs the burst it permits.
  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const presentedToken = readRefreshCookie(request);

    if (presentedToken !== null) {
      await this.revokeAuthSession.execute({ presentedToken });
    }

    // Always cleared and always 204: whether a usable session existed is not something a
    // caller gets to learn by logging out.
    clearRefreshCookie(response, this.useSecureCookies);
  }

  /**
   * Missing, unknown, expired, rotated, logged-out, revoked and reused sessions all produce
   * this, and all clear the cookie so a client stops replaying an unusable token.
   */
  private rejectRefresh(response: Response): UnauthorizedException {
    clearRefreshCookie(response, this.useSecureCookies);

    return new UnauthorizedException("Invalid session");
  }

  private accessTokenResponse(
    result: AuthenticationResult,
  ): AccessTokenResponse {
    return {
      accessToken: result.accessToken,
      expiresAt: result.accessTokenExpiresAt.toISOString(),
    };
  }
}

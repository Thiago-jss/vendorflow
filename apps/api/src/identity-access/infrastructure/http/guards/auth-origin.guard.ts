import {
  ForbiddenException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request } from "express";

export const AUTH_ALLOWED_ORIGINS = Symbol("AUTH_ALLOWED_ORIGINS");

/**
 * CSRF control for the cookie-bearing auth routes.
 *
 * CORS is not this control: a browser applies CORS to the *response*, after the request has
 * already reached the server, so a cross-site POST can still perform its side effect even
 * when the attacker never reads the reply. `SameSite=Strict` is the primary defence and this
 * is the independent second one, checked before any credential is examined so that a
 * cross-site attempt costs nothing and reveals nothing.
 */
@Injectable()
export class AuthOriginGuard implements CanActivate {
  constructor(
    @Inject(AUTH_ALLOWED_ORIGINS)
    private readonly allowedOrigins: readonly string[],
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const origin: unknown = request.headers.origin;

    // A missing Origin is rejected rather than trusted. These routes are only ever called
    // by the web client, which always sends one; a request without it is either not that
    // client or is a form post, and both are exactly what this guard exists to stop.
    if (typeof origin !== "string" || !this.allowedOrigins.includes(origin)) {
      throw new ForbiddenException();
    }

    return true;
  }
}

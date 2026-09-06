import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { TooManyRequestsException } from "../../../../identity-access/infrastructure/http/exceptions/too-many-requests.exception";
import { readTrustedPrincipal } from "../../../../platform/tenancy/trusted-principal-carrier";
import { FixedWindowRateLimiter } from "../../../../platform/rate-limiting/fixed-window-rate-limiter";

export const APPROVAL_IP_RATE_LIMITER = Symbol("APPROVAL_IP_RATE_LIMITER");
export const APPROVAL_PRINCIPAL_RATE_LIMITER = Symbol(
  "APPROVAL_PRINCIPAL_RATE_LIMITER",
);

/**
 * SEC-006 for the two approval routes: the Manager queue and the decision command.
 *
 * Two independent budgets, both enforced on every request:
 *
 * - by source address, so a single address cannot flood either route regardless of how many
 *   accounts it authenticates as;
 * - by authenticated principal (`TrustedPrincipal.userId`), so one compromised or malicious
 *   account cannot exhaust the budget of every other manager sharing its address (a shared
 *   office NAT, a corporate proxy).
 *
 * Runs after the global `AccessTokenAuthGuard` (Nest evaluates global guards before
 * controller-scoped ones), so a `TrustedPrincipal` is already bound to the request whenever
 * this guard's `canActivate` executes — `readTrustedPrincipal` throws otherwise, which is
 * exactly the default-deny behaviour wanted here: this guard never derives its key from the
 * request body, a path parameter or a client-supplied header, only from what authentication
 * already established server-side.
 *
 * A caller over either budget gets the same generic `TooManyRequestsException` the auth
 * routes use, and gets it from this guard, before the controller method — and therefore
 * before any decision, transition, flow change or audit write — ever runs.
 */
@Injectable()
export class ApprovalRateLimitGuard implements CanActivate {
  constructor(
    @Inject(APPROVAL_IP_RATE_LIMITER)
    private readonly ipLimiter: FixedWindowRateLimiter,
    @Inject(APPROVAL_PRINCIPAL_RATE_LIMITER)
    private readonly principalLimiter: FixedWindowRateLimiter,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const principal = readTrustedPrincipal(request);
    // The queue read and the decision write are different abuse profiles — one is a cheap
    // lookup, the other holds a transaction and lock contention — so each handler gets its
    // own budget on both dimensions, the same per-handler keying `/auth/login` and
    // `/auth/refresh` already rely on.
    const route = `${context.getClass().name}.${context.getHandler().name}`;

    // Both budgets are always charged, independently of one another, so exhausting one never
    // masks whether the other would also have refused this request.
    const ip = this.ipLimiter.hit(`${route}:ip:${request.ip}`);
    const account = this.principalLimiter.hit(
      `${route}:principal:${principal.userId}`,
    );

    if (!ip.allowed || !account.allowed) {
      throw new TooManyRequestsException();
    }

    return true;
  }
}

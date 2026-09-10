import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { TooManyRequestsException } from "../http/too-many-requests.exception";
import { readTrustedPrincipal } from "../tenancy/trusted-principal-carrier";
import type { FixedWindowRateLimiter } from "./fixed-window-rate-limiter";

/**
 * SEC-006 for authenticated write routes, in the one shape this system uses.
 *
 * Two independent budgets, both charged on every request:
 *
 * - by **source address**, so a single address cannot flood a route regardless of how many
 *   accounts it authenticates as;
 * - by **authenticated principal**, so one compromised or malicious account cannot exhaust the
 *   budget of every colleague sharing its address (a shared office NAT, a corporate proxy).
 *
 * Both are always charged, independently, so exhausting one never masks whether the other would
 * also have refused. The key includes the handler, because a cheap read and a transaction-
 * holding write are different abuse profiles and should not share an allowance.
 *
 * It runs after the global `AccessTokenAuthGuard` — Nest evaluates global guards before
 * controller-scoped ones — so a `TrustedPrincipal` is already bound whenever `canActivate`
 * executes. `readTrustedPrincipal` throws otherwise, which is the default-deny behaviour wanted
 * here: the key is never derived from a body, a path parameter or a client-supplied header,
 * only from what authentication already established server-side.
 *
 * PROCESS-LOCAL, AND DELIBERATELY SO FOR THIS PHASE. The counters live in this process's heap:
 * they are correct for exactly one API instance and are lost on restart, and a second instance
 * multiplies the effective allowance by the number of instances. A shared counter is a
 * prerequisite for horizontal scaling and belongs to the phase that introduces distributed
 * responsibilities, not to this one.
 */
export abstract class DualDimensionRateLimitGuard implements CanActivate {
  protected constructor(
    private readonly addressLimiter: FixedWindowRateLimiter,
    private readonly principalLimiter: FixedWindowRateLimiter,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const principal = readTrustedPrincipal(request);
    const route = `${context.getClass().name}.${context.getHandler().name}`;

    const address = this.addressLimiter.hit(`${route}:ip:${request.ip}`);
    const account = this.principalLimiter.hit(
      `${route}:principal:${principal.userId}`,
    );

    if (!address.allowed || !account.allowed) {
      throw new TooManyRequestsException();
    }

    return true;
  }
}

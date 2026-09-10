import { Inject, Injectable } from "@nestjs/common";
import { DualDimensionRateLimitGuard } from "../../../../platform/rate-limiting/dual-dimension-rate-limit.guard";
import { FixedWindowRateLimiter } from "../../../../platform/rate-limiting/fixed-window-rate-limiter";

export const APPROVAL_IP_RATE_LIMITER = Symbol("APPROVAL_IP_RATE_LIMITER");
export const APPROVAL_PRINCIPAL_RATE_LIMITER = Symbol(
  "APPROVAL_PRINCIPAL_RATE_LIMITER",
);

/**
 * SEC-006 for the two approval routes: the Manager queue and the decision command.
 *
 * The behaviour — two independent budgets, one by source address and one by authenticated
 * principal, both charged on every request and both keyed per handler — lives in
 * `DualDimensionRateLimitGuard`, along with the honest statement of its process-local
 * limitation. What this class contributes is *which* budgets, and that is all a per-route
 * guard should have to contribute.
 *
 * A caller over either budget is refused here, before the controller method — and therefore
 * before any decision, transition, flow change or audit write — ever runs.
 */
@Injectable()
export class ApprovalRateLimitGuard extends DualDimensionRateLimitGuard {
  constructor(
    @Inject(APPROVAL_IP_RATE_LIMITER) addressLimiter: FixedWindowRateLimiter,
    @Inject(APPROVAL_PRINCIPAL_RATE_LIMITER)
    principalLimiter: FixedWindowRateLimiter,
  ) {
    super(addressLimiter, principalLimiter);
  }
}

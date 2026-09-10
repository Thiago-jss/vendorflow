import { Inject, Injectable } from "@nestjs/common";
import { DualDimensionRateLimitGuard } from "../../../../platform/rate-limiting/dual-dimension-rate-limit.guard";
import { FixedWindowRateLimiter } from "../../../../platform/rate-limiting/fixed-window-rate-limiter";

export const QUOTE_SELECTION_IP_RATE_LIMITER = Symbol(
  "QUOTE_SELECTION_IP_RATE_LIMITER",
);
export const QUOTE_SELECTION_PRINCIPAL_RATE_LIMITER = Symbol(
  "QUOTE_SELECTION_PRINCIPAL_RATE_LIMITER",
);

/**
 * SEC-006 for quote selection, which is the most expensive write in this module: it holds a
 * transaction across the request's row lock, the quote's conditional update, a whole approval
 * ladder re-evaluation, two audit appends and an outbox insert.
 *
 * The budgets are separate from the approval routes' on purpose. Sharing one allowance would
 * let a burst of selections lock a manager out of deciding, and the two have nothing to do
 * with one another.
 */
@Injectable()
export class QuoteSelectionRateLimitGuard extends DualDimensionRateLimitGuard {
  constructor(
    @Inject(QUOTE_SELECTION_IP_RATE_LIMITER)
    addressLimiter: FixedWindowRateLimiter,
    @Inject(QUOTE_SELECTION_PRINCIPAL_RATE_LIMITER)
    principalLimiter: FixedWindowRateLimiter,
  ) {
    super(addressLimiter, principalLimiter);
  }
}

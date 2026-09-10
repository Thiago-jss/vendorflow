import { Inject, Injectable } from "@nestjs/common";
import { DualDimensionRateLimitGuard } from "../../../../platform/rate-limiting/dual-dimension-rate-limit.guard";
import { FixedWindowRateLimiter } from "../../../../platform/rate-limiting/fixed-window-rate-limiter";

export const PURCHASE_ORDER_IP_RATE_LIMITER = Symbol(
  "PURCHASE_ORDER_IP_RATE_LIMITER",
);
export const PURCHASE_ORDER_PRINCIPAL_RATE_LIMITER = Symbol(
  "PURCHASE_ORDER_PRINCIPAL_RATE_LIMITER",
);

/**
 * SEC-006 for purchase order issuance and cancellation.
 *
 * Issuance allocates a tenant-visible number, so a flood of refused attempts is worth bounding
 * even though a rolled-back allocation consumes nothing: the contention it creates on the
 * tenant's counter row is real, and it is the one row every issuance in the organization has
 * to take in turn.
 */
@Injectable()
export class PurchaseOrderRateLimitGuard extends DualDimensionRateLimitGuard {
  constructor(
    @Inject(PURCHASE_ORDER_IP_RATE_LIMITER)
    addressLimiter: FixedWindowRateLimiter,
    @Inject(PURCHASE_ORDER_PRINCIPAL_RATE_LIMITER)
    principalLimiter: FixedWindowRateLimiter,
  ) {
    super(addressLimiter, principalLimiter);
  }
}

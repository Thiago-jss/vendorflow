import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { TooManyRequestsException } from "../../../../platform/http/too-many-requests.exception";

/**
 * Source-address limit for the auth routes.
 *
 * The only behaviour changed from the stock guard is the rejection body: the default
 * message names the throttler, which would let a caller tell the address limit apart from
 * the per-account limit and therefore learn whether the address it is probing exists.
 * Both dimensions now answer with the same exception.
 */
@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(): Promise<void> {
    throw new TooManyRequestsException();
  }
}

import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * SEC-006's single rejection, shared by every abuse limit in the system: source-address
 * throttling, per-account login lockout, and the per-route budgets on approval, quote selection
 * and purchase order issuance.
 *
 * It lives in `platform` because rate limiting is cross-cutting mechanism and every module that
 * enforces a budget needs the same refusal. One class is what makes the refusals *identical* —
 * a lockout that answered differently from a throttle would confirm which accounts exist, and
 * two string literals in two modules are two chances for that to drift apart.
 *
 * The response body is an object because `SanitizedExceptionFilter` reads its `message` from
 * one; a string payload would be rewritten to a generic failure message.
 */
export class TooManyRequestsException extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: "Too many requests",
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

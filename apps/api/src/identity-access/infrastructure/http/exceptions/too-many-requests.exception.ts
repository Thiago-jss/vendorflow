import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * The single rejection used by both abuse limits.
 *
 * Source-address throttling and per-account lockout must be indistinguishable to a caller;
 * if they were not, the lockout response would confirm which addresses exist. Building both
 * from one class makes that identity structural rather than two string literals that can
 * drift apart. The response body is an object because `SanitizedExceptionFilter` reads its
 * `message` from one, and a string payload would be rewritten to a generic failure message.
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

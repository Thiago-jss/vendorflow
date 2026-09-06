import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { AuthOriginGuard } from "./auth-origin.guard";

describe("AuthOriginGuard", () => {
  const guard = new AuthOriginGuard([
    "http://localhost:3000",
    "https://app.vendorflow.test",
  ]);

  function contextWithOrigin(origin?: string | string[]): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers: origin === undefined ? {} : { origin } }),
      }),
    } as unknown as ExecutionContext;
  }

  it.each(["http://localhost:3000", "https://app.vendorflow.test"])(
    "allows the configured origin %s",
    (origin) => {
      expect(guard.canActivate(contextWithOrigin(origin))).toBe(true);
    },
  );

  it("rejects a request with no Origin at all", () => {
    // Not trusted by omission: a form post from another site carries no Origin, and these
    // routes are only ever called by the web client, which always sends one.
    expect(() => guard.canActivate(contextWithOrigin())).toThrow(
      ForbiddenException,
    );
  });

  it.each([
    ["a foreign site", "https://evil.test"],
    ["the opaque origin of a sandboxed document", "null"],
    ["a scheme downgrade", "http://app.vendorflow.test"],
    ["a different port", "http://localhost:3001"],
    ["a suffix of an allowed origin", "https://evil-app.vendorflow.test"],
    ["a prefix match attempt", "https://app.vendorflow.test.evil.test"],
    ["an origin with a path appended", "https://app.vendorflow.test/"],
    ["a case-changed host", "https://APP.vendorflow.test"],
    ["an empty header", ""],
  ])("rejects %s", (_case, origin) => {
    expect(() => guard.canActivate(contextWithOrigin(origin))).toThrow(
      ForbiddenException,
    );
  });

  it("rejects a duplicated Origin header", () => {
    expect(() =>
      guard.canActivate(
        contextWithOrigin(["http://localhost:3000", "https://evil.test"]),
      ),
    ).toThrow(ForbiddenException);
  });
});

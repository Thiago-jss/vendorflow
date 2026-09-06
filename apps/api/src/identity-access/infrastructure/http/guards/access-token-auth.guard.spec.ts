import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { randomUUID } from "node:crypto";
import { IS_PUBLIC_ROUTE } from "../../../../platform/http/public-route.decorator";
import type { PrincipalRole } from "../../../../platform/tenancy/trusted-principal";
import {
  MissingTrustedPrincipalError,
  readTrustedPrincipal,
} from "../../../../platform/tenancy/trusted-principal-carrier";
import type {
  AccessTokenService,
  VerifiedAccessTokenClaims,
} from "../../../application/contracts/access-token.service";
import { InvalidAccessTokenError } from "../../../application/contracts/authentication.errors";
import type {
  AuthenticatedPrincipalRecord,
  IdentityAccessRepository,
} from "../../../application/contracts/identity-access.repository";
import { AccessTokenAuthGuard } from "./access-token-auth.guard";

describe("AccessTokenAuthGuard", () => {
  const userId = randomUUID();
  const organizationId = randomUUID();
  const sessionId = randomUUID();

  function claimsFor(
    overrides: Partial<VerifiedAccessTokenClaims> = {},
  ): VerifiedAccessTokenClaims {
    return {
      userId,
      organizationId,
      roles: ["EMPLOYEE"],
      sessionId,
      tokenId: randomUUID(),
      ...overrides,
    };
  }

  function persistedPrincipal(
    roles: readonly PrincipalRole[] = ["EMPLOYEE"],
    overrides: Partial<AuthenticatedPrincipalRecord> = {},
  ): AuthenticatedPrincipalRecord {
    return { userId, organizationId, roles, ...overrides };
  }

  interface GuardHarness {
    readonly guard: AccessTokenAuthGuard;
    readonly request: { headers: Record<string, string> };
    readonly context: ExecutionContext;
    readonly lookups: string[];
  }

  function buildGuard(options: {
    readonly claims?: VerifiedAccessTokenClaims | InvalidAccessTokenError;
    readonly principal?: AuthenticatedPrincipalRecord | null;
    readonly isPublic?: boolean;
    readonly authorization?: string;
    readonly lookupError?: Error;
  }): GuardHarness {
    const lookups: string[] = [];

    const accessTokenService: Pick<AccessTokenService, "verify"> = {
      verify: async () => {
        if (options.claims instanceof InvalidAccessTokenError) {
          throw options.claims;
        }

        return options.claims ?? claimsFor();
      },
    };

    const identityAccessRepository: Pick<
      IdentityAccessRepository,
      "findAuthenticatedPrincipal"
    > = {
      findAuthenticatedPrincipal: async (criteria) => {
        lookups.push(criteria.userId);

        if (options.lookupError !== undefined) {
          throw options.lookupError;
        }

        return options.principal === undefined
          ? persistedPrincipal()
          : options.principal;
      },
    };

    const reflector = {
      getAllAndOverride: (key: string) =>
        key === IS_PUBLIC_ROUTE ? options.isPublic : undefined,
    } as unknown as Reflector;

    const request = {
      headers:
        options.authorization === undefined
          ? { authorization: "Bearer aaa.bbb.ccc" }
          : { authorization: options.authorization },
    };

    const context = {
      getType: () => "http",
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    return {
      guard: new AccessTokenAuthGuard(
        reflector,
        accessTokenService as AccessTokenService,
        identityAccessRepository as IdentityAccessRepository,
      ),
      request,
      context,
      lookups,
    };
  }

  it("binds the principal from persisted identity, not from the token's role claims", async () => {
    // The token was minted when this user was an ADMIN. Persistence says otherwise now.
    const harness = buildGuard({
      claims: claimsFor({ roles: ["ADMIN", "FINANCE"] }),
      principal: persistedPrincipal(["EMPLOYEE"]),
    });

    await expect(harness.guard.canActivate(harness.context)).resolves.toBe(
      true,
    );

    expect(readTrustedPrincipal(harness.request)).toEqual({
      userId,
      organizationId,
      roles: ["EMPLOYEE"],
    });
  });

  it("binds an immutable snapshot", async () => {
    const harness = buildGuard({});

    await harness.guard.canActivate(harness.context);
    const principal = readTrustedPrincipal(harness.request);

    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal.roles)).toBe(true);
  });

  it("authenticates an active principal that holds no roles", async () => {
    const harness = buildGuard({ principal: persistedPrincipal([]) });

    await expect(harness.guard.canActivate(harness.context)).resolves.toBe(
      true,
    );
    expect(readTrustedPrincipal(harness.request).roles).toEqual([]);
  });

  it("rejects a user persistence no longer returns as active", async () => {
    const harness = buildGuard({ principal: null });

    await expect(
      harness.guard.canActivate(harness.context),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(() => readTrustedPrincipal(harness.request)).toThrow(
      MissingTrustedPrincipalError,
    );
  });

  it("rejects a correctly signed token whose organization disagrees with persistence", async () => {
    const harness = buildGuard({
      claims: claimsFor({ organizationId: randomUUID() }),
      principal: persistedPrincipal(),
    });

    await expect(
      harness.guard.canActivate(harness.context),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(() => readTrustedPrincipal(harness.request)).toThrow(
      MissingTrustedPrincipalError,
    );
  });

  it("rejects every cryptographic failure the same way, without touching persistence", async () => {
    const harness = buildGuard({ claims: new InvalidAccessTokenError() });

    await expect(
      harness.guard.canActivate(harness.context),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(harness.lookups).toEqual([]);
  });

  it.each([
    ["a missing header", undefined],
    ["an empty header", ""],
    ["a bare token", "aaa.bbb.ccc"],
    ["another scheme", "Basic aaa.bbb.ccc"],
    ["an empty credential", "Bearer "],
    ["a non-compact serialization", "Bearer aaa.bbb"],
    ["a smuggled second credential", "Bearer aaa.bbb.ccc ddd.eee.fff"],
    [
      "a duplicated header Express joined",
      "Bearer aaa.bbb.ccc, Bearer ddd.eee.fff",
    ],
  ])("refuses %s before verifying anything", async (_case, authorization) => {
    const harness = buildGuard({ authorization: authorization ?? "" });

    if (authorization === undefined) {
      delete (harness.request.headers as Record<string, string | undefined>)
        .authorization;
    }

    await expect(
      harness.guard.canActivate(harness.context),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(harness.lookups).toEqual([]);
  });

  it("accepts the Bearer scheme case-insensitively, as RFC 7235 requires", async () => {
    const harness = buildGuard({ authorization: "bEaReR aaa.bbb.ccc" });

    await expect(harness.guard.canActivate(harness.context)).resolves.toBe(
      true,
    );
  });

  it("lets a public route through without looking at credentials", async () => {
    const harness = buildGuard({ isPublic: true, authorization: "" });

    await expect(harness.guard.canActivate(harness.context)).resolves.toBe(
      true,
    );
    expect(harness.lookups).toEqual([]);
    expect(() => readTrustedPrincipal(harness.request)).toThrow(
      MissingTrustedPrincipalError,
    );
  });

  it("denies a transport it cannot inspect", async () => {
    const harness = buildGuard({});
    const nonHttpContext = {
      getType: () => "rpc",
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;

    await expect(
      harness.guard.canActivate(nonHttpContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("does not turn a persistence outage into an authentication answer", async () => {
    // A 401 here would tell a client that the outage is about their identity, and would
    // mask an availability incident as a credential problem.
    const harness = buildGuard({
      lookupError: new Error("connection terminated"),
    });

    await expect(harness.guard.canActivate(harness.context)).rejects.toThrow(
      "connection terminated",
    );
  });
});

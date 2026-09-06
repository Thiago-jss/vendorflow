import { randomUUID } from "node:crypto";
import type { AccessTokenService } from "../contracts/access-token.service";
import { AuthenticateWithPassword } from "./authenticate-with-password";
import type {
  AuthSessionRepository,
  CreateAuthSessionInput,
} from "../contracts/auth-session.repository";
import {
  AuthenticationRateLimitedError,
  InvalidCredentialsError,
} from "../contracts/authentication.errors";
import { FailedLoginAttemptLimiter } from "../services/failed-login-attempt-limiter";
import type {
  AuthenticatedPrincipalRecord,
  IdentityAccessRepository,
  UserCredentialRecord,
} from "../contracts/identity-access.repository";
import type { PasswordHasher } from "../contracts/password-hasher";
import { hashRefreshToken } from "../support/refresh-token";

describe("AuthenticateWithPassword", () => {
  const userId = randomUUID();
  const organizationId = randomUUID();
  const password = "correct horse battery staple";
  const passwordHash = "$argon2id$v=19$m=19456,p=1,t=2$c2FsdA$ZGlnZXN0";

  interface Harness {
    readonly useCase: AuthenticateWithPassword;
    readonly createdSessions: CreateAuthSessionInput[];
    readonly hasherCalls: string[];
    readonly credentialLookups: string[];
    readonly limiter: FailedLoginAttemptLimiter;
  }

  function buildUseCase(options: {
    readonly credential?: UserCredentialRecord | null;
    readonly principal?: AuthenticatedPrincipalRecord | null;
    readonly passwordMatches?: boolean;
    readonly needsRehash?: boolean;
  }): Harness {
    const createdSessions: CreateAuthSessionInput[] = [];
    const hasherCalls: string[] = [];
    const credentialLookups: string[] = [];

    const identityAccessRepository: Pick<
      IdentityAccessRepository,
      "findCredentialByEmail" | "findAuthenticatedPrincipal"
    > = {
      findCredentialByEmail: async (criteria) => {
        credentialLookups.push(criteria.email);

        return options.credential === undefined
          ? { userId, organizationId, isActive: true, passwordHash }
          : options.credential;
      },
      findAuthenticatedPrincipal: async () =>
        options.principal === undefined
          ? { userId, organizationId, roles: ["EMPLOYEE", "MANAGER"] }
          : options.principal,
    };

    const authSessionRepository: Pick<AuthSessionRepository, "createSession"> =
      {
        createSession: async (input) => {
          createdSessions.push(input);
        },
      };

    const accessTokenService: Pick<AccessTokenService, "issue"> = {
      issue: async () => ({
        token: "issued.access.token",
        expiresAt: new Date(Date.now() + 900_000),
      }),
    };

    const passwordHasher: PasswordHasher = {
      hash: async () => passwordHash,
      verify: async () => {
        hasherCalls.push("verify");
        return options.passwordMatches ?? true;
      },
      verifyDecoy: async () => {
        hasherCalls.push("verifyDecoy");
      },
      needsRehash: () => options.needsRehash ?? false,
    };

    const limiter = new FailedLoginAttemptLimiter({
      maximumFailedAttempts: 5,
      windowMilliseconds: 900_000,
    });

    return {
      useCase: new AuthenticateWithPassword(
        identityAccessRepository as IdentityAccessRepository,
        authSessionRepository as AuthSessionRepository,
        accessTokenService as AccessTokenService,
        passwordHasher,
        limiter,
        { refreshTokenTtlSeconds: 2_592_000 },
      ),
      createdSessions,
      hasherCalls,
      credentialLookups,
      limiter,
    };
  }

  it("issues an access token and an opaque refresh token persisted only as a digest", async () => {
    const harness = buildUseCase({});

    const result = await harness.useCase.execute({
      email: "employee@example.com",
      password,
    });

    expect(result.accessToken).toBe("issued.access.token");
    expect(harness.createdSessions).toHaveLength(1);

    const session = harness.createdSessions[0];
    expect(session?.organizationId).toBe(organizationId);
    expect(session?.userId).toBe(userId);
    // Session identity and family identity are distinct values, and the family is new.
    expect(session?.familyId).not.toBe(session?.sessionId);
    // What persistence receives is the digest, never the token that went to the client.
    expect(session?.tokenHash).toEqual(hashRefreshToken(result.refreshToken));
    expect(session?.tokenHash).toHaveLength(32);
    expect(
      Buffer.from(session?.tokenHash ?? []).toString("utf8"),
    ).not.toContain(result.refreshToken);
    expect(result.refreshTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("normalizes the address the same way the database check constraint does", async () => {
    const harness = buildUseCase({});

    await harness.useCase.execute({
      email: "  EMPLOYEE@Example.COM  ",
      password,
    });

    expect(harness.credentialLookups).toEqual(["employee@example.com"]);
  });

  it.each([
    ["an unknown address", { credential: null }],
    [
      "a deactivated user",
      { credential: { userId, organizationId, isActive: false, passwordHash } },
    ],
    [
      "a user that never received credentials",
      {
        credential: {
          userId,
          organizationId,
          isActive: true,
          passwordHash: null,
        },
      },
    ],
    ["a wrong password", { passwordMatches: false }],
    ["an identity that disappeared mid-login", { principal: null }],
  ])(
    "rejects %s with the same error and no session",
    async (_case, options) => {
      const harness = buildUseCase(options);

      const error = await harness.useCase
        .execute({ email: "employee@example.com", password })
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(InvalidCredentialsError);
      expect({
        name: (error as Error).name,
        message: (error as Error).message,
      }).toEqual({
        name: "InvalidCredentialsError",
        message: "Invalid credentials",
      });
      expect(harness.createdSessions).toEqual([]);
    },
  );

  it.each([
    ["an unknown address", { credential: null }],
    [
      "a deactivated user",
      { credential: { userId, organizationId, isActive: false, passwordHash } },
    ],
    [
      "a user that never received credentials",
      {
        credential: {
          userId,
          organizationId,
          isActive: true,
          passwordHash: null,
        },
      },
    ],
  ])("still performs hashing work for %s", async (_case, options) => {
    const harness = buildUseCase(options);

    await expect(
      harness.useCase.execute({ email: "employee@example.com", password }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    // Skipping the hash here is what would turn "no password hash" into a timing oracle.
    expect(harness.hasherCalls).toEqual(["verifyDecoy"]);
  });

  it("counts a failure for an unknown address too, so lockout is not an enumeration oracle", async () => {
    const harness = buildUseCase({ credential: null });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        harness.useCase.execute({ email: "ghost@example.com", password }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    }

    await expect(
      harness.useCase.execute({ email: "ghost@example.com", password }),
    ).rejects.toBeInstanceOf(AuthenticationRateLimitedError);
  });

  it("stops touching persistence once the account limit is reached", async () => {
    const harness = buildUseCase({ passwordMatches: false });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        harness.useCase.execute({ email: "employee@example.com", password }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    }

    const callsBeforeLockout = harness.hasherCalls.length;

    await expect(
      harness.useCase.execute({ email: "employee@example.com", password }),
    ).rejects.toBeInstanceOf(AuthenticationRateLimitedError);
    expect(harness.hasherCalls).toHaveLength(callsBeforeLockout);
  });

  it("clears the account's failure count after a successful login", async () => {
    const failing = buildUseCase({ passwordMatches: false });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        failing.useCase.execute({ email: "employee@example.com", password }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    }

    expect(failing.limiter.isLocked("employee@example.com")).toBe(false);

    const succeeding = buildUseCase({});
    await succeeding.useCase.execute({
      email: "employee@example.com",
      password,
    });

    expect(succeeding.limiter.isLocked("employee@example.com")).toBe(false);
  });
});

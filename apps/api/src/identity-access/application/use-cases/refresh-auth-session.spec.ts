import { randomUUID } from "node:crypto";
import type {
  AccessTokenService,
  AccessTokenSubject,
} from "../contracts/access-token.service";
import type {
  AuthSessionRepository,
  AuthSessionRotationResult,
  RotateAuthSessionInput,
} from "../contracts/auth-session.repository";
import { InvalidRefreshSessionError } from "../contracts/authentication.errors";
import { RefreshAuthSession } from "./refresh-auth-session";
import { hashRefreshToken } from "../support/refresh-token";

describe("RefreshAuthSession", () => {
  const userId = randomUUID();
  const organizationId = randomUUID();
  const familyId = randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);

  function buildUseCase(result: AuthSessionRotationResult) {
    const rotations: RotateAuthSessionInput[] = [];
    const issued: AccessTokenSubject[] = [];

    const authSessionRepository: Pick<AuthSessionRepository, "rotateSession"> =
      {
        rotateSession: async (input) => {
          rotations.push(input);
          return result;
        },
      };

    const accessTokenService: Pick<AccessTokenService, "issue"> = {
      issue: async (subject) => {
        issued.push(subject);
        return {
          token: "issued.access.token",
          expiresAt: new Date(Date.now() + 900_000),
        };
      },
    };

    return {
      useCase: new RefreshAuthSession(
        authSessionRepository as AuthSessionRepository,
        accessTokenService as AccessTokenService,
      ),
      rotations,
      issued,
    };
  }

  const rotated: AuthSessionRotationResult = {
    outcome: "ROTATED",
    principal: { userId, organizationId, roles: ["BUYER"] },
    sessionId: randomUUID(),
    familyId,
    expiresAt,
  };

  it("presents the digest of the token, never the token itself", async () => {
    const harness = buildUseCase(rotated);

    const result = await harness.useCase.execute({
      presentedToken: "presented-token",
    });

    expect(harness.rotations[0]?.presentedTokenHash).toEqual(
      hashRefreshToken("presented-token"),
    );
    expect(harness.rotations[0]?.successorTokenHash).toEqual(
      hashRefreshToken(result.refreshToken),
    );
    // The successor's plaintext is generated here and reaches persistence only as a digest.
    expect(result.refreshToken).not.toBe("presented-token");
  });

  it("mints the access token from the persisted principal the rotation returned", async () => {
    const harness = buildUseCase(rotated);

    await harness.useCase.execute({ presentedToken: "presented-token" });

    expect(harness.issued).toEqual([
      {
        userId,
        organizationId,
        roles: ["BUYER"],
        sessionId: rotated.sessionId,
      },
    ]);
  });

  it("carries the inherited absolute expiry through to the caller", async () => {
    const harness = buildUseCase(rotated);

    const result = await harness.useCase.execute({
      presentedToken: "presented-token",
    });

    expect(result.refreshTokenExpiresAt).toEqual(expiresAt);
  });

  it.each([
    ["an unknown session", false],
    ["a replayed session", true],
  ])(
    "rejects %s identically and issues no token",
    async (_case, reuseDetected) => {
      const harness = buildUseCase({
        outcome: "REJECTED",
        reuseDetected,
        organizationId: reuseDetected ? organizationId : null,
        familyId: reuseDetected ? familyId : null,
      });

      const error = await harness.useCase
        .execute({ presentedToken: "presented-token" })
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(InvalidRefreshSessionError);
      expect({
        name: (error as Error).name,
        message: (error as Error).message,
      }).toEqual({
        name: "InvalidRefreshSessionError",
        message: "Invalid refresh session",
      });
      expect(harness.issued).toEqual([]);
    },
  );
});

import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { InvalidAccessTokenError } from "../../../application/contracts/authentication.errors";
import {
  JoseAccessTokenService,
  type AccessTokenOptions,
} from "./jose-access-token.service";

describe("JoseAccessTokenService", () => {
  const options: AccessTokenOptions = {
    secret: "a".repeat(32),
    issuer: "vendorflow",
    audience: "vendorflow-api",
    ttlSeconds: 900,
  };
  const key = new TextEncoder().encode(options.secret);
  const service = new JoseAccessTokenService(options);

  const subject = {
    userId: randomUUID(),
    organizationId: randomUUID(),
    roles: ["EMPLOYEE", "MANAGER"] as const,
    sessionId: randomUUID(),
  };

  it("issues a compact token carrying identity, tenant, roles and session", async () => {
    const issued = await service.issue(subject);

    expect(issued.token.split(".")).toHaveLength(3);
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(issued.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 900_000,
    );

    await expect(service.verify(issued.token)).resolves.toEqual({
      userId: subject.userId,
      organizationId: subject.organizationId,
      roles: ["EMPLOYEE", "MANAGER"],
      sessionId: subject.sessionId,
      tokenId: expect.any(String),
    });
  });

  it("gives every token a distinct identifier", async () => {
    const [first, second] = await Promise.all([
      service.issue(subject),
      service.issue(subject),
    ]);

    const [firstClaims, secondClaims] = await Promise.all([
      service.verify(first.token),
      service.verify(second.token),
    ]);

    expect(firstClaims.tokenId).not.toEqual(secondClaims.tokenId);
  });

  it("rejects a malformed token", async () => {
    for (const token of ["", "not-a-token", "a.b", "a.b.c", "a.b.c.d"]) {
      await expect(service.verify(token)).rejects.toBeInstanceOf(
        InvalidAccessTokenError,
      );
    }
  });

  it("rejects a token signed with another key", async () => {
    const foreign = new JoseAccessTokenService({
      ...options,
      secret: "b".repeat(32),
    });
    const issued = await foreign.issue(subject);

    await expect(service.verify(issued.token)).rejects.toBeInstanceOf(
      InvalidAccessTokenError,
    );
  });

  it("rejects an unsigned token even though its claims are well formed", async () => {
    const issued = await service.issue(subject);
    const [, payload] = issued.token.split(".");
    const unsignedHeader = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url");

    await expect(
      service.verify(`${unsignedHeader}.${payload}.`),
    ).rejects.toBeInstanceOf(InvalidAccessTokenError);
  });

  it("rejects an expired token with no clock leeway", async () => {
    const expired = await signCustomToken({ secondsFromNow: -1 });

    await expect(service.verify(expired)).rejects.toBeInstanceOf(
      InvalidAccessTokenError,
    );
  });

  it("rejects a token minted for another issuer or another audience", async () => {
    const wrongIssuer = await signCustomToken({ issuer: "someone-else" });
    const wrongAudience = await signCustomToken({ audience: "another-api" });

    await expect(service.verify(wrongIssuer)).rejects.toBeInstanceOf(
      InvalidAccessTokenError,
    );
    await expect(service.verify(wrongAudience)).rejects.toBeInstanceOf(
      InvalidAccessTokenError,
    );
  });

  it("rejects a validly signed token whose claims do not match the contract", async () => {
    const missingOrganization = await signCustomToken({
      claims: { sid: randomUUID(), roles: [] },
    });
    const unknownRole = await signCustomToken({
      claims: { org: randomUUID(), sid: randomUUID(), roles: ["SUPERUSER"] },
    });
    const nonUuidSubject = await signCustomToken({ subject: "not-a-uuid" });
    const extraClaim = await signCustomToken({
      claims: {
        org: randomUUID(),
        sid: randomUUID(),
        roles: [],
        impersonate: true,
      },
    });

    for (const token of [
      missingOrganization,
      unknownRole,
      nonUuidSubject,
      extraClaim,
    ]) {
      await expect(service.verify(token)).rejects.toBeInstanceOf(
        InvalidAccessTokenError,
      );
    }
  });

  it("accepts an active principal that currently holds no roles", async () => {
    const issued = await service.issue({ ...subject, roles: [] });

    await expect(service.verify(issued.token)).resolves.toMatchObject({
      roles: [],
    });
  });

  async function signCustomToken(overrides: {
    readonly issuer?: string;
    readonly audience?: string;
    readonly subject?: string;
    readonly secondsFromNow?: number;
    readonly claims?: Record<string, unknown>;
  }): Promise<string> {
    const issuedAt = Math.floor(Date.now() / 1000);

    return new SignJWT(
      overrides.claims ?? {
        org: subject.organizationId,
        sid: subject.sessionId,
        roles: [...subject.roles],
      },
    )
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(overrides.subject ?? subject.userId)
      .setIssuer(overrides.issuer ?? options.issuer)
      .setAudience(overrides.audience ?? options.audience)
      .setJti(randomUUID())
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + (overrides.secondsFromNow ?? 900))
      .sign(key);
  }
});

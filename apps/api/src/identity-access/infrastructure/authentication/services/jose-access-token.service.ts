import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { principalRoles } from "../../../../platform/tenancy/trusted-principal";
import type {
  AccessTokenService,
  AccessTokenSubject,
  IssuedAccessToken,
  VerifiedAccessTokenClaims,
} from "../../../application/contracts/access-token.service";
import { InvalidAccessTokenError } from "../../../application/contracts/authentication.errors";

/**
 * Single-element allowlist. Passing the accepted algorithm explicitly is what stops both
 * `alg: none` and algorithm-confusion attacks, where an attacker re-signs a token with an
 * algorithm the verifier would otherwise accept.
 */
const ACCESS_TOKEN_ALGORITHMS = ["HS256"] as const;
const ACCESS_TOKEN_TYPE = "JWT";

/**
 * Every claim the token may carry, and nothing else. `.strict()` rejects a token carrying an
 * unexpected claim (SEC-004) instead of ignoring it, so a claim added by a different signer
 * or an older format cannot slip through unnoticed.
 */
const accessTokenClaimsSchema = z
  .object({
    iss: z.string().min(1),
    aud: z.string().min(1),
    sub: z.string().uuid(),
    jti: z.string().uuid(),
    iat: z.number().int(),
    exp: z.number().int(),
    org: z.string().uuid(),
    sid: z.string().uuid(),
    // May legitimately be empty: an active user with no roles authenticates and is then
    // denied by default-deny authorization, which is a 403 question, not a 401 one.
    roles: z.array(z.enum(principalRoles)),
  })
  .strict();

export interface AccessTokenOptions {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly ttlSeconds: number;
}

@Injectable()
export class JoseAccessTokenService implements AccessTokenService {
  private readonly key: Uint8Array;

  constructor(private readonly options: AccessTokenOptions) {
    this.key = new TextEncoder().encode(options.secret);
  }

  async issue(subject: AccessTokenSubject): Promise<IssuedAccessToken> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + this.options.ttlSeconds;

    const token = await new SignJWT({
      org: subject.organizationId,
      sid: subject.sessionId,
      roles: [...subject.roles],
    })
      .setProtectedHeader({ alg: "HS256", typ: ACCESS_TOKEN_TYPE })
      .setSubject(subject.userId)
      .setIssuer(this.options.issuer)
      .setAudience(this.options.audience)
      .setJti(randomUUID())
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.key);

    return { token, expiresAt: new Date(expiresAt * 1000) };
  }

  async verify(token: string): Promise<VerifiedAccessTokenClaims> {
    let payload: unknown;

    try {
      const verified = await jwtVerify(token, this.key, {
        algorithms: [...ACCESS_TOKEN_ALGORITHMS],
        typ: ACCESS_TOKEN_TYPE,
        issuer: this.options.issuer,
        audience: this.options.audience,
        // No leeway. A short-lived token whose expiry is negotiable is not short-lived.
        clockTolerance: 0,
      });

      payload = verified.payload;
    } catch {
      throw new InvalidAccessTokenError();
    }

    const claims = accessTokenClaimsSchema.safeParse(payload);

    if (!claims.success) {
      throw new InvalidAccessTokenError();
    }

    return {
      userId: claims.data.sub,
      organizationId: claims.data.org,
      roles: claims.data.roles,
      sessionId: claims.data.sid,
      tokenId: claims.data.jti,
    };
  }
}

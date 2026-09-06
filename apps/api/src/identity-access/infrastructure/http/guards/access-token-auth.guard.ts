import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { IS_PUBLIC_ROUTE } from "../../../../platform/http/public-route.decorator";
import { bindTrustedPrincipal } from "../../../../platform/tenancy/trusted-principal-carrier";
import {
  ACCESS_TOKEN_SERVICE,
  type AccessTokenService,
} from "../../../application/contracts/access-token.service";
import { InvalidAccessTokenError } from "../../../application/contracts/authentication.errors";
import {
  IDENTITY_ACCESS_REPOSITORY,
  type IdentityAccessRepository,
} from "../../../application/contracts/identity-access.repository";

/**
 * Compact JWS serialization and nothing else. Anchoring the whole header value rejects a
 * duplicated `Authorization` header — Express joins repeats with a comma — as well as extra
 * parameters or a second credential smuggled after whitespace.
 */
const BEARER_PATTERN =
  /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

/**
 * Authenticates every request that is not explicitly marked public, and binds the trusted
 * principal from PERSISTED identity.
 *
 * The token proves who signed it; PostgreSQL decides who the caller currently is. A valid,
 * unexpired token for a user who has since been deactivated, deleted, or had a role revoked
 * must not keep working until it expires, so the claims are verified and then set aside:
 * the bound `TrustedPrincipal` is built entirely from the persisted row.
 */
@Injectable()
export class AccessTokenAuthGuard implements CanActivate {
  private readonly logger = new Logger(AccessTokenAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(ACCESS_TOKEN_SERVICE)
    private readonly accessTokenService: AccessTokenService,
    @Inject(IDENTITY_ACCESS_REPOSITORY)
    private readonly identityAccessRepository: IdentityAccessRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_ROUTE,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic === true) {
      return true;
    }

    // Default-deny: a transport this guard cannot inspect is not a transport it can
    // authenticate.
    if (context.getType() !== "http") {
      throw new UnauthorizedException();
    }

    const request = context.switchToHttp().getRequest<Request>();

    try {
      await this.authenticate(request);
    } catch (error: unknown) {
      if (error instanceof InvalidAccessTokenError) {
        // Every rejection reason collapses into one response. A database outage is not
        // caught here and still surfaces as 500: availability is not an identity signal.
        throw new UnauthorizedException();
      }

      throw error;
    }

    return true;
  }

  private async authenticate(request: Request): Promise<void> {
    const token = this.readBearerToken(request);
    const claims = await this.accessTokenService.verify(token);

    const principal =
      await this.identityAccessRepository.findAuthenticatedPrincipal({
        userId: claims.userId,
      });

    if (principal === null) {
      throw new InvalidAccessTokenError();
    }

    if (principal.organizationId !== claims.organizationId) {
      // A correctly signed token whose tenant disagrees with persistence means the signing
      // key is compromised or issuance is broken. Identifiers only, never the token.
      this.logger.warn({
        event: "ACCESS_TOKEN_ORGANIZATION_MISMATCH",
        userId: principal.userId,
        claimedOrganizationId: claims.organizationId,
        persistedOrganizationId: principal.organizationId,
      });

      throw new InvalidAccessTokenError();
    }

    // Persisted roles, not `claims.roles`. This is the line that makes a revoked role take
    // effect on the next request instead of at token expiry.
    bindTrustedPrincipal(request, {
      userId: principal.userId,
      organizationId: principal.organizationId,
      roles: principal.roles,
    });
  }

  private readBearerToken(request: Request): string {
    const header: unknown = request.headers.authorization;

    if (typeof header !== "string") {
      throw new InvalidAccessTokenError();
    }

    const match = BEARER_PATTERN.exec(header);

    if (match?.[1] === undefined) {
      throw new InvalidAccessTokenError();
    }

    return match[1];
  }
}

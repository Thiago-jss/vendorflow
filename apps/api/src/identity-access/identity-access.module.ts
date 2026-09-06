import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { DatabaseModule } from "@vendorflow/database";
import type { Environment } from "../config/env";
import { TenantContextModule } from "../platform/tenancy/tenant-context.module";
import { ACCESS_TOKEN_SERVICE } from "./application/contracts/access-token.service";
import { AUTH_SESSION_REPOSITORY } from "./application/contracts/auth-session.repository";
import { AUTHENTICATION_OPTIONS } from "./application/contracts/authentication.options";
import { AuthenticateWithPassword } from "./application/use-cases/authenticate-with-password";
import { FailedLoginAttemptLimiter } from "./application/services/failed-login-attempt-limiter";
import { GetCurrentOrganizationContext } from "./application/use-cases/get-current-organization-context";
import { IDENTITY_ACCESS_REPOSITORY } from "./application/contracts/identity-access.repository";
import { PASSWORD_HASHER } from "./application/contracts/password-hasher";
import { RefreshAuthSession } from "./application/use-cases/refresh-auth-session";
import { RevokeAuthSession } from "./application/use-cases/revoke-auth-session";
import { Argon2PasswordHasher } from "./infrastructure/authentication/services/argon2-password-hasher";
import { JoseAccessTokenService } from "./infrastructure/authentication/services/jose-access-token.service";
import { PrismaAuthSessionRepository } from "./infrastructure/authentication/persistence/prisma-auth-session.repository";
import { PrismaIdentityAccessRepository } from "./infrastructure/authentication/persistence/prisma-identity-access.repository";
import { AccessTokenAuthGuard } from "./infrastructure/http/guards/access-token-auth.guard";
import { AUTH_ALLOWED_ORIGINS } from "./infrastructure/http/guards/auth-origin.guard";
import { AuthController } from "./infrastructure/http/controllers/auth.controller";
import { CurrentOrganizationController } from "./infrastructure/http/controllers/current-organization.controller";

/**
 * Owns authentication and authorization primitives for the whole API, as ADR-001 requires:
 * a separate "auth" module would split the identity model from the thing that authenticates
 * against it.
 */
@Module({
  imports: [
    DatabaseModule,
    TenantContextModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Environment, true>) => ({
        // In-memory storage. Correct for one API instance and no more; see
        // docs/architecture/authentication-session-security.md.
        throttlers: [
          {
            name: "auth",
            ttl:
              configService.get("AUTH_IP_RATE_LIMIT_WINDOW_SECONDS", {
                infer: true,
              }) * 1000,
            limit: configService.get("AUTH_IP_RATE_LIMIT", { infer: true }),
          },
        ],
      }),
    }),
  ],
  controllers: [AuthController, CurrentOrganizationController],
  providers: [
    PrismaIdentityAccessRepository,
    {
      provide: IDENTITY_ACCESS_REPOSITORY,
      useExisting: PrismaIdentityAccessRepository,
    },
    PrismaAuthSessionRepository,
    {
      provide: AUTH_SESSION_REPOSITORY,
      useExisting: PrismaAuthSessionRepository,
    },
    {
      provide: PASSWORD_HASHER,
      useClass: Argon2PasswordHasher,
    },
    {
      provide: ACCESS_TOKEN_SERVICE,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Environment, true>) =>
        new JoseAccessTokenService({
          secret: configService.get("AUTH_JWT_SECRET", { infer: true }),
          issuer: configService.get("AUTH_JWT_ISSUER", { infer: true }),
          audience: configService.get("AUTH_JWT_AUDIENCE", { infer: true }),
          ttlSeconds: configService.get("AUTH_ACCESS_TOKEN_TTL_SECONDS", {
            infer: true,
          }),
        }),
    },
    {
      provide: AUTHENTICATION_OPTIONS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Environment, true>) => ({
        refreshTokenTtlSeconds: configService.get(
          "AUTH_REFRESH_TOKEN_TTL_SECONDS",
          { infer: true },
        ),
      }),
    },
    {
      provide: FailedLoginAttemptLimiter,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Environment, true>) =>
        new FailedLoginAttemptLimiter({
          maximumFailedAttempts: configService.get(
            "AUTH_ACCOUNT_MAX_FAILED_ATTEMPTS",
            { infer: true },
          ),
          windowMilliseconds:
            configService.get("AUTH_ACCOUNT_LOCKOUT_WINDOW_SECONDS", {
              infer: true,
            }) * 1000,
        }),
    },
    {
      provide: AUTH_ALLOWED_ORIGINS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Environment, true>) =>
        configService.get("CORS_ORIGINS", { infer: true }),
    },
    AuthenticateWithPassword,
    RefreshAuthSession,
    RevokeAuthSession,
    GetCurrentOrganizationContext,
    // Authentication is default-deny across the whole application. Only a handler carrying
    // @Public() is exempt, so forgetting to protect a new route cannot expose it.
    {
      provide: APP_GUARD,
      useClass: AccessTokenAuthGuard,
    },
  ],
  exports: [GetCurrentOrganizationContext],
})
export class IdentityAccessModule {}

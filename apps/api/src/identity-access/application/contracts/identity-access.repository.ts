import type { PrincipalRole } from "../../../platform/tenancy/trusted-principal";

export const IDENTITY_ACCESS_REPOSITORY = Symbol("IDENTITY_ACCESS_REPOSITORY");

export interface TenantBranch {
  readonly id: string;
  readonly name: string;
}

export interface FindTenantBranchCriteria {
  readonly organizationId: string;
  readonly branchId: string;
}

export interface CurrentOrganizationContextRecord {
  readonly organization: {
    readonly id: string;
    readonly name: string;
  };
  readonly membership: {
    readonly userId: string;
    readonly branch: TenantBranch;
    readonly department: {
      readonly id: string;
      readonly name: string;
    };
    readonly roles: readonly PrincipalRole[];
  };
}

/**
 * The authoritative principal: identity, tenant and roles as PostgreSQL currently holds
 * them. Authentication builds `TrustedPrincipal` from this record and never from token
 * claims, so deactivation and role changes take effect on the next protected request.
 */
export interface AuthenticatedPrincipalRecord {
  readonly userId: string;
  readonly organizationId: string;
  readonly roles: readonly PrincipalRole[];
}

/**
 * Everything password verification needs, and nothing else. `isActive` and `passwordHash`
 * are returned rather than filtered in SQL so the application can answer every rejection
 * with one indistinguishable result instead of leaking the reason through query shape.
 */
export interface UserCredentialRecord {
  readonly userId: string;
  readonly organizationId: string;
  readonly isActive: boolean;
  readonly passwordHash: string | null;
}

export interface IdentityAccessRepository {
  findBranch(criteria: FindTenantBranchCriteria): Promise<TenantBranch | null>;

  listBranches(criteria: {
    readonly organizationId: string;
  }): Promise<readonly TenantBranch[]>;

  findCurrentOrganizationContext(criteria: {
    readonly organizationId: string;
    readonly userId: string;
  }): Promise<CurrentOrganizationContextRecord | null>;

  /**
   * AUTHENTICATION-ONLY tenant-derivation exception.
   *
   * Every tenant-owned read in this codebase takes `organizationId` from an already-trusted
   * principal (ADR-002). Authentication is the one place where no trusted principal exists
   * yet: it is where the tenant is *derived* from persisted identity and then *compared*
   * against the signed claim. Scoping this lookup by the claimed organization would turn
   * that comparison into a tautology — a forged or stale organization would surface as
   * "user not found" instead of as the security event it is.
   *
   * Do not copy this shape into a domain read. A tenant-owned resource read by a
   * `userId`-only criterion is a defect.
   */
  findAuthenticatedPrincipal(criteria: {
    readonly userId: string;
  }): Promise<AuthenticatedPrincipalRecord | null>;

  /**
   * AUTHENTICATION-ONLY tenant-derivation exception, for the same reason as
   * {@link IdentityAccessRepository.findAuthenticatedPrincipal}. Normalized email is
   * globally unique precisely so login can resolve the User first and derive the
   * Organization from persisted identity instead of accepting a tenant from the client
   * (MT-006).
   */
  findCredentialByEmail(criteria: {
    readonly email: string;
  }): Promise<UserCredentialRecord | null>;
}

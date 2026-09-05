import type { PrincipalRole } from "../../platform/tenancy/trusted-principal";

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

export interface IdentityAccessRepository {
  findBranch(criteria: FindTenantBranchCriteria): Promise<TenantBranch | null>;

  listBranches(criteria: {
    readonly organizationId: string;
  }): Promise<readonly TenantBranch[]>;

  findCurrentOrganizationContext(criteria: {
    readonly organizationId: string;
    readonly userId: string;
  }): Promise<CurrentOrganizationContextRecord | null>;
}

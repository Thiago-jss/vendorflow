import { Injectable } from "@nestjs/common";
import { DatabaseService } from "@vendorflow/database";
import type {
  AuthenticatedPrincipalRecord,
  CurrentOrganizationContextRecord,
  FindTenantBranchCriteria,
  IdentityAccessRepository,
  TenantBranch,
  UserCredentialRecord,
} from "../../../application/contracts/identity-access.repository";
import { toPrincipalRole } from "./principal-role";

@Injectable()
export class PrismaIdentityAccessRepository
  implements IdentityAccessRepository
{
  constructor(private readonly database: DatabaseService) {}

  async findBranch(
    criteria: FindTenantBranchCriteria,
  ): Promise<TenantBranch | null> {
    return this.database.branch.findUnique({
      where: {
        organizationId_id: {
          organizationId: criteria.organizationId,
          id: criteria.branchId,
        },
      },
      select: {
        id: true,
        name: true,
      },
    });
  }

  async listBranches(criteria: {
    readonly organizationId: string;
  }): Promise<readonly TenantBranch[]> {
    return this.database.branch.findMany({
      where: {
        organizationId: criteria.organizationId,
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
      },
    });
  }

  async findCurrentOrganizationContext(criteria: {
    readonly organizationId: string;
    readonly userId: string;
  }): Promise<CurrentOrganizationContextRecord | null> {
    const membership = await this.database.user.findUnique({
      where: {
        organizationId_id: {
          organizationId: criteria.organizationId,
          id: criteria.userId,
        },
        isActive: true,
      },
      select: {
        id: true,
        organization: {
          select: {
            id: true,
            name: true,
          },
        },
        branch: {
          select: {
            id: true,
            name: true,
          },
        },
        department: {
          select: {
            id: true,
            name: true,
          },
        },
        roles: {
          orderBy: {
            role: "asc",
          },
          select: {
            role: true,
          },
        },
      },
    });

    if (membership === null) {
      return null;
    }

    return {
      organization: membership.organization,
      membership: {
        userId: membership.id,
        branch: membership.branch,
        department: membership.department,
        roles: membership.roles.map(({ role }) => toPrincipalRole(role)),
      },
    };
  }

  /**
   * Authentication-only. Selected by primary key alone so the caller can compare persisted
   * `organizationId` against the signed claim; scoping by the claimed organization would
   * hide a mismatch as a miss. `isActive` is part of the predicate so a deactivated user is
   * simply absent, which is what makes deactivation take effect on the next request.
   */
  async findAuthenticatedPrincipal(criteria: {
    readonly userId: string;
  }): Promise<AuthenticatedPrincipalRecord | null> {
    const user = await this.database.user.findUnique({
      where: {
        id: criteria.userId,
        isActive: true,
      },
      select: {
        id: true,
        organizationId: true,
        roles: {
          orderBy: {
            role: "asc",
          },
          select: {
            role: true,
          },
        },
      },
    });

    if (user === null) {
      return null;
    }

    return {
      userId: user.id,
      organizationId: user.organizationId,
      roles: user.roles.map(({ role }) => toPrincipalRole(role)),
    };
  }

  /**
   * Authentication-only. Normalized email is globally unique so login resolves the User
   * first and derives its Organization (MT-006). `isActive` and `passwordHash` are returned
   * rather than filtered, so every rejection reason takes one identical application path.
   */
  async findCredentialByEmail(criteria: {
    readonly email: string;
  }): Promise<UserCredentialRecord | null> {
    const user = await this.database.user.findUnique({
      where: {
        email: criteria.email,
      },
      select: {
        id: true,
        organizationId: true,
        isActive: true,
        passwordHash: true,
      },
    });

    if (user === null) {
      return null;
    }

    return {
      userId: user.id,
      organizationId: user.organizationId,
      isActive: user.isActive,
      passwordHash: user.passwordHash,
    };
  }
}

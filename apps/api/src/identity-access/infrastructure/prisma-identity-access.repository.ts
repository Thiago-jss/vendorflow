import { Injectable } from "@nestjs/common";
import { DatabaseService } from "@vendorflow/database";
import type {
  CurrentOrganizationContextRecord,
  FindTenantBranchCriteria,
  IdentityAccessRepository,
  TenantBranch,
} from "../application/identity-access.repository";
import {
  principalRoles,
  type PrincipalRole,
} from "../../platform/tenancy/trusted-principal";

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
        roles: membership.roles.map(({ role }) => this.toPrincipalRole(role)),
      },
    };
  }

  private toPrincipalRole(role: string): PrincipalRole {
    const principalRole = principalRoles.find(
      (candidate) => candidate === role,
    );

    if (principalRole === undefined) {
      throw new Error("Persistence returned an unsupported role");
    }

    return principalRole;
  }
}

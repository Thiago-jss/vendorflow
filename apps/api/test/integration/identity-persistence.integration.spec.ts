import { randomUUID } from "node:crypto";
import { DatabaseService } from "@vendorflow/database";
import {
  CurrentOrganizationContextNotFoundError,
  GetCurrentOrganizationContext,
} from "../../src/identity-access/application/get-current-organization-context";
import type { TrustedPrincipal } from "../../src/platform/tenancy/trusted-principal";
import { PrismaIdentityAccessRepository } from "../../src/identity-access/infrastructure/prisma-identity-access.repository";
import { PostgreSqlIntegrationTestHarness } from "./postgresql-test-harness";

interface TenantFixture {
  readonly organizationId: string;
  readonly branchId: string;
  readonly departmentId: string;
  readonly userId: string;
  readonly email: string;
}

describe("identity persistence tenant isolation (PostgreSQL)", () => {
  let harness: PostgreSqlIntegrationTestHarness;
  let database: DatabaseService;
  let repository: PrismaIdentityAccessRepository;
  let getCurrentOrganizationContext: GetCurrentOrganizationContext;
  let organizationA: TenantFixture;
  let organizationB: TenantFixture;

  beforeAll(async () => {
    harness = await PostgreSqlIntegrationTestHarness.start();
    database = harness.database;
    repository = new PrismaIdentityAccessRepository(database);
    getCurrentOrganizationContext = new GetCurrentOrganizationContext(
      repository,
    );
  }, 120_000);

  beforeEach(async () => {
    await harness.clean();
    organizationA = await createTenant(database, "A");
    organizationB = await createTenant(database, "B");
  });

  afterAll(async () => {
    if (harness !== undefined) {
      await harness.stop();
    }
  });

  it("applies the complete migration history and removes platform_metadata", async () => {
    const tables = await database.$queryRaw<
      Array<{ readonly tableName: string | null }>
    >`SELECT to_regclass('public.platform_metadata')::text AS "tableName"`;

    expect(tables).toEqual([{ tableName: null }]);
  });

  it("loads an own branch and treats a foreign branch as absent", async () => {
    await expect(
      repository.findBranch({
        organizationId: organizationA.organizationId,
        branchId: organizationA.branchId,
      }),
    ).resolves.toEqual({
      id: organizationA.branchId,
      name: "Head Office",
    });

    await expect(
      repository.findBranch({
        organizationId: organizationA.organizationId,
        branchId: organizationB.branchId,
      }),
    ).resolves.toBeNull();
  });

  it("never includes another tenant's rows in a tenant-scoped list", async () => {
    await database.branch.create({
      data: {
        organizationId: organizationA.organizationId,
        name: "Warehouse",
      },
    });

    const branches = await repository.listBranches({
      organizationId: organizationA.organizationId,
    });

    expect(branches).toEqual([
      { id: organizationA.branchId, name: "Head Office" },
      expect.objectContaining({ name: "Warehouse" }),
    ]);
    expect(branches).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: organizationB.branchId }),
      ]),
    );
  });

  it("rejects cross-tenant hierarchy, membership, and role relationships in PostgreSQL", async () => {
    await expect(
      database.department.create({
        data: {
          organizationId: organizationA.organizationId,
          branchId: organizationB.branchId,
          name: "Invalid Department",
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });

    await expect(
      database.user.create({
        data: {
          organizationId: organizationA.organizationId,
          branchId: organizationA.branchId,
          departmentId: organizationB.departmentId,
          name: "Invalid User",
          email: "invalid@example.com",
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });

    await expect(
      database.userRole.create({
        data: {
          organizationId: organizationA.organizationId,
          userId: organizationB.userId,
          role: "ADMIN",
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("enforces tenant-aware branch and role membership uniqueness", async () => {
    await expect(
      database.branch.create({
        data: {
          organizationId: organizationA.organizationId,
          name: "Head Office",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    await expect(
      database.branch.count({ where: { name: "Head Office" } }),
    ).resolves.toBe(2);

    await expect(
      database.userRole.create({
        data: {
          organizationId: organizationA.organizationId,
          userId: organizationA.userId,
          role: "EMPLOYEE",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("rejects the same normalized email in a different organization", async () => {
    await expect(
      database.user.create({
        data: {
          organizationId: organizationB.organizationId,
          branchId: organizationB.branchId,
          departmentId: organizationB.departmentId,
          name: "Duplicate Email",
          email: organizationA.email,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows different normalized emails in different organizations", async () => {
    const users = await database.user.findMany({
      orderBy: { email: "asc" },
      select: { email: true },
    });

    expect(users).toEqual([
      { email: "employee-a@example.com" },
      { email: "employee-b@example.com" },
    ]);
  });

  it("enforces department names per branch, not across an organization", async () => {
    const secondBranch = await database.branch.create({
      data: {
        organizationId: organizationA.organizationId,
        name: "Plant",
      },
    });

    await expect(
      database.department.create({
        data: {
          organizationId: organizationA.organizationId,
          branchId: secondBranch.id,
          name: "Operations",
        },
      }),
    ).resolves.toMatchObject({ name: "Operations" });

    await expect(
      database.department.create({
        data: {
          organizationId: organizationA.organizationId,
          branchId: organizationA.branchId,
          name: "Operations",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("builds current organization context only from the trusted principal's membership", async () => {
    const context = await getCurrentOrganizationContext.execute(
      principal(organizationA.organizationId, organizationA.userId, [
        "FINANCE",
      ]),
    );

    expect(context).toEqual({
      organization: {
        id: organizationA.organizationId,
        name: "Organization A",
      },
      membership: {
        userId: organizationA.userId,
        branch: {
          id: organizationA.branchId,
          name: "Head Office",
        },
        department: {
          id: organizationA.departmentId,
          name: "Operations",
        },
        roles: ["EMPLOYEE", "MANAGER"],
      },
    });
  });

  it("makes foreign, missing, and missing-tenant memberships indistinguishable", async () => {
    const errors = await Promise.all([
      captureApplicationError(
        getCurrentOrganizationContext.execute(
          principal(organizationA.organizationId, organizationB.userId),
        ),
      ),
      captureApplicationError(
        getCurrentOrganizationContext.execute(
          principal(organizationA.organizationId, randomUUID()),
        ),
      ),
      captureApplicationError(
        getCurrentOrganizationContext.execute(
          principal(randomUUID(), organizationA.userId),
        ),
      ),
    ]);

    for (const error of errors) {
      expect(error).toBeInstanceOf(CurrentOrganizationContextNotFoundError);
      expect({ name: error.name, message: error.message }).toEqual({
        name: "CurrentOrganizationContextNotFoundError",
        message: "Current organization context was not found",
      });
    }
  });
});

async function createTenant(
  database: DatabaseService,
  suffix: "A" | "B",
): Promise<TenantFixture> {
  const email = `employee-${suffix.toLowerCase()}@example.com`;
  const organization = await database.organization.create({
    data: {
      name: `Organization ${suffix}`,
    },
  });
  const branch = await database.branch.create({
    data: {
      organizationId: organization.id,
      name: "Head Office",
    },
  });
  const department = await database.department.create({
    data: {
      organizationId: organization.id,
      branchId: branch.id,
      name: "Operations",
    },
  });
  const user = await database.user.create({
    data: {
      organizationId: organization.id,
      branchId: branch.id,
      departmentId: department.id,
      name: `Employee ${suffix}`,
      email,
    },
  });

  await database.userRole.createMany({
    data: [
      {
        organizationId: organization.id,
        userId: user.id,
        role: "EMPLOYEE",
      },
      {
        organizationId: organization.id,
        userId: user.id,
        role: "MANAGER",
      },
    ],
  });

  return {
    organizationId: organization.id,
    branchId: branch.id,
    departmentId: department.id,
    userId: user.id,
    email,
  };
}

function principal(
  organizationId: string,
  userId: string,
  roles: TrustedPrincipal["roles"] = ["EMPLOYEE"],
): TrustedPrincipal {
  return {
    organizationId,
    userId,
    roles,
  };
}

async function captureApplicationError(
  operation: Promise<unknown>,
): Promise<Error> {
  try {
    await operation;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }

    throw error;
  }

  throw new Error("Expected the application operation to fail");
}

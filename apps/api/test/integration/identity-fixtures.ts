import type { DatabaseService } from "@vendorflow/database";
import { Argon2PasswordHasher } from "../../src/identity-access/infrastructure/authentication/services/argon2-password-hasher";

export interface TenantFixture {
  readonly organizationId: string;
  readonly branchId: string;
  readonly departmentId: string;
  readonly userId: string;
  readonly email: string;
  readonly password: string;
}

export interface CreateTenantOptions {
  readonly suffix: string;
  readonly organizationName?: string;
  /** `null` creates a User with no credential at all, which must never be able to log in. */
  readonly password?: string | null;
  readonly isActive?: boolean;
  readonly roles?: readonly (
    | "EMPLOYEE"
    | "MANAGER"
    | "BUYER"
    | "FINANCE"
    | "ADMIN"
  )[];
}

const hasher = new Argon2PasswordHasher();

/**
 * One Argon2id hash per distinct password, reused across fixtures. Hashing is deliberately
 * expensive; paying it once per suite keeps the tests about behaviour rather than about
 * key derivation throughput.
 */
const hashCache = new Map<string, Promise<string>>();

export function hashPassword(password: string): Promise<string> {
  const cached = hashCache.get(password);

  if (cached !== undefined) {
    return cached;
  }

  const hashing = hasher.hash(password);
  hashCache.set(password, hashing);

  return hashing;
}

export async function createTenant(
  database: DatabaseService,
  options: CreateTenantOptions,
): Promise<TenantFixture> {
  const email = `employee-${options.suffix.toLowerCase()}@example.com`;
  const password = options.password ?? "correct horse battery staple";

  const organization = await database.organization.create({
    data: {
      name: options.organizationName ?? `Organization ${options.suffix}`,
    },
  });
  const branch = await database.branch.create({
    data: { organizationId: organization.id, name: "Head Office" },
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
      name: `Employee ${options.suffix}`,
      email,
      isActive: options.isActive ?? true,
      passwordHash:
        options.password === null ? null : await hashPassword(password),
    },
  });

  await database.userRole.createMany({
    data: (options.roles ?? ["EMPLOYEE", "MANAGER"]).map((role) => ({
      organizationId: organization.id,
      userId: user.id,
      role,
    })),
  });

  return {
    organizationId: organization.id,
    branchId: branch.id,
    departmentId: department.id,
    userId: user.id,
    email,
    password,
  };
}

export interface UserFixture {
  readonly organizationId: string;
  readonly branchId: string;
  readonly departmentId: string;
  readonly userId: string;
  readonly email: string;
  readonly password: string;
}

export interface CreateUserOptions {
  readonly organizationId: string;
  readonly branchId: string;
  readonly departmentId: string;
  readonly suffix: string;
  readonly roles: readonly (
    | "EMPLOYEE"
    | "MANAGER"
    | "BUYER"
    | "FINANCE"
    | "ADMIN"
  )[];
  readonly password?: string;
  readonly isActive?: boolean;
}

/**
 * A second Department inside an existing tenant. AUTHZ-004 makes the Department the manager's
 * responsibility boundary, so proving that boundary needs at least two of them.
 */
export async function createDepartment(
  database: DatabaseService,
  tenant: Pick<TenantFixture, "organizationId" | "branchId">,
  name: string,
): Promise<string> {
  const department = await database.department.create({
    data: {
      organizationId: tenant.organizationId,
      branchId: tenant.branchId,
      name,
    },
    select: { id: true },
  });

  return department.id;
}

/**
 * Another person in an existing tenant, with an explicit role set and an explicit Department.
 * Roles are not defaulted here on purpose: every test that creates a user is making a
 * statement about what that user may do.
 */
export async function createUser(
  database: DatabaseService,
  options: CreateUserOptions,
): Promise<UserFixture> {
  const email = `user-${options.suffix.toLowerCase()}@example.com`;
  const password = options.password ?? "correct horse battery staple";
  const user = await database.user.create({
    data: {
      organizationId: options.organizationId,
      branchId: options.branchId,
      departmentId: options.departmentId,
      name: `User ${options.suffix}`,
      email,
      isActive: options.isActive ?? true,
      passwordHash: await hashPassword(password),
    },
    select: { id: true },
  });

  if (options.roles.length > 0) {
    await database.userRole.createMany({
      data: options.roles.map((role) => ({
        organizationId: options.organizationId,
        userId: user.id,
        role,
      })),
    });
  }

  return {
    organizationId: options.organizationId,
    branchId: options.branchId,
    departmentId: options.departmentId,
    userId: user.id,
    email,
    password,
  };
}

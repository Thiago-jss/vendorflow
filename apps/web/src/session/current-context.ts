/**
 * The shape of `GET /me/organization`, transcribed as the browser needs to read it.
 *
 * These values are **presentation data**. They decide which links a shell renders and how a
 * page labels itself; they decide nothing about what the API will allow. Every protected
 * operation asks the server and honours the answer.
 *
 * The endpoint returns no person name and no email address, which is why nothing here
 * pretends to have one.
 */
export const membershipRoles = [
  "EMPLOYEE",
  "MANAGER",
  "BUYER",
  "FINANCE",
  "ADMIN"
] as const;

export type MembershipRole = (typeof membershipRoles)[number];

export interface TenantUnit {
  readonly id: string;
  readonly name: string;
}

export interface CurrentOrganizationContext {
  readonly organization: TenantUnit;
  readonly membership: {
    readonly userId: string;
    readonly branch: TenantUnit;
    readonly department: TenantUnit;
    readonly roles: readonly MembershipRole[];
  };
}

const ROLE_LABELS: Readonly<Record<MembershipRole, string>> = {
  EMPLOYEE: "Colaborador",
  MANAGER: "Gestor",
  BUYER: "Comprador",
  FINANCE: "Financeiro",
  ADMIN: "Administrador"
};

export function roleLabel(role: MembershipRole): string {
  return ROLE_LABELS[role] ?? role;
}

export function hasRole(
  context: CurrentOrganizationContext,
  role: MembershipRole
): boolean {
  return context.membership.roles.includes(role);
}

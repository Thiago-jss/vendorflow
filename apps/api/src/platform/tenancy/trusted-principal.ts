export const principalRoles = [
  "EMPLOYEE",
  "MANAGER",
  "BUYER",
  "FINANCE",
  "ADMIN",
] as const;

export type PrincipalRole = (typeof principalRoles)[number];

/**
 * Identity and tenant claims already verified by authentication infrastructure.
 * Application code consumes this contract; it never constructs it from HTTP input.
 */
export interface TrustedPrincipal {
  readonly userId: string;
  readonly organizationId: string;
  readonly roles: readonly PrincipalRole[];
}

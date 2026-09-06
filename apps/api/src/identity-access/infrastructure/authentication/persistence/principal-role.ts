import {
  principalRoles,
  type PrincipalRole,
} from "../../../../platform/tenancy/trusted-principal";

/**
 * Persistence returns the PostgreSQL enum as a string. Narrowing it here, in one place,
 * means an enum value added to the database but not to the application contract fails
 * loudly instead of reaching authorization as an unrecognized role.
 */
export function toPrincipalRole(role: string): PrincipalRole {
  const principalRole = principalRoles.find((candidate) => candidate === role);

  if (principalRole === undefined) {
    throw new Error("Persistence returned an unsupported role");
  }

  return principalRole;
}

import { RequestTenantContext } from "./request-tenant-context";
import type { PrincipalRole, TrustedPrincipal } from "./trusted-principal";
import {
  bindTrustedPrincipal,
  MissingTrustedPrincipalError,
  readTrustedPrincipal,
} from "./trusted-principal-carrier";

describe("trusted request principal", () => {
  function principalWithRoles(
    roles: PrincipalRole[] = ["EMPLOYEE"],
  ): TrustedPrincipal {
    return {
      userId: "user-a",
      organizationId: "organization-a",
      roles,
    };
  }

  it("exposes an immutable request-local snapshot through the tenant context", () => {
    const request = {};
    const roles: PrincipalRole[] = ["EMPLOYEE"];
    const principal = principalWithRoles(roles);
    bindTrustedPrincipal(request, principal);
    roles.push("MANAGER");

    const resolved = new RequestTenantContext(request).getPrincipal();

    expect(resolved).toEqual({
      userId: "user-a",
      organizationId: "organization-a",
      roles: ["EMPLOYEE"],
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.roles)).toBe(true);
  });

  it("fails closed when authentication infrastructure has not bound a principal", () => {
    expect(() => new RequestTenantContext({}).getPrincipal()).toThrow(
      MissingTrustedPrincipalError,
    );
  });

  it("ignores client-shaped string properties", () => {
    const clientControlledRequest = { principal: principalWithRoles() };

    expect(() => readTrustedPrincipal(clientControlledRequest)).toThrow(
      MissingTrustedPrincipalError,
    );
  });

  it("prevents principal replacement within the same request", () => {
    const request = {};
    const principal = principalWithRoles();
    bindTrustedPrincipal(request, principal);

    expect(() =>
      bindTrustedPrincipal(request, {
        ...principal,
        organizationId: "organization-b",
      }),
    ).toThrow("already bound");
  });
});

import type {
  PrincipalRole,
  TrustedPrincipal,
} from "../../../platform/tenancy/trusted-principal";
import { PurchaseRequestActionNotAuthorizedError } from "../contracts/purchase-request.errors";
import {
  PURCHASE_REQUEST_CREATION_ROLE,
  assertMayCreatePurchaseRequest,
  mayCreatePurchaseRequest,
} from "./purchase-request-authorization";

describe("purchase request creation capability", () => {
  function principal(roles: readonly PrincipalRole[]): TrustedPrincipal {
    return {
      userId: "user-a",
      organizationId: "organization-a",
      roles,
    };
  }

  it("grants creation to a principal holding EMPLOYEE (FR-020)", () => {
    expect(PURCHASE_REQUEST_CREATION_ROLE).toBe("EMPLOYEE");
    expect(mayCreatePurchaseRequest(principal(["EMPLOYEE"]))).toBe(true);
    // Additional roles neither grant nor withdraw the capability.
    expect(
      mayCreatePurchaseRequest(principal(["MANAGER", "EMPLOYEE", "ADMIN"])),
    ).toBe(true);
  });

  it("refuses a principal that authenticated but holds no EMPLOYEE role", () => {
    for (const roles of [
      [],
      ["MANAGER"],
      ["BUYER"],
      ["FINANCE"],
      // AUTHZ-007: Administrator manages structure and identity; it is not a bypass.
      ["ADMIN"],
      ["MANAGER", "BUYER", "FINANCE", "ADMIN"],
    ] satisfies PrincipalRole[][]) {
      expect(mayCreatePurchaseRequest(principal(roles))).toBe(false);
      expect(() => assertMayCreatePurchaseRequest(principal(roles))).toThrow(
        PurchaseRequestActionNotAuthorizedError,
      );
    }
  });

  it("names the action and no resource, so a refusal confirms nothing exists", () => {
    try {
      assertMayCreatePurchaseRequest(principal(["BUYER"]));
      throw new Error("expected a refusal");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PurchaseRequestActionNotAuthorizedError);
      expect((error as Error).message).toBe(
        "This principal may not create a purchase request",
      );
    }
  });
});

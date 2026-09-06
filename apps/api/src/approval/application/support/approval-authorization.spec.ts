import type {
  PrincipalRole,
  TrustedPrincipal,
} from "../../../platform/tenancy/trusted-principal";
import {
  ApprovalActionNotAuthorizedError,
  SelfApprovalNotAllowedError,
} from "../contracts/approval.errors";
import {
  assertMayDecideApprovalStep,
  assertNotSelfApproval,
  mayDecideApprovalStep,
} from "./approval-authorization";

function principal(
  roles: readonly PrincipalRole[],
  userId = "user-a",
): TrustedPrincipal {
  return { userId, organizationId: "organization-a", roles };
}

describe("who may decide an approval step (AUTHZ-006)", () => {
  it("lets a MANAGER decide a Manager step", () => {
    expect(mayDecideApprovalStep(principal(["MANAGER"]), "MANAGER")).toBe(true);
    // Extra roles neither grant nor withdraw it.
    expect(
      mayDecideApprovalStep(principal(["EMPLOYEE", "MANAGER"]), "MANAGER"),
    ).toBe(true);
  });

  it("refuses every other role on a Manager step, ADMIN included (AUTHZ-007)", () => {
    for (const roles of [
      [],
      ["EMPLOYEE"],
      ["BUYER"],
      ["FINANCE"],
      ["ADMIN"],
      // The whole rest of the role set at once is still not a Manager.
      ["EMPLOYEE", "BUYER", "FINANCE", "ADMIN"],
    ] satisfies PrincipalRole[][]) {
      expect(mayDecideApprovalStep(principal(roles), "MANAGER")).toBe(false);
      expect(() =>
        assertMayDecideApprovalStep(principal(roles), "MANAGER"),
      ).toThrow(ApprovalActionNotAuthorizedError);
    }
  });

  it("assigns Purchasing to a BUYER and Finance to a FINANCE user (FR-034)", () => {
    expect(mayDecideApprovalStep(principal(["BUYER"]), "PURCHASING")).toBe(true);
    expect(mayDecideApprovalStep(principal(["MANAGER"]), "PURCHASING")).toBe(
      false,
    );
    expect(mayDecideApprovalStep(principal(["FINANCE"]), "FINANCE")).toBe(true);
    expect(mayDecideApprovalStep(principal(["BUYER"]), "FINANCE")).toBe(false);
  });

  it("names the action and no resource, so a refusal confirms nothing exists", () => {
    try {
      assertMayDecideApprovalStep(principal(["BUYER"]), "MANAGER");
      throw new Error("expected a refusal");
    } catch (error: unknown) {
      expect((error as Error).message).toBe(
        "This principal may not decide an approval step",
      );
    }
  });
});

describe("BR-005 self-approval", () => {
  it("refuses the requester, whatever roles they hold", () => {
    for (const roles of [
      ["MANAGER"],
      ["MANAGER", "ADMIN"],
      ["EMPLOYEE", "MANAGER", "BUYER", "FINANCE", "ADMIN"],
    ] satisfies PrincipalRole[][]) {
      expect(() =>
        assertNotSelfApproval(principal(roles, "user-a"), "user-a"),
      ).toThrow(SelfApprovalNotAllowedError);
    }
  });

  it("allows anyone else", () => {
    expect(() =>
      assertNotSelfApproval(principal(["MANAGER"], "user-a"), "user-b"),
    ).not.toThrow();
  });
});

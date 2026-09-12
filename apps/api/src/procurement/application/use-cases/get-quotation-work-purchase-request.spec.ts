import type {
  PrincipalRole,
  TrustedPrincipal,
} from "../../../platform/tenancy/trusted-principal";
import {
  PurchaseRequestActionNotAuthorizedError,
  PurchaseRequestNotFoundError,
} from "../contracts/purchase-request.errors";
import type {
  PurchaseRequestRepository,
  QuotationWorkPurchaseRequestCriteria,
  QuotationWorkPurchaseRequestRecord,
} from "../contracts/purchase-request.repository";
import { GetQuotationWorkPurchaseRequest } from "./get-quotation-work-purchase-request";

/**
 * The ordering claim only: a principal without BUYER is refused before the repository is asked
 * anything. Tenant scope and the state predicate are proven against PostgreSQL, not here.
 */
describe("GetQuotationWorkPurchaseRequest", () => {
  const purchaseRequestId = "5f0c7c52-9d6e-4a8b-9a51-2c1f3e4d5a6b";

  function principal(roles: readonly PrincipalRole[]): TrustedPrincipal {
    return { userId: "user-a", organizationId: "organization-a", roles };
  }

  function buildUseCase(result: QuotationWorkPurchaseRequestRecord | null) {
    const lookups: QuotationWorkPurchaseRequestCriteria[] = [];
    const repository: Pick<PurchaseRequestRepository, "findQuotationWorkRequest"> =
      {
        findQuotationWorkRequest: async (criteria) => {
          lookups.push(criteria);
          return result;
        },
      };

    return {
      useCase: new GetQuotationWorkPurchaseRequest(
        repository as PurchaseRequestRepository,
      ),
      lookups,
    };
  }

  it("refuses every principal without BUYER before any read, ADMIN included", async () => {
    for (const roles of [
      [],
      ["EMPLOYEE"],
      ["MANAGER"],
      ["FINANCE"],
      // AUTHZ-007: Administrator is not a bypass.
      ["ADMIN"],
      ["EMPLOYEE", "MANAGER", "FINANCE", "ADMIN"],
    ] satisfies PrincipalRole[][]) {
      const { useCase, lookups } = buildUseCase(null);

      await expect(
        useCase.execute(principal(roles), purchaseRequestId),
      ).rejects.toBeInstanceOf(PurchaseRequestActionNotAuthorizedError);
      expect(lookups).toEqual([]);
    }
  });

  it("scopes the read to the principal's organization and the quotable states", async () => {
    const record: QuotationWorkPurchaseRequestRecord = {
      id: purchaseRequestId,
      neededBy: new Date("2026-11-30T00:00:00.000Z"),
      items: [],
    };
    const { useCase, lookups } = buildUseCase(record);

    await expect(
      useCase.execute(principal(["BUYER"]), purchaseRequestId),
    ).resolves.toBe(record);
    expect(lookups).toEqual([
      {
        organizationId: "organization-a",
        purchaseRequestId,
        statuses: ["IN_QUOTATION"],
      },
    ]);
  });

  it("answers a request the predicate did not match as not found", async () => {
    const { useCase } = buildUseCase(null);

    await expect(
      useCase.execute(principal(["BUYER"]), purchaseRequestId),
    ).rejects.toBeInstanceOf(PurchaseRequestNotFoundError);
  });
});

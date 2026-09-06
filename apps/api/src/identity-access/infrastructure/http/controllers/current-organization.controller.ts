import { Controller, Get, Inject, NotFoundException } from "@nestjs/common";
import {
  TENANT_CONTEXT,
  type TenantContext,
} from "../../../../platform/tenancy/tenant-context";
import {
  CurrentOrganizationContextNotFoundError,
  GetCurrentOrganizationContext,
} from "../../../application/use-cases/get-current-organization-context";
import type { CurrentOrganizationContextRecord } from "../../../application/contracts/identity-access.repository";

/**
 * The first protected endpoint. It takes no identifier from the caller: the organization and
 * user come from the `TrustedPrincipal` the authentication guard bound from persisted
 * identity, which is why there is nothing here for a client to tamper with.
 */
@Controller("me")
export class CurrentOrganizationController {
  constructor(
    @Inject(TENANT_CONTEXT) private readonly tenantContext: TenantContext,
    private readonly getCurrentOrganizationContext: GetCurrentOrganizationContext,
  ) {}

  @Get("organization")
  async organization(): Promise<CurrentOrganizationContextRecord> {
    try {
      return await this.getCurrentOrganizationContext.execute(
        this.tenantContext.getPrincipal(),
      );
    } catch (error: unknown) {
      if (error instanceof CurrentOrganizationContextNotFoundError) {
        throw new NotFoundException();
      }

      throw error;
    }
  }
}

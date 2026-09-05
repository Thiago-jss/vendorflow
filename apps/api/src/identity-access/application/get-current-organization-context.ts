import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../platform/tenancy/trusted-principal";
import {
  IDENTITY_ACCESS_REPOSITORY,
  type CurrentOrganizationContextRecord,
  type IdentityAccessRepository,
} from "./identity-access.repository";

export class CurrentOrganizationContextNotFoundError extends Error {
  constructor() {
    super("Current organization context was not found");
    this.name = "CurrentOrganizationContextNotFoundError";
  }
}

@Injectable()
export class GetCurrentOrganizationContext {
  constructor(
    @Inject(IDENTITY_ACCESS_REPOSITORY)
    private readonly identityAccessRepository: IdentityAccessRepository,
  ) {}

  async execute(
    principal: TrustedPrincipal,
  ): Promise<CurrentOrganizationContextRecord> {
    const context =
      await this.identityAccessRepository.findCurrentOrganizationContext({
        organizationId: principal.organizationId,
        userId: principal.userId,
      });

    if (context === null) {
      throw new CurrentOrganizationContextNotFoundError();
    }

    return context;
  }
}

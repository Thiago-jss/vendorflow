import { Module } from "@nestjs/common";
import { DatabaseModule } from "@vendorflow/database";
import { GetCurrentOrganizationContext } from "./application/get-current-organization-context";
import { IDENTITY_ACCESS_REPOSITORY } from "./application/identity-access.repository";
import { PrismaIdentityAccessRepository } from "./infrastructure/prisma-identity-access.repository";

@Module({
  imports: [DatabaseModule],
  providers: [
    PrismaIdentityAccessRepository,
    {
      provide: IDENTITY_ACCESS_REPOSITORY,
      useExisting: PrismaIdentityAccessRepository,
    },
    GetCurrentOrganizationContext,
  ],
  exports: [GetCurrentOrganizationContext],
})
export class IdentityAccessModule {}

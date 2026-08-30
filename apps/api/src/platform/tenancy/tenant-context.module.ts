import { Module, Scope } from "@nestjs/common";
import { RequestTenantContext } from "./request-tenant-context";
import { TENANT_CONTEXT } from "./tenant-context";

@Module({
  providers: [
    {
      provide: TENANT_CONTEXT,
      scope: Scope.REQUEST,
      useClass: RequestTenantContext,
    },
  ],
  exports: [TENANT_CONTEXT],
})
export class TenantContextModule {}

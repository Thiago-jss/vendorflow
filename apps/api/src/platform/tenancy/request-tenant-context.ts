import { Inject, Injectable, Scope } from "@nestjs/common";
import { REQUEST } from "@nestjs/core";
import type { TenantContext } from "./tenant-context";
import type { TrustedPrincipal } from "./trusted-principal";
import { readTrustedPrincipal } from "./trusted-principal-carrier";

@Injectable({ scope: Scope.REQUEST })
export class RequestTenantContext implements TenantContext {
  constructor(@Inject(REQUEST) private readonly request: object) {}

  getPrincipal(): TrustedPrincipal {
    return readTrustedPrincipal(this.request);
  }
}

import type { TrustedPrincipal } from "./trusted-principal";

export const TENANT_CONTEXT = Symbol("TENANT_CONTEXT");

/** Request-local bridge from trusted authentication infrastructure to an application entry point. */
export interface TenantContext {
  getPrincipal(): TrustedPrincipal;
}

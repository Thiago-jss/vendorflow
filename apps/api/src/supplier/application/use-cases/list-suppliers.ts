import { Inject, Injectable } from "@nestjs/common";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import {
  SUPPLIER_REPOSITORY,
  type SupplierListCursor,
  type SupplierPage,
  type SupplierRepository,
} from "../contracts/supplier.repository";
import { assertMayMaintainSuppliers } from "../support/supplier-authorization";

/** NFR-004. Bounded here so no caller can ask for an unbounded collection. */
export const DEFAULT_SUPPLIER_PAGE_SIZE = 20;
export const MAXIMUM_SUPPLIER_PAGE_SIZE = 100;

export interface ListSuppliersRequest {
  readonly limit?: number;
  readonly isActive: boolean | null;
  readonly after: SupplierListCursor | null;
}

/**
 * FR-010. The organization's supplier registry, newest first, keyset-paginated.
 *
 * Buyer and Administrator both act at organization scope here (AUTHZ-004), so there is no
 * narrower boundary to apply — but the tenant predicate is still what bounds the query, and
 * the cursor is compared against an already tenant-scoped predicate so a forged one can only
 * move the caller around inside their own rows.
 */
@Injectable()
export class ListSuppliers {
  constructor(
    @Inject(SUPPLIER_REPOSITORY)
    private readonly suppliers: SupplierRepository,
  ) {}

  execute(
    principal: TrustedPrincipal,
    request: ListSuppliersRequest,
  ): Promise<SupplierPage> {
    assertMayMaintainSuppliers(principal, "read");

    return this.suppliers.list({
      organizationId: principal.organizationId,
      isActive: request.isActive,
      limit: request.limit ?? DEFAULT_SUPPLIER_PAGE_SIZE,
      after: request.after,
    });
  }
}

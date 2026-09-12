import type { BrowserSession } from "@/session/browser-session";
import type {
  Supplier,
  SupplierActiveFilter,
  SupplierPage,
  SupplierRegistrationInput
} from "./contracts";

/**
 * The three endpoints this slice consumes, spelled once.
 *
 * The organization is derived from the access token server-side (MT-003), so nothing here
 * builds, sends or selects a tenant identifier. `GET /suppliers/:supplierId` is deliberately
 * not wrapped: the list response already carries everything this slice renders.
 */
const RESOURCE = "/suppliers";

function activeQueryValue(filter: SupplierActiveFilter): string | undefined {
  switch (filter) {
    case "active":
      return "true";
    case "inactive":
      return "false";
    case "all":
      return undefined;
  }
}

/** NFR-004. Keyset pagination, forward only, by the cursor a previous page returned. */
export function listSuppliers(
  session: BrowserSession,
  options: {
    readonly cursor?: string | null;
    readonly limit?: number;
    readonly activeFilter?: SupplierActiveFilter;
  } = {}
): Promise<SupplierPage> {
  const query = new URLSearchParams();

  if (options.limit !== undefined) {
    query.set("limit", String(options.limit));
  }

  // Taken verbatim from a previous response. The browser never builds or interprets one.
  if (options.cursor !== undefined && options.cursor !== null) {
    query.set("cursor", options.cursor);
  }

  const activeValue = activeQueryValue(options.activeFilter ?? "all");

  if (activeValue !== undefined) {
    query.set("isActive", activeValue);
  }

  const suffix = query.size === 0 ? "" : `?${query.toString()}`;

  return session.request<SupplierPage>({ path: `${RESOURCE}${suffix}` });
}

/**
 * FR-010/FR-013. The body is rebuilt field by field so only the six declared fields can ever
 * travel, whatever extra properties a caller's draft object might carry.
 */
export function registerSupplier(
  session: BrowserSession,
  input: SupplierRegistrationInput
): Promise<Supplier> {
  return session.request<Supplier>({
    path: RESOURCE,
    method: "POST",
    body: {
      legalName: input.legalName,
      tradeName: input.tradeName,
      taxIdentifierType: input.taxIdentifierType,
      taxIdentifier: input.taxIdentifier,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone
    }
  });
}

/**
 * FR-012. No request body and no idempotency key: REL-004 does not name this operation, and
 * the conditional write is naturally at-most-once server-side. The browser never retries it
 * on its own.
 */
export function deactivateSupplier(
  session: BrowserSession,
  supplierId: string
): Promise<Supplier> {
  return session.request<Supplier>({
    path: `${RESOURCE}/${supplierId}/deactivate`,
    method: "POST"
  });
}

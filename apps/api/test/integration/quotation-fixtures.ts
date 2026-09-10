import { DatabaseService, Prisma } from "@vendorflow/database";
import type { TenantFixture } from "./identity-fixtures";

/**
 * Rows built straight through Prisma rather than through the application.
 *
 * That is deliberate for the persistence suites: the point of those tests is what PostgreSQL
 * refuses *whatever wrote it*, so the fixtures must be able to attempt things the application
 * would never attempt. The HTTP suites drive the real routes instead.
 */
export interface PurchaseRequestFixture {
  readonly purchaseRequestId: string;
  readonly itemIds: readonly string[];
}

export interface SupplierFixtureOptions {
  readonly suffix: string;
  readonly isActive?: boolean;
  readonly taxIdentifierType?: "CNPJ" | "OTHER";
  readonly taxIdentifier?: string;
  readonly taxIdentifierNormalized?: string;
}

export async function createSupplier(
  database: DatabaseService,
  tenant: Pick<TenantFixture, "organizationId">,
  options: SupplierFixtureOptions,
): Promise<string> {
  const isActive = options.isActive ?? true;
  const supplier = await database.supplier.create({
    data: {
      organizationId: tenant.organizationId,
      legalName: `Supplier ${options.suffix} Ltda`,
      tradeName: `Supplier ${options.suffix}`,
      taxIdentifierType: options.taxIdentifierType ?? "OTHER",
      taxIdentifier: options.taxIdentifier ?? `VF-${options.suffix}`,
      taxIdentifierNormalized:
        options.taxIdentifierNormalized ??
        `VF${options.suffix.toUpperCase().replace(/[^0-9A-Z]/g, "")}`,
      contactEmail: `supplier-${options.suffix.toLowerCase()}@example.com`,
      contactPhone: "+55 11 4002-8922",
      isActive,
      deactivatedAt: isActive ? null : new Date(),
    },
    select: { id: true },
  });

  return supplier.id;
}

export interface PurchaseRequestFixtureOptions {
  readonly status?:
    | "DRAFT"
    | "SUBMITTED"
    | "IN_QUOTATION"
    | "IN_FINAL_APPROVAL"
    | "APPROVED"
    | "ORDERED"
    | "REJECTED"
    | "CANCELLED";
  /** One entry per line, as an integer count of thousandths (BR-031's exact quantity). */
  readonly quantitiesScaled?: readonly bigint[];
  readonly estimatedUnitPriceCents?: bigint;
}

export async function createPurchaseRequest(
  database: DatabaseService,
  tenant: TenantFixture,
  options: PurchaseRequestFixtureOptions = {},
): Promise<PurchaseRequestFixture> {
  const quantities = options.quantitiesScaled ?? [1_000n, 2_000n];
  const unitPriceCents = options.estimatedUnitPriceCents ?? 100_000n;
  const status = options.status ?? "IN_QUOTATION";
  const request = await database.purchaseRequest.create({
    data: {
      organizationId: tenant.organizationId,
      requesterId: tenant.userId,
      departmentId: tenant.departmentId,
      status,
      justification: "Replacement laptops for the onboarding cohort",
      neededBy: new Date("2026-11-30T00:00:00.000Z"),
      estimatedTotalCents: quantities.reduce(
        (total, quantity) => total + (quantity * unitPriceCents) / 1_000n,
        0n,
      ),
      submittedAt: status === "DRAFT" ? null : new Date(),
      cancelledAt: status === "CANCELLED" ? new Date() : null,
      items: {
        create: quantities.map((quantity, index) => ({
          position: index + 1,
          description: `Line ${index + 1}`,
          unitOfMeasure: "UN",
          quantity: new Prisma.Decimal((Number(quantity) / 1000).toFixed(3)),
          estimatedUnitPriceCents: unitPriceCents,
        })),
      },
    },
    select: { id: true, items: { orderBy: { position: "asc" }, select: { id: true } } },
  });

  return {
    purchaseRequestId: request.id,
    itemIds: request.items.map((item) => item.id),
  };
}

export interface QuoteFixtureOptions {
  readonly status?: "ACTIVE" | "WITHDRAWN" | "SELECTED";
  readonly unitPriceCents?: bigint;
  readonly freightCents?: bigint;
  readonly discountCents?: bigint;
  readonly validUntil?: Date;
  /** Overrides which request items the quote prices, for the BR-021 coverage tests. */
  readonly itemIds?: readonly string[];
  /** Overrides `item_count`, so a mismatch with the real line count can be attempted. */
  readonly declaredItemCount?: number;
}

/**
 * A quote whose lines mirror the request's items exactly, which is the only shape BR-021's
 * deferred trigger permits to commit. The options exist so a test can deliberately build one
 * that does not.
 */
export async function createSupplierQuote(
  database: DatabaseService,
  tenant: Pick<TenantFixture, "organizationId">,
  input: {
    readonly purchaseRequestId: string;
    readonly supplierId: string;
    readonly registeredById: string;
    readonly requestItemIds: readonly string[];
  },
  options: QuoteFixtureOptions = {},
): Promise<string> {
  const unitPriceCents = options.unitPriceCents ?? 90_000n;
  const pricedItemIds = options.itemIds ?? input.requestItemIds;
  const freightCents = options.freightCents ?? 0n;
  const discountCents = options.discountCents ?? 0n;
  const status = options.status ?? "ACTIVE";
  const quantities = await database.purchaseRequestItem.findMany({
    where: {
      organizationId: tenant.organizationId,
      id: { in: [...pricedItemIds] },
    },
    orderBy: { position: "asc" },
    select: { id: true, position: true, quantity: true },
  });
  const lines = quantities.map((item) => ({
    id: item.id,
    position: item.position,
    quantity: item.quantity,
    lineTotalCents:
      (BigInt(item.quantity.times(1000).toFixed(0)) * unitPriceCents) / 1_000n,
  }));
  const itemsTotalCents = lines.reduce(
    (total, line) => total + line.lineTotalCents,
    0n,
  );
  // One transaction: BR-021's coverage trigger is deferred to COMMIT, so a quote and its lines
  // have to arrive together. Writing them as two autocommitted statements would fail on the
  // first one, with an empty quote — which is exactly what the trigger is there to refuse.
  return database.$transaction(async (transaction) => {
    const quote = await transaction.supplierQuote.create({
      data: {
        organizationId: tenant.organizationId,
        purchaseRequestId: input.purchaseRequestId,
        supplierId: input.supplierId,
        registeredById: input.registeredById,
        status,
        freightCents,
        discountCents,
        itemsTotalCents,
        totalCents: itemsTotalCents + freightCents - discountCents,
        itemCount: options.declaredItemCount ?? pricedItemIds.length,
        validUntil: options.validUntil ?? new Date("2026-12-31T00:00:00.000Z"),
        deliveryLeadTimeDays: 15,
        selectionRationale:
          status === "SELECTED" ? "Lowest total of the offers received" : null,
        selectedById: status === "SELECTED" ? input.registeredById : null,
        selectedAt: status === "SELECTED" ? new Date() : null,
        withdrawnAt: status === "WITHDRAWN" ? new Date() : null,
      },
      select: { id: true },
    });

    await transaction.supplierQuoteItem.createMany({
      data: lines.map((line, index) => ({
        organizationId: tenant.organizationId,
        supplierQuoteId: quote.id,
        purchaseRequestId: input.purchaseRequestId,
        purchaseRequestItemId: line.id,
        position: index + 1,
        quantity: line.quantity,
        unitPriceCents,
        lineTotalCents: line.lineTotalCents,
      })),
    });

    return quote.id;
  });
}

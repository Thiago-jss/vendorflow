import { randomUUID } from "node:crypto";
import { DatabaseService } from "@vendorflow/database";
import {
  ApiIntegrationTestHarness,
  idempotencyHeaders,
  type HttpTestResponse,
} from "./api-test-harness";
import {
  createTenant,
  createUser,
  type TenantFixture,
  type UserFixture,
} from "./identity-fixtures";
import { PostgreSqlIntegrationTestHarness } from "./postgresql-test-harness";

/** A real CNPJ, punctuated, and the 14 digits it normalizes to. */
const CNPJ = "11.222.333/0001-81";
const CNPJ_DIGITS = "11222333000181";

/**
 * BR-001 tiers, expressed as amounts a client can actually send. One item, quantity 1, so the
 * total *is* the tier boundary and the ladder under test is the only variable.
 */
const TIER_ONE_CENTS = "100000";
const TIER_THREE_CENTS = "500001";

interface QuoteBody {
  readonly id: string;
  readonly status: string;
  readonly supplierId: string;
  readonly totalCents: string;
  readonly itemsTotalCents: string;
  readonly itemCount: number;
  readonly selectionRationale: string | null;
  readonly items: readonly {
    readonly purchaseRequestItemId: string;
    readonly quantity: string;
    readonly unitPriceCents: string;
    readonly lineTotalCents: string;
  }[];
}

interface OrderBody {
  readonly id: string;
  readonly number: string;
  readonly status: string;
  readonly supplierId: string;
  readonly supplierLegalName: string;
  readonly supplierTaxIdentifier: string;
  readonly totalCents: string;
  readonly cancellationReason: string | null;
  readonly items: readonly {
    readonly description: string;
    readonly quantity: string;
    readonly unitPriceCents: string;
    readonly lineTotalCents: string;
  }[];
}

interface RequestBody {
  readonly id: string;
  readonly status: string;
  readonly items: readonly { readonly id: string }[];
  readonly approval: {
    readonly state: string;
    readonly pendingStep: { readonly role: string } | null;
    readonly steps: readonly {
      readonly role: string;
      readonly state: string;
      readonly evaluatedAmountCents: string;
    }[];
  } | null;
  readonly selectedQuote: { readonly supplierQuoteId: string } | null;
  readonly purchaseOrder: { readonly number: string } | null;
}

/**
 * FR-010 – FR-054 driven through the real HTTP pipeline: the same modules, guards, pipes,
 * filter and validation the production bootstrap assembles, over a real PostgreSQL.
 *
 * Security behaviour asserted against a hand-built stub would only prove the stub, so every
 * authorization, tenancy and idempotency claim here goes through a real access token.
 */
describe("supplier, quotation and ordering HTTP surface (PostgreSQL)", () => {
  let postgres: PostgreSqlIntegrationTestHarness;
  let api: ApiIntegrationTestHarness;
  let database: DatabaseService;

  let requester: TenantFixture;
  let manager: UserFixture;
  let buyer: UserFixture;
  let finance: UserFixture;
  let administrator: UserFixture;
  let plainEmployee: UserFixture;
  /** Organization B: a perfectly good buyer, of the wrong tenant. */
  let foreignBuyer: TenantFixture;

  let requesterToken: string;
  let managerToken: string;
  let buyerToken: string;
  let financeToken: string;
  let administratorToken: string;
  let plainEmployeeToken: string;
  let foreignBuyerToken: string;

  beforeAll(async () => {
    postgres = await PostgreSqlIntegrationTestHarness.start();
    database = postgres.database;
    api = await ApiIntegrationTestHarness.start();
  }, 180_000);

  beforeEach(async () => {
    await postgres.clean();

    requester = await createTenant(database, {
      suffix: "A",
      roles: ["EMPLOYEE"],
    });
    const inOperations = {
      organizationId: requester.organizationId,
      branchId: requester.branchId,
      departmentId: requester.departmentId,
    };

    manager = await createUser(database, {
      ...inOperations,
      suffix: "Manager",
      roles: ["MANAGER"],
    });
    buyer = await createUser(database, {
      ...inOperations,
      suffix: "Buyer",
      roles: ["BUYER"],
    });
    finance = await createUser(database, {
      ...inOperations,
      suffix: "Finance",
      roles: ["FINANCE"],
    });
    administrator = await createUser(database, {
      ...inOperations,
      suffix: "Admin",
      roles: ["ADMIN"],
    });
    plainEmployee = await createUser(database, {
      ...inOperations,
      suffix: "Employee",
      roles: ["EMPLOYEE"],
    });
    foreignBuyer = await createTenant(database, {
      suffix: "B",
      roles: ["EMPLOYEE", "BUYER", "ADMIN"],
    });

    requesterToken = await login(requester);
    managerToken = await login(manager);
    buyerToken = await login(buyer);
    financeToken = await login(finance);
    administratorToken = await login(administrator);
    plainEmployeeToken = await login(plainEmployee);
    foreignBuyerToken = await login(foreignBuyer);
  }, 120_000);

  afterAll(async () => {
    if (api !== undefined) {
      await api.stop();
    }

    if (postgres !== undefined) {
      await postgres.stop();
    }
  });

  async function login(account: {
    readonly email: string;
    readonly password: string;
  }): Promise<string> {
    const response = await api.post("/auth/login", {
      body: { email: account.email, password: account.password },
    });

    return (response.body as { readonly accessToken: string }).accessToken;
  }

  function supplierBody(overrides: Record<string, unknown> = {}) {
    return {
      legalName: "Papelaria Central Ltda",
      tradeName: "Papelaria Central",
      taxIdentifierType: "CNPJ",
      taxIdentifier: CNPJ,
      contactEmail: "contato@example.com",
      contactPhone: "+55 11 4002-8922",
      ...overrides,
    };
  }

  async function registerSupplier(
    accessToken = buyerToken,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await api.post("/suppliers", {
      accessToken,
      body: supplierBody(overrides),
    });
    expect(response.status).toBe(201);

    return (response.body as { readonly id: string }).id;
  }

  /** A request in IN_QUOTATION: created, submitted and approved by its Manager. */
  async function requestInQuotation(
    estimatedUnitPriceCents = TIER_ONE_CENTS,
  ): Promise<RequestBody> {
    const created = await api.post("/purchase-requests", {
      accessToken: requesterToken,
      body: {
        justification: "Replacement laptops for the onboarding cohort",
        neededBy: "2026-11-30",
        items: [
          {
            description: "Laptop, 16 GB RAM",
            unitOfMeasure: "UN",
            quantity: "1",
            estimatedUnitPriceCents,
          },
        ],
      },
    });
    expect(created.status).toBe(201);

    const { id } = created.body as { readonly id: string };
    const submitted = await api.post(`/purchase-requests/${id}/submit`, {
      accessToken: requesterToken,
      headers: idempotencyHeaders(),
    });
    expect(submitted.status).toBe(200);

    const approved = await api.post(
      `/purchase-requests/${id}/approval-decision`,
      {
        accessToken: managerToken,
        headers: idempotencyHeaders(),
        body: { decision: "APPROVED" },
      },
    );
    expect(approved.status).toBe(200);

    return approved.body as RequestBody;
  }

  function quoteBody(
    supplierId: string,
    request: RequestBody,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      supplierId,
      freightCents: "12500",
      discountCents: "2500",
      validUntil: "2026-12-31",
      deliveryLeadTimeDays: 15,
      lines: request.items.map((item) => ({
        purchaseRequestItemId: item.id,
        unitPriceCents: "90000",
      })),
      ...overrides,
    };
  }

  async function registerQuote(
    request: RequestBody,
    supplierId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<QuoteBody> {
    const response = await api.post(
      `/purchase-requests/${request.id}/quotes`,
      { accessToken: buyerToken, body: quoteBody(supplierId, request, overrides) },
    );
    expect(response.status).toBe(201);

    return response.body as QuoteBody;
  }

  function selectQuote(
    request: RequestBody,
    quote: QuoteBody,
    options: {
      readonly accessToken?: string;
      readonly key?: string;
      readonly rationale?: string;
    } = {},
  ): Promise<HttpTestResponse> {
    return api.post(
      `/purchase-requests/${request.id}/quotes/${quote.id}/select`,
      {
        accessToken: options.accessToken ?? buyerToken,
        headers: idempotencyHeaders(options.key),
        body: {
          selectionRationale:
            options.rationale ?? "Lowest total with the shortest lead time",
        },
      },
    );
  }

  function issueOrder(
    request: RequestBody,
    options: { readonly accessToken?: string; readonly key?: string } = {},
  ): Promise<HttpTestResponse> {
    return api.post("/purchase-orders", {
      accessToken: options.accessToken ?? buyerToken,
      headers: idempotencyHeaders(options.key),
      body: { purchaseRequestId: request.id },
    });
  }

  function auditEventTypes(aggregateId: string): Promise<string[]> {
    return database.auditEvent
      .findMany({
        where: { aggregateId },
        orderBy: { sequence: "asc" },
        select: { eventType: true },
      })
      .then((events) => events.map((event) => event.eventType));
  }

  describe("authentication is default-deny on every new route", () => {
    it("refuses each of them without an access token", async () => {
      const id = randomUUID();

      for (const response of await Promise.all([
        api.post("/suppliers", { body: supplierBody() }),
        api.get("/suppliers"),
        api.get(`/suppliers/${id}`),
        api.post(`/suppliers/${id}/deactivate`),
        api.get("/purchase-requests/awaiting-quotation"),
        api.get(`/purchase-requests/${id}/quotes`),
        api.post(`/purchase-requests/${id}/quotes`, { body: {} }),
        api.post(`/purchase-requests/${id}/quotes/${id}/withdraw`),
        api.post(`/purchase-requests/${id}/quotes/${id}/select`, { body: {} }),
        api.post("/purchase-orders", { body: { purchaseRequestId: id } }),
        api.get("/purchase-orders"),
        api.get(`/purchase-orders/${id}`),
        api.post(`/purchase-orders/${id}/cancel`, { body: { reason: "x" } }),
      ])) {
        expect(response.status).toBe(401);
      }
    });
  });

  describe("FR-010 – FR-013 the supplier registry", () => {
    it("registers a supplier, normalizing and validating its CNPJ", async () => {
      const response = await api.post("/suppliers", {
        accessToken: buyerToken,
        body: supplierBody(),
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        legalName: "Papelaria Central Ltda",
        // As typed: a person has to recognize their own data.
        taxIdentifier: CNPJ,
        taxIdentifierType: "CNPJ",
        isActive: true,
        deactivatedAt: null,
      });
      // The comparison form is internal and is deliberately not published.
      expect(response.body).not.toHaveProperty("taxIdentifierNormalized");

      const stored = await database.supplier.findFirstOrThrow({
        select: { taxIdentifierNormalized: true },
      });
      expect(stored.taxIdentifierNormalized).toBe(CNPJ_DIGITS);
    });

    it("refuses an invalid CNPJ with 422, naming the rule and not the value", async () => {
      const response = await api.post("/suppliers", {
        accessToken: buyerToken,
        body: supplierBody({ taxIdentifier: "11.222.333/0001-82" }),
      });

      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).not.toContain("11.222.333/0001-82");
      await expect(database.supplier.count()).resolves.toBe(0);
    });

    it("accepts an unvalidated OTHER identifier and says so through the type", async () => {
      const response = await api.post("/suppliers", {
        accessToken: buyerToken,
        body: supplierBody({
          taxIdentifierType: "OTHER",
          taxIdentifier: "vat-gb 123.456",
        }),
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        taxIdentifierType: "OTHER",
        taxIdentifier: "vat-gb 123.456",
      });
      await expect(
        database.supplier.findFirstOrThrow({
          select: { taxIdentifierNormalized: true },
        }),
      ).resolves.toEqual({ taxIdentifierNormalized: "VATGB123456" });
    });

    it("refuses a duplicate identifier in the tenant with 409 (FR-013)", async () => {
      await registerSupplier();

      const duplicate = await api.post("/suppliers", {
        accessToken: buyerToken,
        // The other spelling of the same identifier. Uniqueness is on the normalized form.
        body: supplierBody({ taxIdentifier: CNPJ_DIGITS }),
      });

      expect(duplicate.status).toBe(409);
      await expect(database.supplier.count()).resolves.toBe(1);
    });

    it("lets an Administrator maintain the registry (FR-010)", async () => {
      const supplierId = await registerSupplier(administratorToken);
      const deactivated = await api.post(
        `/suppliers/${supplierId}/deactivate`,
        { accessToken: administratorToken },
      );

      expect(deactivated.status).toBe(200);
      expect(deactivated.body).toMatchObject({
        isActive: false,
        deactivatedAt: expect.any(String),
      });
    });

    it("refuses every other role, ADMIN's approval authority notwithstanding", async () => {
      for (const token of [requesterToken, managerToken, financeToken, plainEmployeeToken]) {
        const created = await api.post("/suppliers", {
          accessToken: token,
          body: supplierBody(),
        });
        const listed = await api.get("/suppliers", { accessToken: token });

        expect(created.status).toBe(403);
        expect(listed.status).toBe(403);
        expect(created.body).toEqual({
          statusCode: 403,
          message: "Not allowed to perform this action",
        });
      }

      await expect(database.supplier.count()).resolves.toBe(0);
    });

    it("refuses a second deactivation with 409 rather than a silent success", async () => {
      const supplierId = await registerSupplier();

      expect(
        (await api.post(`/suppliers/${supplierId}/deactivate`, {
          accessToken: buyerToken,
        })).status,
      ).toBe(200);
      expect(
        (await api.post(`/suppliers/${supplierId}/deactivate`, {
          accessToken: buyerToken,
        })).status,
      ).toBe(409);
    });

    it("audits creation and deactivation without any of the supplier's own data", async () => {
      const supplierId = await registerSupplier();
      await api.post(`/suppliers/${supplierId}/deactivate`, {
        accessToken: buyerToken,
      });

      const events = await database.auditEvent.findMany({
        where: { aggregateId: supplierId },
        orderBy: { sequence: "asc" },
      });

      expect(events.map((event) => event.eventType)).toEqual([
        "SUPPLIER_CREATED",
        "SUPPLIER_DEACTIVATED",
      ]);
      expect(events.every((event) => event.aggregateType === "SUPPLIER")).toBe(
        true,
      );

      const payloads = JSON.stringify(events.map((event) => event.payload));
      for (const secret of [
        CNPJ,
        CNPJ_DIGITS,
        "Papelaria Central",
        "contato@example.com",
        "4002-8922",
      ]) {
        expect(payloads).not.toContain(secret);
      }
    });
  });

  describe("the whole flow, end to end", () => {
    it("runs request to order through the tier that needs no post-quotation approval", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation(TIER_ONE_CENTS);
      const quote = await registerQuote(request, supplierId);

      // FR-042: sum of already-rounded line totals, plus freight, minus discount. One line of
      // 1 x 90000, freight 12500, discount 2500.
      expect(quote.itemsTotalCents).toBe("90000");
      expect(quote.totalCents).toBe("100000");
      expect(quote.itemCount).toBe(1);

      const selected = await selectQuote(request, quote);
      expect(selected.status).toBe(200);
      expect(selected.body).toMatchObject({
        // BR-003: the selected total lands in the first tier, so nothing remains to approve.
        purchaseRequestStatus: "APPROVED",
        actionableStepRole: null,
      });

      const issued = await issueOrder(request);
      expect(issued.status).toBe(201);

      const order = issued.body as OrderBody;
      expect(order).toMatchObject({
        number: "PO-000001",
        status: "ISSUED",
        supplierId,
        // FR-051's snapshot, taken at issuance.
        supplierLegalName: "Papelaria Central Ltda",
        supplierTaxIdentifier: CNPJ,
        totalCents: "100000",
      });
      expect(order.items).toEqual([
        expect.objectContaining({
          description: "Laptop, 16 GB RAM",
          quantity: "1.000",
          unitPriceCents: "90000",
          lineTotalCents: "90000",
        }),
      ]);

      await expect(
        database.purchaseRequest.findUniqueOrThrow({
          where: { id: request.id },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: "ORDERED" });

      // FR-054: cancellation is terminal and leaves the ORDERED request alone (BR-013).
      const cancelled = await api.post(`/purchase-orders/${order.id}/cancel`, {
        accessToken: administratorToken,
        body: { reason: "Supplier withdrew after a plant fire" },
      });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({
        status: "CANCELLED",
        cancellationReason: "Supplier withdrew after a plant fire",
      });
      await expect(
        database.purchaseRequest.findUniqueOrThrow({
          where: { id: request.id },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: "ORDERED" });
    });

    it("runs the tier that needs Purchasing and Finance after selection (BR-003)", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation(TIER_THREE_CENTS);
      const quote = await registerQuote(request, supplierId, {
        freightCents: "0",
        discountCents: "0",
        lines: request.items.map((item) => ({
          purchaseRequestItemId: item.id,
          unitPriceCents: TIER_THREE_CENTS,
        })),
      });

      const selected = await selectQuote(request, quote);
      expect(selected.status).toBe(200);
      expect(selected.body).toMatchObject({
        purchaseRequestStatus: "IN_FINAL_APPROVAL",
        actionableStepRole: "PURCHASING",
      });

      // FR-050: an order cannot be issued while the ladder is still standing.
      expect((await issueOrder(request)).status).toBe(404);

      // The Buyer decides the Purchasing rung, and Finance becomes actionable (FR-035).
      const purchasing = await api.post(
        `/purchase-requests/${request.id}/approval-decision`,
        {
          accessToken: buyerToken,
          headers: idempotencyHeaders(),
          body: { decision: "APPROVED" },
        },
      );
      expect(purchasing.status).toBe(200);
      expect((purchasing.body as RequestBody).status).toBe("IN_FINAL_APPROVAL");
      expect(
        (purchasing.body as RequestBody).approval?.pendingStep?.role,
      ).toBe("FINANCE");

      const financeDecision = await api.post(
        `/purchase-requests/${request.id}/approval-decision`,
        {
          accessToken: financeToken,
          headers: idempotencyHeaders(),
          body: { decision: "APPROVED" },
        },
      );
      expect(financeDecision.status).toBe(200);

      const finalBody = financeDecision.body as RequestBody;
      expect(finalBody.status).toBe("APPROVED");
      expect(finalBody.approval?.state).toBe("COMPLETED");
      // BR-002: the Manager kept the estimate; the post-quotation rungs carry the quote total.
      expect(
        finalBody.approval?.steps.map((step) => [
          step.role,
          step.state,
          step.evaluatedAmountCents,
        ]),
      ).toEqual([
        ["MANAGER", "APPROVED", TIER_THREE_CENTS],
        ["PURCHASING", "APPROVED", TIER_THREE_CENTS],
        ["FINANCE", "APPROVED", TIER_THREE_CENTS],
      ]);

      expect((await issueOrder(request)).status).toBe(201);
    });

    it("adds the selected quote and the order to the requester's own read (FR-026)", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation(TIER_ONE_CENTS);

      const beforeSelection = await api.get(`/purchase-requests/${request.id}`, {
        accessToken: requesterToken,
      });
      expect(beforeSelection.body).toMatchObject({
        selectedQuote: null,
        purchaseOrder: null,
      });

      const quote = await registerQuote(request, supplierId);
      await selectQuote(request, quote);
      await issueOrder(request);

      const afterOrder = await api.get(`/purchase-requests/${request.id}`, {
        accessToken: requesterToken,
      });
      const body = afterOrder.body as RequestBody;

      expect(body.selectedQuote).toMatchObject({
        supplierQuoteId: quote.id,
        totalCents: "100000",
      });
      expect(body.purchaseOrder).toMatchObject({
        number: "PO-000001",
        status: "ISSUED",
      });
      // The requester's own view never carries the buyer's rationale or the supplier's
      // fiscal identity: those belong to the quotation and ordering routes.
      expect(JSON.stringify(body.selectedQuote)).not.toContain("Lowest total");
      expect(JSON.stringify(body.purchaseOrder)).not.toContain(CNPJ);
    });

    it("records one audit event per consequential transition, in order (AUD-005)", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation(TIER_THREE_CENTS);
      const quote = await registerQuote(request, supplierId, {
        freightCents: "0",
        discountCents: "0",
        lines: request.items.map((item) => ({
          purchaseRequestItemId: item.id,
          unitPriceCents: TIER_ONE_CENTS,
        })),
      });
      await selectQuote(request, quote);

      expect(await auditEventTypes(request.id)).toEqual([
        "PURCHASE_REQUEST_SUBMITTED",
        "APPROVAL_STEP_APPROVED",
        "SUPPLIER_QUOTE_REGISTERED",
        "SUPPLIER_QUOTE_SELECTED",
        // The selected total dropped to tier one, so two rungs were voided: the ladder
        // genuinely changed, and BR-003's own fact is recorded.
        "APPROVAL_FLOW_REEVALUATED",
      ]);
    });

    it("commits exactly the outgoing intents FR-062 needs, and no others", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation(TIER_ONE_CENTS);
      const quote = await registerQuote(request, supplierId);
      await selectQuote(request, quote);
      const issued = await issueOrder(request);
      const order = issued.body as OrderBody;

      await api.post(`/purchase-orders/${order.id}/cancel`, {
        accessToken: buyerToken,
        body: { reason: "Supplier withdrew after a plant fire" },
      });

      const messages = await database.outboxMessage.findMany({
        orderBy: { createdAt: "asc" },
        select: { eventType: true, aggregateType: true, payload: true },
      });

      expect(messages.map((message) => message.eventType)).toEqual([
        "PURCHASE_REQUEST_SUBMITTED",
        "PURCHASE_REQUEST_APPROVAL_DECIDED",
        "PURCHASE_REQUEST_QUOTE_SELECTED",
        // No quote-registered, no supplier-created and — deliberately — no
        // purchase-order-cancelled: FR-062 names none of them and nothing consumes one.
        "PURCHASE_ORDER_ISSUED",
      ]);
      expect(
        messages.map((message) => message.aggregateType),
      ).toEqual([
        "PURCHASE_REQUEST",
        "PURCHASE_REQUEST",
        "PURCHASE_REQUEST",
        "PURCHASE_ORDER",
      ]);

      const payloads = JSON.stringify(messages.map((message) => message.payload));
      for (const secret of [
        CNPJ,
        CNPJ_DIGITS,
        "Papelaria Central",
        "contato@example.com",
        "Lowest total",
        "Supplier withdrew",
      ]) {
        expect(payloads).not.toContain(secret);
      }
    });
  });

  describe("BR-020 – BR-025 quotation rules over HTTP", () => {
    it("computes every total server-side and refuses a client-supplied one", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation();

      const withTotal = await api.post(
        `/purchase-requests/${request.id}/quotes`,
        {
          accessToken: buyerToken,
          body: {
            ...quoteBody(supplierId, request),
            totalCents: "1",
          },
        },
      );
      expect(withTotal.status).toBe(400);

      // The same for a quantity: BR-025 says a quote prices what was asked for.
      const withQuantity = await api.post(
        `/purchase-requests/${request.id}/quotes`,
        {
          accessToken: buyerToken,
          body: {
            ...quoteBody(supplierId, request),
            lines: request.items.map((item) => ({
              purchaseRequestItemId: item.id,
              unitPriceCents: "90000",
              quantity: "999",
            })),
          },
        },
      );
      expect(withQuantity.status).toBe(400);
      await expect(database.supplierQuote.count()).resolves.toBe(0);
    });

    it("refuses a malformed monetary string with 400", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation();

      for (const freightCents of ["12.50", "-100", "1e3", " 100", "abc"]) {
        const response = await api.post(
          `/purchase-requests/${request.id}/quotes`,
          {
            accessToken: buyerToken,
            body: quoteBody(supplierId, request, { freightCents }),
          },
        );

        expect(response.status).toBe(400);
      }
    });

    it("refuses a discount larger than the goods plus freight with 422", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation();

      const response = await api.post(
        `/purchase-requests/${request.id}/quotes`,
        {
          accessToken: buyerToken,
          body: quoteBody(supplierId, request, {
            freightCents: "0",
            discountCents: "9999999",
          }),
        },
      );

      expect(response.status).toBe(422);
    });

    it("refuses an incomplete line list with 422 (BR-021)", async () => {
      const supplierId = await registerSupplier();
      const twoLines = await api.post("/purchase-requests", {
        accessToken: requesterToken,
        body: {
          justification: "Replacement laptops for the onboarding cohort",
          neededBy: "2026-11-30",
          items: [
            {
              description: "Laptop",
              unitOfMeasure: "UN",
              quantity: "1",
              estimatedUnitPriceCents: "1000",
            },
            {
              description: "Docking station",
              unitOfMeasure: "UN",
              quantity: "2",
              estimatedUnitPriceCents: "1000",
            },
          ],
        },
      });
      const { id } = twoLines.body as { readonly id: string };
      await api.post(`/purchase-requests/${id}/submit`, {
        accessToken: requesterToken,
        headers: idempotencyHeaders(),
      });
      await api.post(`/purchase-requests/${id}/approval-decision`, {
        accessToken: managerToken,
        headers: idempotencyHeaders(),
        body: { decision: "APPROVED" },
      });

      const request = (
        await api.get(`/purchase-requests/${id}`, {
          accessToken: requesterToken,
        })
      ).body as RequestBody;

      const partial = await api.post(`/purchase-requests/${id}/quotes`, {
        accessToken: buyerToken,
        body: quoteBody(supplierId, request, {
          lines: [
            {
              purchaseRequestItemId: request.items[0]?.id,
              unitPriceCents: "90000",
            },
          ],
        }),
      });

      expect(partial.status).toBe(422);
      await expect(database.supplierQuote.count()).resolves.toBe(0);
    });

    it("refuses a line from another request as not belonging to this one", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation();
      const other = await requestInQuotation();

      const response = await api.post(
        `/purchase-requests/${request.id}/quotes`,
        {
          accessToken: buyerToken,
          body: quoteBody(supplierId, request, {
            lines: other.items.map((item) => ({
              purchaseRequestItemId: item.id,
              unitPriceCents: "90000",
            })),
          }),
        },
      );

      expect(response.status).toBe(422);
      // Names the rule, and nothing about the other request.
      expect(JSON.stringify(response.body)).not.toContain(other.id);
    });

    it("refuses a new quote against an inactive supplier with 409 (FR-012)", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation();
      await api.post(`/suppliers/${supplierId}/deactivate`, {
        accessToken: buyerToken,
      });

      const response = await api.post(
        `/purchase-requests/${request.id}/quotes`,
        { accessToken: buyerToken, body: quoteBody(supplierId, request) },
      );

      expect(response.status).toBe(409);
    });

    it("keeps a quote selectable after its supplier is deactivated", async () => {
      // FR-012 blocks *new* quotes. Withdrawing a live commercial offer because a record was
      // archived is a rule nobody asked for.
      const supplierId = await registerSupplier();
      const request = await requestInQuotation();
      const quote = await registerQuote(request, supplierId);

      await api.post(`/suppliers/${supplierId}/deactivate`, {
        accessToken: buyerToken,
      });

      expect((await selectQuote(request, quote)).status).toBe(200);
      expect((await issueOrder(request)).status).toBe(201);
    });

    it("refuses a second active quote from one supplier and accepts one after withdrawal", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation();
      const quote = await registerQuote(request, supplierId);

      const second = await api.post(
        `/purchase-requests/${request.id}/quotes`,
        { accessToken: buyerToken, body: quoteBody(supplierId, request) },
      );
      expect(second.status).toBe(409);

      const withdrawn = await api.post(
        `/purchase-requests/${request.id}/quotes/${quote.id}/withdraw`,
        { accessToken: buyerToken },
      );
      expect(withdrawn.status).toBe(200);
      expect((withdrawn.body as QuoteBody).status).toBe("WITHDRAWN");

      const replacement = await api.post(
        `/purchase-requests/${request.id}/quotes`,
        { accessToken: buyerToken, body: quoteBody(supplierId, request) },
      );
      expect(replacement.status).toBe(201);
    });

    it("lists quotes ordered by total, withdrawn ones included (FR-043, FR-046)", async () => {
      const request = await requestInQuotation();
      const expensive = await registerSupplier(buyerToken, {
        taxIdentifierType: "OTHER",
        taxIdentifier: "SUP-EXPENSIVE",
      });
      const cheap = await registerSupplier(buyerToken, {
        taxIdentifierType: "OTHER",
        taxIdentifier: "SUP-CHEAP",
      });
      const withdrawnSupplier = await registerSupplier(buyerToken, {
        taxIdentifierType: "OTHER",
        taxIdentifier: "SUP-WITHDRAWN",
      });

      await registerQuote(request, expensive, {
        freightCents: "0",
        discountCents: "0",
        lines: request.items.map((item) => ({
          purchaseRequestItemId: item.id,
          unitPriceCents: "300000",
        })),
      });
      await registerQuote(request, cheap, {
        freightCents: "0",
        discountCents: "0",
        lines: request.items.map((item) => ({
          purchaseRequestItemId: item.id,
          unitPriceCents: "100000",
        })),
      });
      const withdrawn = await registerQuote(request, withdrawnSupplier, {
        freightCents: "0",
        discountCents: "0",
        lines: request.items.map((item) => ({
          purchaseRequestItemId: item.id,
          unitPriceCents: "200000",
        })),
      });
      await api.post(
        `/purchase-requests/${request.id}/quotes/${withdrawn.id}/withdraw`,
        { accessToken: buyerToken },
      );

      const listed = await api.get(`/purchase-requests/${request.id}/quotes`, {
        accessToken: buyerToken,
      });
      const items = (listed.body as { readonly items: readonly QuoteBody[] })
        .items;

      expect(items.map((quote) => quote.totalCents)).toEqual([
        "100000",
        "200000",
        "300000",
      ]);
      expect(items.map((quote) => quote.status)).toEqual([
        "ACTIVE",
        "WITHDRAWN",
        "ACTIVE",
      ]);
    });

    it("keyset-paginates the comparison without skipping or repeating a tie (NFR-004)", async () => {
      const request = await requestInQuotation();
      // Two of the four quote the same amount. A cursor carrying only the total would either
      // skip the second of the pair or serve it on both pages; the quote identifier in the
      // key is what makes the boundary land cleanly inside the tie.
      const prices = ["100000", "200000", "200000", "300000"];
      const registered: QuoteBody[] = [];

      for (const [index, unitPriceCents] of prices.entries()) {
        const supplierId = await registerSupplier(buyerToken, {
          taxIdentifierType: "OTHER",
          taxIdentifier: `SUP-PAGE-${index}`,
        });
        registered.push(
          await registerQuote(request, supplierId, {
            freightCents: "0",
            discountCents: "0",
            lines: request.items.map((item) => ({
              purchaseRequestItemId: item.id,
              unitPriceCents,
            })),
          }),
        );
      }

      const seen: QuoteBody[] = [];
      let cursor: string | null = null;

      do {
        const query: string =
          cursor === null
            ? "?limit=1"
            : `?limit=1&cursor=${encodeURIComponent(cursor)}`;
        const page = await api.get(
          `/purchase-requests/${request.id}/quotes${query}`,
          { accessToken: buyerToken },
        );
        expect(page.status).toBe(200);

        const body = page.body as {
          readonly items: readonly QuoteBody[];
          readonly nextCursor: string | null;
        };
        expect(body.items).toHaveLength(1);
        seen.push(...body.items);
        cursor = body.nextCursor;
      } while (cursor !== null);

      // Every quote, exactly once, cheapest first — and the tied pair intact.
      expect(seen.map((quote) => quote.totalCents)).toEqual([
        "100000",
        "200000",
        "200000",
        "300000",
      ]);
      expect(new Set(seen.map((quote) => quote.id)).size).toBe(4);
      expect([...seen.map((quote) => quote.id)].sort()).toEqual(
        [...registered.map((quote) => quote.id)].sort(),
      );
    });

    it("returns the whole comparison and a null cursor when it fits one page", async () => {
      const request = await requestInQuotation();
      const supplierId = await registerSupplier(buyerToken, {
        taxIdentifierType: "OTHER",
        taxIdentifier: "SUP-SINGLE-PAGE",
      });
      await registerQuote(request, supplierId);

      const listed = await api.get(`/purchase-requests/${request.id}/quotes`, {
        accessToken: buyerToken,
      });
      const body = listed.body as {
        readonly items: readonly QuoteBody[];
        readonly nextCursor: string | null;
      };

      expect(body.items).toHaveLength(1);
      expect(body.nextCursor).toBeNull();
    });

    it("bounds the page size and refuses an unusable cursor (NFR-004)", async () => {
      const request = await requestInQuotation();

      for (const query of [
        "?limit=101",
        "?limit=0",
        "?all=true",
        "?cursor=not-a-cursor",
        // Decodes cleanly, but its identifier half is not a quote identifier. Refused as a
        // malformed cursor rather than handed to the driver.
        `?cursor=${Buffer.from("100000|nope", "utf8").toString("base64url")}`,
        // Padded base64. Node's decoder would tolerate it and hand back an otherwise usable
        // cursor; the route admits one spelling per cursor and refuses this one.
        `?cursor=${encodeURIComponent(`${Buffer.from("100000|nope", "utf8").toString("base64url")}=`)}`,
      ]) {
        const response = await api.get(
          `/purchase-requests/${request.id}/quotes${query}`,
          { accessToken: buyerToken },
        );

        expect(response.status).toBe(400);
      }
    });

    it("refuses selecting a withdrawn quote and withdrawing a selected one", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation();
      const quote = await registerQuote(request, supplierId);
      const second = await registerQuote(
        request,
        await registerSupplier(buyerToken, {
          taxIdentifierType: "OTHER",
          taxIdentifier: "SUP-SECOND",
        }),
      );

      await api.post(
        `/purchase-requests/${request.id}/quotes/${second.id}/withdraw`,
        { accessToken: buyerToken },
      );
      expect((await selectQuote(request, second)).status).toBe(409);

      expect((await selectQuote(request, quote)).status).toBe(200);
      const withdrawSelected = await api.post(
        `/purchase-requests/${request.id}/quotes/${quote.id}/withdraw`,
        { accessToken: buyerToken },
      );
      // The request has already left IN_QUOTATION, so the whole route is closed.
      expect(withdrawSelected.status).toBe(404);
    });

    it("refuses an expired quote with 409 (BR-023)", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation();
      const quote = await registerQuote(request, supplierId, {
        validUntil: "2026-12-31",
      });

      await database.supplierQuote.update({
        where: {
          organizationId_id: {
            organizationId: requester.organizationId,
            id: quote.id,
          },
        },
        data: { validUntil: new Date("2020-01-01T00:00:00.000Z") },
      });

      expect((await selectQuote(request, quote)).status).toBe(409);
    });

    it("refuses a rationale shorter than ten non-whitespace characters with 422", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation();
      const quote = await registerQuote(request, supplierId);

      const response = await selectQuote(request, quote, {
        rationale: "   ok    ",
      });

      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).not.toContain("ok");
    });
  });

  describe("the authorization matrix", () => {
    it("gives quotation to BUYER alone, ADMIN included in the refusal", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation();

      for (const token of [
        requesterToken,
        managerToken,
        financeToken,
        administratorToken,
        plainEmployeeToken,
      ]) {
        const registered = await api.post(
          `/purchase-requests/${request.id}/quotes`,
          { accessToken: token, body: quoteBody(supplierId, request) },
        );
        const listed = await api.get(
          `/purchase-requests/${request.id}/quotes`,
          { accessToken: token },
        );
        const queue = await api.get("/purchase-requests/awaiting-quotation", {
          accessToken: token,
        });

        for (const response of [registered, listed, queue]) {
          expect(response.status).toBe(403);
        }
      }

      await expect(database.supplierQuote.count()).resolves.toBe(0);
    });

    it("gives issuance to BUYER alone, and reading and cancelling to BUYER or ADMIN", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation();
      const quote = await registerQuote(request, supplierId);
      await selectQuote(request, quote);

      // FR-050 names a Buyer, and issuing commits the organization to a price.
      expect((await issueOrder(request, { accessToken: administratorToken })).status).toBe(403);
      expect((await issueOrder(request, { accessToken: financeToken })).status).toBe(403);

      const issued = await issueOrder(request);
      expect(issued.status).toBe(201);

      const order = issued.body as OrderBody;

      // FR-054 names both roles for reading and cancelling.
      expect(
        (await api.get(`/purchase-orders/${order.id}`, {
          accessToken: administratorToken,
        })).status,
      ).toBe(200);
      expect(
        (await api.get("/purchase-orders", { accessToken: buyerToken })).status,
      ).toBe(200);
      expect(
        (await api.get(`/purchase-orders/${order.id}`, {
          accessToken: managerToken,
        })).status,
      ).toBe(403);
      expect(
        (await api.post(`/purchase-orders/${order.id}/cancel`, {
          accessToken: financeToken,
          body: { reason: "Supplier withdrew after a plant fire" },
        })).status,
      ).toBe(403);
    });

    it("keeps BR-005 out of the quotation queue but inside the decision", async () => {
      // A Buyer who raised a request may still run its quotation — that is not a decision on it
      // — and may not decide its Purchasing rung.
      const buyingRequester = await createUser(database, {
        organizationId: requester.organizationId,
        branchId: requester.branchId,
        departmentId: requester.departmentId,
        suffix: "BuyingRequester",
        roles: ["EMPLOYEE", "BUYER"],
      });
      const token = await login(buyingRequester);
      const supplierId = await registerSupplier();

      const created = await api.post("/purchase-requests", {
        accessToken: token,
        body: {
          justification: "Replacement laptops for the onboarding cohort",
          neededBy: "2026-11-30",
          items: [
            {
              description: "Laptop",
              unitOfMeasure: "UN",
              quantity: "1",
              estimatedUnitPriceCents: TIER_THREE_CENTS,
            },
          ],
        },
      });
      const { id } = created.body as { readonly id: string };
      await api.post(`/purchase-requests/${id}/submit`, {
        accessToken: token,
        headers: idempotencyHeaders(),
      });
      await api.post(`/purchase-requests/${id}/approval-decision`, {
        accessToken: managerToken,
        headers: idempotencyHeaders(),
        body: { decision: "APPROVED" },
      });

      const request = (
        await api.get(`/purchase-requests/${id}`, { accessToken: token })
      ).body as RequestBody;

      const queue = await api.get("/purchase-requests/awaiting-quotation", {
        accessToken: token,
      });
      expect(queue.status).toBe(200);
      expect(
        (queue.body as { readonly items: readonly { readonly id: string }[] })
          .items.map((item) => item.id),
      ).toContain(id);

      const quote = await api.post(`/purchase-requests/${id}/quotes`, {
        accessToken: token,
        body: quoteBody(supplierId, request, {
          freightCents: "0",
          discountCents: "0",
          lines: request.items.map((item) => ({
            purchaseRequestItemId: item.id,
            unitPriceCents: TIER_THREE_CENTS,
          })),
        }),
      });
      expect(quote.status).toBe(201);

      const selected = await api.post(
        `/purchase-requests/${id}/quotes/${(quote.body as QuoteBody).id}/select`,
        {
          accessToken: token,
          headers: idempotencyHeaders(),
          body: { selectionRationale: "The only offer received in time" },
        },
      );
      expect(selected.status).toBe(200);

      // BR-005 reappears exactly where it belongs.
      const decision = await api.post(
        `/purchase-requests/${id}/approval-decision`,
        {
          accessToken: token,
          headers: idempotencyHeaders(),
          body: { decision: "APPROVED" },
        },
      );
      expect(decision.status).toBe(403);
    });
  });

  describe("MT-004 cross-tenant identifiers are indistinguishable from unknown ones", () => {
    it("answers object routes with a byte-for-byte identical 404", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation();
      const quote = await registerQuote(request, supplierId);
      await selectQuote(request, quote);
      const order = (await issueOrder(request)).body as OrderBody;

      // Organization B's buyer, holding BUYER and ADMIN, against organization A's identifiers
      // and against identifiers that exist nowhere. Every pair must be indistinguishable.
      const responses = await Promise.all([
        api.get(`/suppliers/${supplierId}`, { accessToken: foreignBuyerToken }),
        api.get(`/suppliers/${randomUUID()}`, {
          accessToken: foreignBuyerToken,
        }),
        api.post(`/suppliers/${supplierId}/deactivate`, {
          accessToken: foreignBuyerToken,
        }),
        api.post(`/suppliers/${randomUUID()}/deactivate`, {
          accessToken: foreignBuyerToken,
        }),
        api.get(`/purchase-requests/${request.id}/quotes`, {
          accessToken: foreignBuyerToken,
        }),
        api.get(`/purchase-requests/${randomUUID()}/quotes`, {
          accessToken: foreignBuyerToken,
        }),
        api.get(`/purchase-orders/${order.id}`, {
          accessToken: foreignBuyerToken,
        }),
        api.get(`/purchase-orders/${randomUUID()}`, {
          accessToken: foreignBuyerToken,
        }),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ statusCode: 404, message: "Not Found" });
      }
    });

    it("answers a quote identifier from another request exactly as an unknown one", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation();
      const other = await requestInQuotation();
      const quote = await registerQuote(request, supplierId);

      const foreignRequest = await api.post(
        `/purchase-requests/${other.id}/quotes/${quote.id}/withdraw`,
        { accessToken: buyerToken },
      );
      const unknown = await api.post(
        `/purchase-requests/${other.id}/quotes/${randomUUID()}/withdraw`,
        { accessToken: buyerToken },
      );

      expect(foreignRequest.status).toBe(404);
      expect(foreignRequest.body).toEqual(unknown.body);
    });

    it("never lets a cross-tenant issuance reach another organization's request", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation();
      const quote = await registerQuote(request, supplierId);
      await selectQuote(request, quote);

      const response = await issueOrder(request, {
        accessToken: foreignBuyerToken,
      });

      expect(response.status).toBe(404);
      await expect(database.purchaseOrder.count()).resolves.toBe(0);
    });
  });

  describe("REL-004 idempotency over HTTP", () => {
    it("refuses a missing or malformed key with a controlled 400", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation();
      const quote = await registerQuote(request, supplierId);

      const missing = await api.post(
        `/purchase-requests/${request.id}/quotes/${quote.id}/select`,
        {
          accessToken: buyerToken,
          body: { selectionRationale: "Lowest total with the shortest lead" },
        },
      );
      const malformed = await api.post(
        `/purchase-requests/${request.id}/quotes/${quote.id}/select`,
        {
          accessToken: buyerToken,
          headers: { "idempotency-key": "short" },
          body: { selectionRationale: "Lowest total with the shortest lead" },
        },
      );

      expect(missing.status).toBe(400);
      expect(malformed.status).toBe(400);
      // Never echoes the token the client sent.
      expect(JSON.stringify(malformed.body)).not.toContain("short");
      await expect(
        database.supplierQuote.count({ where: { status: "SELECTED" } }),
      ).resolves.toBe(0);
    });

    it("replays a selection without a second transition, audit event or outbox row", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation();
      const quote = await registerQuote(request, supplierId);
      const key = randomUUID();

      const first = await selectQuote(request, quote, { key });
      const replay = await selectQuote(request, quote, { key });

      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first.body);

      expect(await auditEventTypes(request.id)).toEqual([
        "PURCHASE_REQUEST_SUBMITTED",
        "APPROVAL_STEP_APPROVED",
        "SUPPLIER_QUOTE_REGISTERED",
        "SUPPLIER_QUOTE_SELECTED",
      ]);
      await expect(
        database.outboxMessage.count({
          where: { eventType: "PURCHASE_REQUEST_QUOTE_SELECTED" },
        }),
      ).resolves.toBe(1);
    });

    it("replays an issuance without allocating a second number", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation();
      const quote = await registerQuote(request, supplierId);
      await selectQuote(request, quote);
      const key = randomUUID();

      const first = await issueOrder(request, { key });
      const replay = await issueOrder(request, { key });

      expect(first.status).toBe(201);
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(first.body);

      await expect(database.purchaseOrder.count()).resolves.toBe(1);
      await expect(
        database.purchaseOrderNumberSequence.findFirstOrThrow({
          select: { nextValue: true },
        }),
      ).resolves.toEqual({ nextValue: 2n });
      await expect(
        database.outboxMessage.count({
          where: { eventType: "PURCHASE_ORDER_ISSUED" },
        }),
      ).resolves.toBe(1);
    });

    it("refuses the same key for a different request with 409", async () => {
      const request = await requestInQuotation();
      const first = await registerQuote(
        request,
        await registerSupplier(buyerToken, {
          taxIdentifierType: "OTHER",
          taxIdentifier: "SUP-ONE",
        }),
      );
      const second = await registerQuote(
        request,
        await registerSupplier(buyerToken, {
          taxIdentifierType: "OTHER",
          taxIdentifier: "SUP-TWO",
        }),
      );
      const key = randomUUID();

      expect((await selectQuote(request, first, { key })).status).toBe(200);

      const reused = await selectQuote(request, second, { key });
      expect(reused.status).toBe(409);
      await expect(
        database.supplierQuote.count({ where: { status: "SELECTED" } }),
      ).resolves.toBe(1);
    });

    it("treats a different rationale under one key as a different request", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation();
      const quote = await registerQuote(request, supplierId);
      const key = randomUUID();

      expect((await selectQuote(request, quote, { key })).status).toBe(200);

      const reused = await selectQuote(request, quote, {
        key,
        rationale: "A different explanation of the same choice",
      });
      expect(reused.status).toBe(409);
    });

    it("replays a submission rather than materializing a second ladder", async () => {
      const created = await api.post("/purchase-requests", {
        accessToken: requesterToken,
        body: {
          justification: "Replacement laptops for the onboarding cohort",
          neededBy: "2026-11-30",
          items: [
            {
              description: "Laptop",
              unitOfMeasure: "UN",
              quantity: "1",
              estimatedUnitPriceCents: TIER_ONE_CENTS,
            },
          ],
        },
      });
      const { id } = created.body as { readonly id: string };
      const key = randomUUID();

      const first = await api.post(`/purchase-requests/${id}/submit`, {
        accessToken: requesterToken,
        headers: idempotencyHeaders(key),
      });
      const replay = await api.post(`/purchase-requests/${id}/submit`, {
        accessToken: requesterToken,
        headers: idempotencyHeaders(key),
      });

      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect((replay.body as RequestBody).status).toBe("SUBMITTED");
      await expect(database.approvalFlow.count()).resolves.toBe(1);
      expect(await auditEventTypes(id)).toEqual([
        "PURCHASE_REQUEST_SUBMITTED",
      ]);
    });

    it("does not let one user replay another's result under the same key", async () => {
      const supplierId = await registerSupplier();
      const request = await requestInQuotation(TIER_THREE_CENTS);
      const quote = await registerQuote(request, supplierId, {
        freightCents: "0",
        discountCents: "0",
        lines: request.items.map((item) => ({
          purchaseRequestItemId: item.id,
          unitPriceCents: TIER_THREE_CENTS,
        })),
      });
      const key = randomUUID();

      expect((await selectQuote(request, quote, { key })).status).toBe(200);

      // A different actor, the same key, the same operation: a fresh record, so the request is
      // evaluated on its merits — and refused because the quote is already selected.
      const otherBuyer = await createUser(database, {
        organizationId: requester.organizationId,
        branchId: requester.branchId,
        departmentId: requester.departmentId,
        suffix: "SecondBuyer",
        roles: ["BUYER"],
      });
      const response = await selectQuote(request, quote, {
        key,
        accessToken: await login(otherBuyer),
      });

      expect(response.status).toBe(404);
      // Three records, not four: the submission, the manager decision and the selection. The
      // second buyer's attempt was refused inside its own transaction, so its reservation
      // rolled back with it and their key is still usable.
      await expect(database.idempotencyRecord.count()).resolves.toBe(3);
    });
  });

  describe("NFR-009 the OpenAPI document describes what the routes actually do", () => {
    it("documents every new route, its bearer requirement and its Idempotency-Key", async () => {
      const document = (await api.get("/docs-json")).body as {
        readonly paths: Record<string, Record<string, unknown>>;
      };

      for (const path of [
        "/suppliers",
        "/suppliers/{supplierId}",
        "/suppliers/{supplierId}/deactivate",
        "/purchase-requests/awaiting-quotation",
        "/purchase-requests/{purchaseRequestId}/quotes",
        "/purchase-requests/{purchaseRequestId}/quotes/{supplierQuoteId}/withdraw",
        "/purchase-requests/{purchaseRequestId}/quotes/{supplierQuoteId}/select",
        "/purchase-orders",
        "/purchase-orders/{purchaseOrderId}",
        "/purchase-orders/{purchaseOrderId}/cancel",
      ]) {
        expect(document.paths[path]).toBeDefined();
      }

      const select =
        document.paths[
          "/purchase-requests/{purchaseRequestId}/quotes/{supplierQuoteId}/select"
        ]?.post;
      const issue = document.paths["/purchase-orders"]?.post;

      for (const operation of [select, issue]) {
        const typed = operation as {
          readonly security?: readonly unknown[];
          readonly parameters?: readonly { readonly name: string; readonly required?: boolean }[];
          readonly responses: Record<string, unknown>;
        };

        expect(typed.security).toBeDefined();
        expect(
          typed.parameters?.some(
            (parameter) =>
              parameter.name.toLowerCase() === "idempotency-key" &&
              parameter.required === true,
          ),
        ).toBe(true);
        // The failure modes a client has to handle are documented, not only the happy path.
        for (const status of ["400", "403", "404", "409"]) {
          expect(typed.responses[status]).toBeDefined();
        }
      }
    });

    it("declares every exact value as a string, never a JSON number", async () => {
      const document = (await api.get("/docs-json")).body as {
        readonly components: {
          readonly schemas: Record<
            string,
            { readonly properties?: Record<string, { readonly type?: string }> }
          >;
        };
      };
      const monetary = [
        ["SupplierQuoteResponse", "totalCents"],
        ["SupplierQuoteResponse", "itemsTotalCents"],
        ["SupplierQuoteResponse", "freightCents"],
        ["SupplierQuoteItemResponse", "unitPriceCents"],
        ["SupplierQuoteItemResponse", "quantity"],
        ["PurchaseOrderResponse", "totalCents"],
        ["PurchaseOrderItemResponse", "lineTotalCents"],
        ["PurchaseOrderItemResponse", "quantity"],
      ] as const;

      for (const [schema, property] of monetary) {
        expect(
          document.components.schemas[schema]?.properties?.[property]?.type,
        ).toBe("string");
      }
    });
  });
});

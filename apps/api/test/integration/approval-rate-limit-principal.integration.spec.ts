import { randomUUID } from "node:crypto";
import { DatabaseService } from "@vendorflow/database";
import {
  ApiIntegrationTestHarness,
  type HttpTestResponse,
} from "./api-test-harness";
import {
  createTenant,
  createUser,
  type TenantFixture,
  type UserFixture,
} from "./identity-fixtures";
import { PostgreSqlIntegrationTestHarness } from "./postgresql-test-harness";

/**
 * SEC-006's authenticated-principal dimension, isolated from the address dimension by giving
 * the address budget an effectively unlimited allowance here. The address dimension gets the
 * opposite treatment in `approval-rate-limit-address.integration.spec.ts`.
 *
 * Its own file, and its own application instance, for the same reason
 * `authentication-ip-rate-limit.integration.spec.ts` gets one: the limits are read once, when
 * the application module is first imported, so one Jest module registry can hold only one
 * configuration of them.
 */
const PRINCIPAL_LIMIT = 3;

describe("approval routes' per-principal limit (PostgreSQL)", () => {
  let postgres: PostgreSqlIntegrationTestHarness;
  let api: ApiIntegrationTestHarness;
  let database: DatabaseService;

  let requester: TenantFixture;
  let manager: UserFixture;

  let requesterToken: string;
  let managerToken: string;

  beforeAll(async () => {
    postgres = await PostgreSqlIntegrationTestHarness.start();
    database = postgres.database;
    api = await ApiIntegrationTestHarness.start({
      APPROVAL_PRINCIPAL_RATE_LIMIT: String(PRINCIPAL_LIMIT),
      APPROVAL_PRINCIPAL_RATE_LIMIT_WINDOW_SECONDS: "60",
      APPROVAL_IP_RATE_LIMIT: "100000",
      APPROVAL_IP_RATE_LIMIT_WINDOW_SECONDS: "60",
    });
  }, 180_000);

  beforeEach(async () => {
    await postgres.clean();

    requester = await createTenant(database, {
      suffix: "PrincipalLimit",
      roles: ["EMPLOYEE"],
    });
    manager = await createUser(database, {
      organizationId: requester.organizationId,
      branchId: requester.branchId,
      departmentId: requester.departmentId,
      suffix: "PrincipalLimitManager",
      roles: ["MANAGER"],
    });

    requesterToken = await login(requester);
    managerToken = await login(manager);
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

  it("exhausts one principal's own approval-queue budget, and a different principal sharing this address remains usable", async () => {
    const responses: HttpTestResponse[] = [];

    for (let attempt = 0; attempt < PRINCIPAL_LIMIT + 2; attempt += 1) {
      responses.push(
        await api.get("/purchase-requests/awaiting-my-approval", {
          accessToken: requesterToken,
        }),
      );
    }

    // The requester holds no MANAGER role, so a request the limiter still admits answers 403
    // (a capability denial), never 429 — the two must stay distinguishable so a legitimate
    // caller can tell "you may never do this" from "not right now".
    for (const admitted of responses.slice(0, PRINCIPAL_LIMIT)) {
      expect(admitted.status).toBe(403);
    }

    for (const limited of responses.slice(PRINCIPAL_LIMIT)) {
      expectTooManyRequests(limited);
    }

    // Every one of the calls above shares this test process's one source address with the
    // manager below. Its own principal budget is untouched, which is the point: the address
    // dimension is not what refused the requester above (it is asserted unlimited here), and
    // is not what admits the manager below either.
    const other = await api.get("/purchase-requests/awaiting-my-approval", {
      accessToken: managerToken,
    });
    expect(other.status).toBe(200);
  });

  it("leaves the request, its approval step and its audit trail untouched when a decision is refused by the limit", async () => {
    const created = await api.post("/purchase-requests", {
      accessToken: requesterToken,
      body: draftBody(),
    });
    expect(created.status).toBe(201);
    const { id: purchaseRequestId } = created.body as { readonly id: string };
    const submitted = await api.post(
      `/purchase-requests/${purchaseRequestId}/submit`,
      { accessToken: requesterToken },
    );
    expect(submitted.status).toBe(200);

    // Spends the manager's own decision-route budget against identifiers that cannot exist,
    // so nothing here can mutate the real request even though these calls are still admitted.
    for (let attempt = 0; attempt < PRINCIPAL_LIMIT; attempt += 1) {
      const warmup = await decide(managerToken, randomUUID(), {
        decision: "APPROVED",
      });
      expect(warmup.status).toBe(404);
    }

    const limited = await decide(managerToken, purchaseRequestId, {
      decision: "APPROVED",
    });
    expectTooManyRequests(limited);

    const request = await database.purchaseRequest.findUniqueOrThrow({
      where: { id: purchaseRequestId },
      select: { status: true },
    });
    expect(request.status).toBe("SUBMITTED");

    const step = await database.approvalStep.findFirstOrThrow({
      where: { purchaseRequestId, sequence: 1 },
    });
    expect(step.state).toBe("ACTIONABLE");
    expect(step.decidedById).toBeNull();
    expect(step.decidedAt).toBeNull();

    // Only the submission event: the refused decision wrote nothing (AUD-004).
    const events = await database.auditEvent.findMany({
      where: { aggregateId: purchaseRequestId },
    });
    expect(events.map((event) => event.eventType)).toEqual([
      "PURCHASE_REQUEST_SUBMITTED",
    ]);
  });

  function decide(
    accessToken: string,
    purchaseRequestId: string,
    body: unknown,
  ): Promise<HttpTestResponse> {
    return api.post(`/purchase-requests/${purchaseRequestId}/approval-decision`, {
      accessToken,
      body,
    });
  }
});

function draftBody() {
  return {
    justification: "Replacement laptops for the onboarding cohort",
    neededBy: "2026-11-30",
    items: [
      {
        description: "Laptop, 16 GB RAM",
        unitOfMeasure: "UN",
        quantity: "1",
        estimatedUnitPriceCents: "100000",
      },
    ],
  };
}

function expectTooManyRequests(response: HttpTestResponse): void {
  expect(response.status).toBe(429);
  expect(response.body).toEqual({
    statusCode: 429,
    message: "Too many requests",
  });
}

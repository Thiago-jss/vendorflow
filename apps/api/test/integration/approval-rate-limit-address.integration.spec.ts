import { DatabaseService } from "@vendorflow/database";
import {
  ApiIntegrationTestHarness,
  type HttpTestResponse,
} from "./api-test-harness";
import { createTenant, type TenantFixture } from "./identity-fixtures";
import { PostgreSqlIntegrationTestHarness } from "./postgresql-test-harness";

/**
 * SEC-006's source-address dimension, isolated from the per-principal dimension by giving the
 * principal budget an effectively unlimited allowance here. The principal dimension gets the
 * opposite treatment in `approval-rate-limit-principal.integration.spec.ts`.
 *
 * Its own file, and its own application instance, for the same reason the principal-limit
 * suite is: the limits are read once, when the application module is first imported.
 */
const IP_LIMIT = 5;

describe("approval routes' per-address limit (PostgreSQL)", () => {
  let postgres: PostgreSqlIntegrationTestHarness;
  let api: ApiIntegrationTestHarness;
  let database: DatabaseService;

  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    postgres = await PostgreSqlIntegrationTestHarness.start();
    database = postgres.database;
    api = await ApiIntegrationTestHarness.start({
      APPROVAL_IP_RATE_LIMIT: String(IP_LIMIT),
      APPROVAL_IP_RATE_LIMIT_WINDOW_SECONDS: "60",
      APPROVAL_PRINCIPAL_RATE_LIMIT: "100000",
      APPROVAL_PRINCIPAL_RATE_LIMIT_WINDOW_SECONDS: "60",
    });
  }, 180_000);

  beforeEach(async () => {
    await postgres.clean();

    // Two different tenants, so these are two different authenticated principals in every
    // sense — different organizations, different users — sharing only this test process's one
    // source address (every request here comes from the same loopback socket).
    tenantA = await createTenant(database, {
      suffix: "AddressLimitA",
      roles: ["MANAGER"],
    });
    tenantB = await createTenant(database, {
      suffix: "AddressLimitB",
      roles: ["MANAGER"],
    });

    tokenA = await login(tenantA);
    tokenB = await login(tenantB);
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

  it("exhausts the shared address budget across distinct principals, independent of either principal's own budget", async () => {
    const responses: HttpTestResponse[] = [];

    // Alternates two distinct, fully authenticated principals. Neither one's own (asserted
    // unlimited here) budget is anywhere close to spent; only the address the calls share is.
    for (let attempt = 0; attempt < IP_LIMIT + 2; attempt += 1) {
      const accessToken = attempt % 2 === 0 ? tokenA : tokenB;
      responses.push(
        await api.get("/purchase-requests/awaiting-my-approval", {
          accessToken,
        }),
      );
    }

    for (const admitted of responses.slice(0, IP_LIMIT)) {
      expect(admitted.status).toBe(200);
    }

    for (const limited of responses.slice(IP_LIMIT)) {
      expect(limited.status).toBe(429);
      expect(limited.body).toEqual({
        statusCode: 429,
        message: "Too many requests",
      });
    }
  });

  it("does not throttle a route outside the two approval endpoints", async () => {
    // Spend the shared address budget entirely on the queue route.
    for (let attempt = 0; attempt < IP_LIMIT + 2; attempt += 1) {
      await api.get("/purchase-requests/awaiting-my-approval", {
        accessToken: tokenA,
      });
    }

    // A route this limiter was never attached to answers on its own terms, unaffected by a
    // budget that belongs to a different handler entirely.
    const list = await api.get("/purchase-requests", { accessToken: tokenA });
    expect(list.status).toBe(200);
  });
});

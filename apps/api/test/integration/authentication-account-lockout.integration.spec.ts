import { DatabaseService } from "@vendorflow/database";
import {
  ApiIntegrationTestHarness,
  parseSetCookie,
  type HttpTestResponse,
} from "./api-test-harness";
import { createTenant, type TenantFixture } from "./identity-fixtures";
import { PostgreSqlIntegrationTestHarness } from "./postgresql-test-harness";

/**
 * Separate from the source-address suite: an address limit low enough to test would starve
 * these cases, and the limits can only be configured once per Jest module registry.
 */
const ACCOUNT_LIMIT = 3;

describe("authentication account lockout (PostgreSQL)", () => {
  let postgres: PostgreSqlIntegrationTestHarness;
  let api: ApiIntegrationTestHarness;
  let database: DatabaseService;
  let tenant: TenantFixture;

  beforeAll(async () => {
    postgres = await PostgreSqlIntegrationTestHarness.start();
    database = postgres.database;
    api = await ApiIntegrationTestHarness.start({
      AUTH_ACCOUNT_MAX_FAILED_ATTEMPTS: String(ACCOUNT_LIMIT),
      AUTH_ACCOUNT_LOCKOUT_WINDOW_SECONDS: "900",
    });
  }, 180_000);

  beforeEach(async () => {
    await postgres.clean();
    tenant = await createTenant(database, { suffix: uniqueSuffix() });
  }, 60_000);

  afterAll(async () => {
    if (api !== undefined) {
      await api.stop();
    }

    if (postgres !== undefined) {
      await postgres.stop();
    }
  });

  it("locks a single account after repeated credential failures", async () => {
    for (let attempt = 0; attempt < ACCOUNT_LIMIT; attempt += 1) {
      await expect(
        attemptLogin(tenant.email, "wrong password"),
      ).resolves.toMatchObject({ status: 401 });
    }

    // Even the correct password is refused, and with the rate-limit answer rather than a
    // credential answer, so a lockout cannot be mistaken for a wrong password.
    const locked = await attemptLogin(tenant.email, tenant.password);

    expect(locked.status).toBe(429);
    expect(locked.body).toEqual({
      statusCode: 429,
      message: "Too many requests",
    });
    expect(locked.setCookies).toEqual([]);
    await expect(database.authSession.count()).resolves.toBe(0);
  });

  it("locks an address that does not exist exactly like one that does", async () => {
    const existing: HttpTestResponse[] = [];
    const unknown: HttpTestResponse[] = [];

    for (let attempt = 0; attempt < ACCOUNT_LIMIT; attempt += 1) {
      existing.push(await attemptLogin(tenant.email, "wrong password"));
      unknown.push(await attemptLogin("ghost@example.com", "wrong password"));
    }

    const lockedExisting = await attemptLogin(tenant.email, "wrong password");
    const lockedUnknown = await attemptLogin(
      "ghost@example.com",
      "wrong password",
    );

    // Counting failures only for real accounts would make the lockout itself confirm which
    // addresses exist. Both must answer with the same bytes at every step.
    expect(lockedExisting.status).toBe(429);
    expect(lockedUnknown.rawBody).toBe(lockedExisting.rawBody);
    expect(unknown.map(({ rawBody }) => rawBody)).toEqual(
      existing.map(({ rawBody }) => rawBody),
    );
  });

  it("limits each account separately", async () => {
    const other = await createTenant(database, { suffix: uniqueSuffix() });

    for (let attempt = 0; attempt < ACCOUNT_LIMIT; attempt += 1) {
      await attemptLogin(tenant.email, "wrong password");
    }

    await expect(
      attemptLogin(tenant.email, tenant.password),
    ).resolves.toMatchObject({
      status: 429,
    });
    await expect(
      attemptLogin(other.email, other.password),
    ).resolves.toMatchObject({
      status: 200,
    });
  });

  it("clears the counter for the account that authenticated successfully", async () => {
    for (let attempt = 0; attempt < ACCOUNT_LIMIT - 1; attempt += 1) {
      await attemptLogin(tenant.email, "wrong password");
    }

    const success = await attemptLogin(tenant.email, tenant.password);
    expect(success.status).toBe(200);
    expect(
      parseSetCookie(success.setCookies, "vf_refresh")?.value,
    ).toBeTruthy();

    // The budget is whole again, so a later typo does not immediately lock the account.
    for (let attempt = 0; attempt < ACCOUNT_LIMIT - 1; attempt += 1) {
      await expect(
        attemptLogin(tenant.email, "wrong password"),
      ).resolves.toMatchObject({ status: 401 });
    }
  });

  async function attemptLogin(
    email: string,
    password: string,
  ): Promise<HttpTestResponse> {
    return api.post("/auth/login", { body: { email, password } });
  }
});

/**
 * The limiter is process-local and survives `postgres.clean()`, so each case must use an
 * address that no earlier case has already locked.
 */
let caseCounter = 0;

function uniqueSuffix(): string {
  caseCounter += 1;

  return `Case${caseCounter}`;
}

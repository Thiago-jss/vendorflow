import {
  ApiIntegrationTestHarness,
  parseSetCookie,
  type HttpTestResponse,
} from "./api-test-harness";
import { PostgreSqlIntegrationTestHarness } from "./postgresql-test-harness";

/**
 * Its own file, and its own application instance, for two reasons: the limits are read
 * while the application module is first imported, so one Jest module registry can hold only
 * one configuration of them; and the throttler counts every request this suite makes into
 * one window, which would starve any other test sharing the instance.
 */
const IP_LIMIT = 3;
const REFRESH_COOKIE = "vf_refresh";

const CREDENTIALS = {
  email: "someone@example.com",
  password: "correct horse battery staple",
} as const;

describe("authentication source-address limit (PostgreSQL)", () => {
  let postgres: PostgreSqlIntegrationTestHarness;
  let api: ApiIntegrationTestHarness;

  beforeAll(async () => {
    postgres = await PostgreSqlIntegrationTestHarness.start();
    api = await ApiIntegrationTestHarness.start({
      AUTH_IP_RATE_LIMIT: String(IP_LIMIT),
      AUTH_IP_RATE_LIMIT_WINDOW_SECONDS: "60",
    });
  }, 180_000);

  afterAll(async () => {
    if (api !== undefined) {
      await api.stop();
    }

    if (postgres !== undefined) {
      await postgres.stop();
    }
  });

  it("refuses further logins from one address and says nothing about why", async () => {
    const responses: HttpTestResponse[] = [];

    for (let attempt = 0; attempt < IP_LIMIT + 2; attempt += 1) {
      responses.push(await api.post("/auth/login", { body: CREDENTIALS }));
    }

    // The address does not exist, so the credential path answers 401 until the budget runs
    // out and the limit takes over.
    expect(responses.slice(0, IP_LIMIT).map(({ status }) => status)).toEqual(
      Array.from({ length: IP_LIMIT }, () => 401),
    );

    for (const limited of responses.slice(IP_LIMIT)) {
      expectAnonymousTooManyRequests(limited);
    }
  });

  it("refuses further refreshes from one address, on refresh's own budget", async () => {
    // Login's budget is already spent by the previous case, yet refresh still has its own.
    // That per-handler keying is the behaviour we want: password guessing is capped on
    // login alone, while a burst of refreshes from a multi-tab client cannot exhaust the
    // budget a user needs to sign in. The distributed case, where switching endpoints would
    // not help anyway, is covered by the per-account lockout instead.
    const responses: HttpTestResponse[] = [];

    for (let attempt = 0; attempt < IP_LIMIT + 2; attempt += 1) {
      responses.push(await api.post("/auth/refresh"));
    }

    // No cookie is presented, so refresh answers 401 until the budget runs out.
    expect(responses.slice(0, IP_LIMIT).map(({ status }) => status)).toEqual(
      Array.from({ length: IP_LIMIT }, () => 401),
    );

    for (const limited of responses.slice(IP_LIMIT)) {
      expectAnonymousTooManyRequests(limited);
    }
  });

  it("keeps logout available once the address budget is exhausted", async () => {
    // Re-exhaust both limited routes here rather than leaning on the cases above, so this
    // one proves its own premise: login and refresh are refused right now.
    for (let attempt = 0; attempt < IP_LIMIT + 2; attempt += 1) {
      await api.post("/auth/login", { body: CREDENTIALS });
      await api.post("/auth/refresh");
    }

    expect((await api.post("/auth/login", { body: CREDENTIALS })).status).toBe(
      429,
    );
    expect((await api.post("/auth/refresh")).status).toBe(429);

    // Logout carries no guessable secret and only ever revokes. If the address limit could
    // reach it, an attacker sharing a NAT or proxy with the victim could exhaust the budget
    // and keep the victim's sign-out from ever landing.
    for (let attempt = 0; attempt < IP_LIMIT + 2; attempt += 1) {
      const logout = await api.post("/auth/logout");

      expect(logout.status).toBe(204);
      expect(logout.rawBody).toBe("");

      // Still cleared, and with the attributes the cookie was set with — a browser keeps
      // the old cookie if `Path` does not match.
      const cleared = parseSetCookie(logout.setCookies, REFRESH_COOKIE);
      expect(cleared?.value).toBe("");
      expect(cleared?.attributes.get("path")).toBe("/auth");
      expect(cleared?.attributes.has("httponly")).toBe(true);
      expect(cleared?.attributes.get("samesite")).toBe("Strict");
    }
  });

  it("does not throttle routes outside the auth surface", async () => {
    // The limit is deliberately scoped to the two credential-accepting auth routes:
    // applying it globally would make ordinary product traffic share an authentication
    // budget.
    await expect(api.get("/health")).resolves.toMatchObject({ status: 200 });
  });
});

function expectAnonymousTooManyRequests(response: HttpTestResponse): void {
  expect(response.status).toBe(429);
  expect(response.body).toEqual({
    statusCode: 429,
    message: "Too many requests",
  });
  // Nothing about which limit, which account, or how long the window is.
  expect(Object.keys(response.body as object).sort()).toEqual([
    "message",
    "statusCode",
  ]);
}

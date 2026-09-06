import { DatabaseService } from "@vendorflow/database";
import {
  ALLOWED_ORIGIN,
  ApiIntegrationTestHarness,
  parseSetCookie,
  refreshCookieHeader,
  type HttpTestResponse,
} from "./api-test-harness";
import { createTenant, type TenantFixture } from "./identity-fixtures";
import { PostgreSqlIntegrationTestHarness } from "./postgresql-test-harness";

const REFRESH_COOKIE = "vf_refresh";

describe("authentication HTTP surface (PostgreSQL)", () => {
  let postgres: PostgreSqlIntegrationTestHarness;
  let api: ApiIntegrationTestHarness;
  let database: DatabaseService;
  let organizationA: TenantFixture;
  let organizationB: TenantFixture;
  let credentialless: TenantFixture;

  beforeAll(async () => {
    postgres = await PostgreSqlIntegrationTestHarness.start();
    database = postgres.database;
    api = await ApiIntegrationTestHarness.start();
  }, 180_000);

  beforeEach(async () => {
    await postgres.clean();
    organizationA = await createTenant(database, { suffix: "A" });
    organizationB = await createTenant(database, { suffix: "B" });
    credentialless = await createTenant(database, {
      suffix: "NoCredentials",
      password: null,
    });
  }, 60_000);

  afterAll(async () => {
    if (api !== undefined) {
      await api.stop();
    }

    if (postgres !== undefined) {
      await postgres.stop();
    }
  });

  describe("POST /auth/login", () => {
    it("returns an access token in JSON and the refresh token only as a cookie", async () => {
      const response = await login(organizationA);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        accessToken: expect.any(String),
        expiresAt: expect.any(String),
      });

      const cookie = parseSetCookie(response.setCookies, REFRESH_COOKIE);
      expect(cookie?.value).toBeTruthy();
      // The refresh token must exist nowhere in the response body.
      expect(response.rawBody).not.toContain(cookie?.value);
      expect(Object.keys(response.body as object)).toEqual([
        "accessToken",
        "expiresAt",
      ]);
    });

    it("sets the refresh cookie HttpOnly, SameSite=Strict, host-only and scoped to /auth", async () => {
      const response = await login(organizationA);
      const cookie = parseSetCookie(response.setCookies, REFRESH_COOKIE);

      expect(cookie?.attributes.has("httponly")).toBe(true);
      expect(cookie?.attributes.get("samesite")).toBe("Strict");
      expect(cookie?.attributes.get("path")).toBe("/auth");
      expect(cookie?.attributes.has("domain")).toBe(false);
      expect(Number(cookie?.attributes.get("max-age"))).toBeGreaterThan(
        29 * 24 * 60 * 60,
      );
      // NODE_ENV is "test" here, so Secure is off; refresh-cookie.spec.ts covers the
      // production flag directly.
      expect(cookie?.attributes.has("secure")).toBe(false);
    });

    it("persists the session as a digest, never as the token it handed out", async () => {
      const response = await login(organizationA);
      const cookie = parseSetCookie(response.setCookies, REFRESH_COOKIE);

      const sessions = await database.authSession.findMany();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        organizationId: organizationA.organizationId,
        userId: organizationA.userId,
        revokedAt: null,
      });

      const stored = Buffer.from(sessions[0]?.tokenHash ?? []);
      expect(stored).toHaveLength(32);
      expect(stored.toString("utf8")).not.toContain(cookie?.value ?? "");
      expect(stored.toString("base64url")).not.toBe(cookie?.value);
    });

    it("accepts the address in any casing, matching the stored normalization", async () => {
      const response = await api.post("/auth/login", {
        body: {
          email: organizationA.email.toUpperCase(),
          password: organizationA.password,
        },
      });

      expect(response.status).toBe(200);
    });

    it("answers every credential failure identically", async () => {
      const responses = await Promise.all([
        api.post("/auth/login", {
          body: {
            email: "nobody@example.com",
            password: organizationA.password,
          },
        }),
        api.post("/auth/login", {
          body: { email: organizationA.email, password: "wrong password" },
        }),
        api.post("/auth/login", {
          body: {
            email: credentialless.email,
            password: credentialless.password,
          },
        }),
        deactivateAndLogin(),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(401);
        expect(response.body).toEqual({
          statusCode: 401,
          message: "Invalid credentials",
        });
        expect(response.setCookies).toEqual([]);
      }

      // Byte-for-byte identical, not merely equivalent.
      expect(new Set(responses.map(({ rawBody }) => rawBody)).size).toBe(1);
    });

    it("rejects a body carrying anything beyond the two expected fields", async () => {
      const response = await api.post("/auth/login", {
        body: {
          email: organizationA.email,
          password: organizationA.password,
          organizationId: organizationB.organizationId,
        },
      });

      expect(response.status).toBe(400);
      expect(await database.authSession.count()).toBe(0);
    });

    it.each([
      ["a missing password", { email: "employee-a@example.com" }],
      ["a missing address", { password: "correct horse battery staple" }],
      ["a malformed address", { email: "not-an-email", password: "x" }],
      ["an empty password", { email: "employee-a@example.com", password: "" }],
    ])("rejects %s before any credential work", async (_case, body) => {
      const response = await api.post("/auth/login", { body });

      expect(response.status).toBe(400);
    });
  });

  describe("Origin validation", () => {
    it.each(["/auth/login", "/auth/refresh", "/auth/logout"])(
      "refuses %s with no Origin header",
      async (path) => {
        const response = await api.post(path, {
          origin: null,
          body: {
            email: organizationA.email,
            password: organizationA.password,
          },
        });

        expect(response.status).toBe(403);
        expect(response.setCookies).toEqual([]);
      },
    );

    it.each(["/auth/login", "/auth/refresh", "/auth/logout"])(
      "refuses %s from a foreign Origin",
      async (path) => {
        const response = await api.post(path, {
          origin: "https://evil.test",
          body: {
            email: organizationA.email,
            password: organizationA.password,
          },
        });

        expect(response.status).toBe(403);
        expect(response.setCookies).toEqual([]);
      },
    );

    it("allows the configured origin explicitly", async () => {
      const response = await api.post("/auth/login", {
        origin: ALLOWED_ORIGIN,
        body: { email: organizationA.email, password: organizationA.password },
      });

      expect(response.status).toBe(200);
    });

    it("refuses a cross-site login before doing any credential work", async () => {
      const response = await api.post("/auth/login", {
        origin: "https://evil.test",
        body: { email: organizationA.email, password: organizationA.password },
      });

      expect(response.status).toBe(403);
      // No session, and no failed-attempt accounting either: the request never reached
      // authentication.
      expect(await database.authSession.count()).toBe(0);
    });

    it("still refuses a cross-site logout that presents a valid cookie", async () => {
      const token = await loginAndReadCookie(organizationA);

      const response = await api.post("/auth/logout", {
        origin: "https://evil.test",
        cookie: refreshCookieHeader(token),
      });

      expect(response.status).toBe(403);
      const [session] = await database.authSession.findMany();
      expect(session?.revokedAt).toBeNull();
    });
  });

  describe("POST /auth/refresh", () => {
    it("rotates the session and replaces the cookie", async () => {
      const first = await loginAndReadCookie(organizationA);

      const response = await api.post("/auth/refresh", {
        cookie: refreshCookieHeader(first),
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        accessToken: expect.any(String),
        expiresAt: expect.any(String),
      });

      const rotated = parseSetCookie(response.setCookies, REFRESH_COOKIE);
      expect(rotated?.value).toBeTruthy();
      expect(rotated?.value).not.toBe(first);
      expect(response.rawBody).not.toContain(rotated?.value);

      const sessions = await database.authSession.findMany({
        orderBy: { issuedAt: "asc" },
      });
      expect(sessions).toHaveLength(2);
      expect(sessions[0]?.revocationReason).toBe("ROTATED");
      expect(sessions[1]?.revokedAt).toBeNull();
    });

    it("does not extend the absolute lifetime on rotation", async () => {
      const first = await loginAndReadCookie(organizationA);
      const [original] = await database.authSession.findMany();

      const response = await api.post("/auth/refresh", {
        cookie: refreshCookieHeader(first),
      });

      const successor = await database.authSession.findFirstOrThrow({
        where: { revokedAt: null },
      });
      expect(successor.expiresAt).toEqual(original?.expiresAt);

      const cookie = parseSetCookie(response.setCookies, REFRESH_COOKIE);
      const remaining = Number(cookie?.attributes.get("max-age"));
      expect(remaining).toBeLessThanOrEqual(30 * 24 * 60 * 60);
    });

    it.each([
      ["no cookie at all", async () => undefined],
      ["an unknown token", async () => "not-a-real-token"],
      [
        "a token already rotated",
        async () => {
          const token = await loginAndReadCookie(organizationA);
          await api.post("/auth/refresh", {
            cookie: refreshCookieHeader(token),
          });
          return token;
        },
      ],
      [
        "a token revoked by logout",
        async () => {
          const token = await loginAndReadCookie(organizationA);
          await api.post("/auth/logout", {
            cookie: refreshCookieHeader(token),
          });
          return token;
        },
      ],
      [
        "a token whose principal was deactivated",
        async () => {
          const token = await loginAndReadCookie(organizationA);
          await database.user.update({
            where: { id: organizationA.userId },
            data: { isActive: false },
          });
          return token;
        },
      ],
    ])(
      "refuses %s the same way and clears the cookie",
      async (_case, prepare) => {
        const token = await prepare();

        const response = await api.post("/auth/refresh", {
          cookie: token === undefined ? undefined : refreshCookieHeader(token),
        });

        expect(response.status).toBe(401);
        expect(response.body).toEqual({
          statusCode: 401,
          message: "Invalid session",
        });

        const cleared = parseSetCookie(response.setCookies, REFRESH_COOKIE);
        expect(cleared?.value).toBe("");
        expect(cleared?.attributes.get("path")).toBe("/auth");
      },
    );

    it("revokes the family when a rotated token is replayed", async () => {
      const first = await loginAndReadCookie(organizationA);
      const rotated = await api.post("/auth/refresh", {
        cookie: refreshCookieHeader(first),
      });
      const successor =
        parseSetCookie(rotated.setCookies, REFRESH_COOKIE)?.value ?? "";

      const replay = await api.post("/auth/refresh", {
        cookie: refreshCookieHeader(first),
      });
      expect(replay.status).toBe(401);

      // The successor the legitimate client holds is dead as well.
      const afterReplay = await api.post("/auth/refresh", {
        cookie: refreshCookieHeader(successor),
      });
      expect(afterReplay.status).toBe(401);

      const sessions = await database.authSession.findMany();
      expect(sessions.every(({ revokedAt }) => revokedAt !== null)).toBe(true);
    });
  });

  describe("POST /auth/logout", () => {
    it("revokes the presented session, clears the cookie and answers 204", async () => {
      const token = await loginAndReadCookie(organizationA);

      const response = await api.post("/auth/logout", {
        cookie: refreshCookieHeader(token),
      });

      expect(response.status).toBe(204);
      expect(response.rawBody).toBe("");
      expect(parseSetCookie(response.setCookies, REFRESH_COOKIE)?.value).toBe(
        "",
      );

      const [session] = await database.authSession.findMany();
      expect(session?.revocationReason).toBe("LOGOUT");
    });

    it("is idempotent and answers identically with no usable session", async () => {
      const token = await loginAndReadCookie(organizationA);

      const first = await api.post("/auth/logout", {
        cookie: refreshCookieHeader(token),
      });
      const second = await api.post("/auth/logout", {
        cookie: refreshCookieHeader(token),
      });
      const withoutCookie = await api.post("/auth/logout");
      const unknown = await api.post("/auth/logout", {
        cookie: refreshCookieHeader("never-issued"),
      });

      for (const response of [first, second, withoutCookie, unknown]) {
        expect(response.status).toBe(204);
        expect(response.rawBody).toBe("");
      }
    });

    it("leaves other sessions of the same user alone", async () => {
      const first = await loginAndReadCookie(organizationA);
      await loginAndReadCookie(organizationA);

      await api.post("/auth/logout", { cookie: refreshCookieHeader(first) });

      // Logging out one session is not logging out everywhere; that capability is not in
      // this slice.
      expect(
        await database.authSession.count({ where: { revokedAt: null } }),
      ).toBe(1);
    });
  });

  describe("GET /me/organization", () => {
    it("answers from persisted identity, with no identifier from the caller", async () => {
      const accessToken = await loginAndReadAccessToken(organizationA);

      const response = await api.get("/me/organization", { accessToken });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        organization: {
          id: organizationA.organizationId,
          name: "Organization A",
        },
        membership: {
          userId: organizationA.userId,
          branch: { id: organizationA.branchId, name: "Head Office" },
          department: { id: organizationA.departmentId, name: "Operations" },
          roles: ["EMPLOYEE", "MANAGER"],
        },
      });
    });

    it("never returns another tenant's context, whatever the request carries", async () => {
      const accessToken = await loginAndReadAccessToken(organizationA);

      const response = await api.get("/me/organization", {
        accessToken,
        headers: {
          "x-organization-id": organizationB.organizationId,
          "x-user-id": organizationB.userId,
        },
      });

      expect(response.body).toMatchObject({
        organization: { id: organizationA.organizationId },
      });
    });

    it.each([
      ["no Authorization header", undefined],
      ["a malformed token", "not-a-token"],
      ["a structurally valid but unsigned token", "aaa.bbb.ccc"],
    ])("refuses a request with %s", async (_case, accessToken) => {
      const response = await api.get("/me/organization", { accessToken });

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        statusCode: 401,
        message: "Unauthorized",
      });
    });

    it("stops working the moment the user is deactivated, without waiting for expiry", async () => {
      const accessToken = await loginAndReadAccessToken(organizationA);
      await expect(
        api.get("/me/organization", { accessToken }),
      ).resolves.toMatchObject({ status: 200 });

      await database.user.update({
        where: { id: organizationA.userId },
        data: { isActive: false },
      });

      const afterDeactivation = await api.get("/me/organization", {
        accessToken,
      });
      const unknownToken = await api.get("/me/organization", {
        accessToken: "aaa.bbb.ccc",
      });

      expect(afterDeactivation.status).toBe(401);
      // Indistinguishable from a token that was never valid.
      expect(afterDeactivation.rawBody).toBe(unknownToken.rawBody);
    });

    it("reflects a revoked role on the next request, using the same access token", async () => {
      const accessToken = await loginAndReadAccessToken(organizationA);

      await expect(
        api.get("/me/organization", { accessToken }),
      ).resolves.toMatchObject({
        body: { membership: { roles: ["EMPLOYEE", "MANAGER"] } },
      });

      await database.userRole.delete({
        where: {
          organizationId_userId_role: {
            organizationId: organizationA.organizationId,
            userId: organizationA.userId,
            role: "MANAGER",
          },
        },
      });

      // The token still claims MANAGER; the bound principal does not.
      const afterRevocation = await api.get("/me/organization", {
        accessToken,
      });
      expect(afterRevocation.body).toMatchObject({
        membership: { roles: ["EMPLOYEE"] },
      });
    });

    it("works with a token obtained through refresh", async () => {
      const token = await loginAndReadCookie(organizationA);
      const refreshed = await api.post("/auth/refresh", {
        cookie: refreshCookieHeader(token),
      });
      const accessToken = (refreshed.body as { accessToken: string })
        .accessToken;

      await expect(
        api.get("/me/organization", { accessToken }),
      ).resolves.toMatchObject({ status: 200 });
    });
  });

  describe("public routes", () => {
    it("keeps the health probes reachable without a token", async () => {
      await expect(api.get("/health")).resolves.toMatchObject({
        status: 200,
        body: { status: "ok" },
      });
      await expect(api.get("/health/ready")).resolves.toMatchObject({
        status: 200,
        body: { status: "ok" },
      });
    });

    it("requires a token on a route that did not opt out, without any per-route wiring", async () => {
      // Default-deny in the shape that matters: /me/organization carries no guard
      // decorator of its own. It is protected because the global guard protects
      // everything a handler has not explicitly marked @Public().
      const response = await api.get("/me/organization");

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        statusCode: 401,
        message: "Unauthorized",
      });
    });

    it("answers an unmatched path with a sanitized 404, disclosing no internals", async () => {
      // Nest's global guards run for matched handlers only, so an unmatched path is a 404
      // rather than a 401. Route existence is therefore observable without a token. That is
      // accepted: no tenant data, identity or session state is disclosed, and the response
      // carries no stack trace, framework detail or SQL.
      const response = await api.get("/does-not-exist");

      expect(response.status).toBe(404);
      expect(response.rawBody).not.toMatch(
        /at |Error:|prisma|select |vendorflow/i,
      );
      expect(Object.keys(response.body as object).sort()).toEqual([
        "message",
        "statusCode",
      ]);
    });
  });

  async function login(tenant: TenantFixture): Promise<HttpTestResponse> {
    return api.post("/auth/login", {
      body: { email: tenant.email, password: tenant.password },
    });
  }

  async function loginAndReadCookie(tenant: TenantFixture): Promise<string> {
    const response = await login(tenant);
    const cookie = parseSetCookie(response.setCookies, REFRESH_COOKIE);

    if (cookie === undefined) {
      throw new Error(`Expected a refresh cookie, received ${response.status}`);
    }

    return cookie.value;
  }

  async function loginAndReadAccessToken(
    tenant: TenantFixture,
  ): Promise<string> {
    const response = await login(tenant);

    return (response.body as { accessToken: string }).accessToken;
  }

  async function deactivateAndLogin(): Promise<HttpTestResponse> {
    await database.user.update({
      where: { id: organizationB.userId },
      data: { isActive: false },
    });

    return api.post("/auth/login", {
      body: { email: organizationB.email, password: organizationB.password },
    });
  }
});

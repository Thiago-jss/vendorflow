import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "./api-error";
import { createBrowserSession } from "./browser-session";

const BASE_URL = "http://api.test";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function grant(accessToken: string): Response {
  return jsonResponse(200, {
    accessToken,
    expiresAt: "2026-09-10T12:00:00.000Z"
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

/**
 * A response the test hands over by hand. It is what makes a race deterministic: the refresh
 * is provably still in flight when the next thing happens, rather than probably.
 */
function deferredResponse(): {
  readonly response: Promise<Response>;
  readonly started: Promise<void>;
  begin: () => void;
  settle: (response: Response) => void;
  fail: (reason: Error) => void;
} {
  let settle: (response: Response) => void = () => {};
  let fail: (reason: Error) => void = () => {};
  let begin: () => void = () => {};

  const response = new Promise<Response>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });

  return { response, started, begin, settle, fail };
}

function calledPaths(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

function requestInit(
  fetchMock: ReturnType<typeof vi.fn>,
  index: number
): RequestInit {
  return (fetchMock.mock.calls[index]?.[1] ?? {}) as RequestInit;
}

describe("browser session", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  function createSession() {
    return createBrowserSession({
      resolveBaseUrl: () => BASE_URL,
      fetchImplementation: fetchMock as unknown as typeof globalThis.fetch
    });
  }

  it("keeps the access token in memory only and sends the refresh cookie on login", async () => {
    fetchMock.mockResolvedValueOnce(grant("token-1"));
    const writeToStorage = vi.spyOn(Storage.prototype, "setItem");

    const session = createSession();
    await session.login({ email: "buyer@example.test", password: "secret" });

    expect(session.hasAccessToken()).toBe(true);
    expect(calledPaths(fetchMock)).toEqual([`${BASE_URL}/auth/login`]);
    expect(requestInit(fetchMock, 0).credentials).toBe("include");
    expect(writeToStorage).not.toHaveBeenCalled();
    expect(document.cookie).toBe("");
    writeToStorage.mockRestore();
  });

  it("bootstraps a reload through exactly one refresh", async () => {
    fetchMock.mockResolvedValueOnce(grant("token-1"));

    const session = createSession();

    expect(session.hasAccessToken()).toBe(false);
    await expect(session.bootstrap()).resolves.toBe(true);
    expect(calledPaths(fetchMock)).toEqual([`${BASE_URL}/auth/refresh`]);
    expect(requestInit(fetchMock, 0).credentials).toBe("include");
  });

  it("sends the bearer token and no cookie on a business request", async () => {
    fetchMock
      .mockResolvedValueOnce(grant("token-1"))
      .mockResolvedValueOnce(jsonResponse(200, { items: [], nextCursor: null }));

    const session = createSession();
    await session.login({ email: "buyer@example.test", password: "secret" });
    await session.request({ path: "/purchase-requests" });

    const init = requestInit(fetchMock, 1);

    expect(init.credentials).toBe("omit");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer token-1");
  });

  it("carries an idempotency key through the retry that follows a refresh", async () => {
    fetchMock
      .mockResolvedValueOnce(grant("token-1"))
      .mockResolvedValueOnce(jsonResponse(401, { statusCode: 401 }))
      .mockResolvedValueOnce(grant("token-2"))
      .mockResolvedValueOnce(jsonResponse(200, { id: "request-1" }));

    const session = createSession();
    await session.login({ email: "buyer@example.test", password: "secret" });

    await expect(
      session.request({
        path: "/purchase-requests/request-1/submit",
        method: "POST",
        idempotencyKey: "key-1"
      })
    ).resolves.toEqual({ id: "request-1" });

    expect(new Headers(requestInit(fetchMock, 3).headers).get("Idempotency-Key")).toBe(
      "key-1"
    );
    expect(new Headers(requestInit(fetchMock, 3).headers).get("Authorization")).toBe(
      "Bearer token-2"
    );
  });

  it("shares one refresh between simultaneous expired requests", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);

      if (url.endsWith("/auth/login")) {
        return grant("token-1");
      }

      if (url.endsWith("/auth/refresh")) {
        return grant("token-2");
      }

      const authorization = new Headers(
        (fetchMock.mock.calls.at(-1)?.[1] as RequestInit).headers
      ).get("Authorization");

      return authorization === "Bearer token-1"
        ? jsonResponse(401, { statusCode: 401 })
        : jsonResponse(200, { ok: true });
    });

    const session = createSession();
    await session.login({ email: "buyer@example.test", password: "secret" });

    await Promise.all([
      session.request({ path: "/purchase-requests" }),
      session.request({ path: "/purchase-requests" }),
      session.request({ path: "/purchase-requests" })
    ]);

    const refreshCalls = calledPaths(fetchMock).filter((path) =>
      path.endsWith("/auth/refresh")
    );

    expect(refreshCalls).toHaveLength(1);
  });

  it("never refreshes in response to a failing auth route", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { statusCode: 401 }));

    const session = createSession();

    await expect(
      session.login({ email: "buyer@example.test", password: "wrong" })
    ).rejects.toBeInstanceOf(ApiRequestError);
    expect(calledPaths(fetchMock)).toEqual([`${BASE_URL}/auth/login`]);

    await expect(session.bootstrap()).resolves.toBe(false);
    expect(calledPaths(fetchMock)).toEqual([
      `${BASE_URL}/auth/login`,
      `${BASE_URL}/auth/refresh`
    ]);
  });

  it("ends the session on a refresh failure without naming the reason", async () => {
    fetchMock
      .mockResolvedValueOnce(grant("token-1"))
      .mockResolvedValueOnce(jsonResponse(401, { statusCode: 401 }))
      .mockResolvedValueOnce(
        jsonResponse(401, { statusCode: 401, message: "Invalid session" })
      );

    const session = createSession();
    await session.login({ email: "buyer@example.test", password: "secret" });

    const ended = vi.fn();
    session.onSessionEnded(ended);

    const failure = await session
      .request({ path: "/purchase-requests" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiRequestError);
    expect((failure as ApiRequestError).failure.kind).toBe("unauthorized");
    expect((failure as ApiRequestError).failure.message).not.toContain("Invalid session");
    expect(session.hasAccessToken()).toBe(false);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("replays a business request at most once after a successful refresh", async () => {
    fetchMock
      .mockResolvedValueOnce(grant("token-1"))
      .mockResolvedValueOnce(jsonResponse(401, { statusCode: 401 }))
      .mockResolvedValueOnce(grant("token-2"))
      .mockResolvedValueOnce(jsonResponse(401, { statusCode: 401 }));

    const session = createSession();
    await session.login({ email: "buyer@example.test", password: "secret" });

    await expect(session.request({ path: "/purchase-requests" })).rejects.toBeInstanceOf(
      ApiRequestError
    );
    expect(
      calledPaths(fetchMock).filter((path) => path.endsWith("/purchase-requests"))
    ).toHaveLength(2);
    expect(session.hasAccessToken()).toBe(false);
  });

  it("clears local authority even when logout cannot reach the api", async () => {
    fetchMock
      .mockResolvedValueOnce(grant("token-1"))
      .mockRejectedValueOnce(new Error("network down"));

    const session = createSession();
    await session.login({ email: "buyer@example.test", password: "secret" });

    const ended = vi.fn();
    session.onSessionEnded(ended);

    await expect(session.logout()).resolves.toBeUndefined();
    expect(session.hasAccessToken()).toBe(false);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("ends local authority at the click, not when logout reaches the api", async () => {
    const logoutCall = deferredResponse();

    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);

      return url.endsWith("/auth/logout") ? logoutCall.response : grant("token-1");
    });

    const session = createSession();
    await session.login({ email: "buyer@example.test", password: "secret" });

    const ended = vi.fn();
    session.onSessionEnded(ended);

    const loggingOut = session.logout();

    // Synchronous, before anything is awaited: the network never gets a say in whether this
    // document still holds a token.
    expect(session.hasAccessToken()).toBe(false);
    expect(ended).toHaveBeenCalledTimes(1);

    logoutCall.settle(emptyResponse(204));

    await expect(loggingOut).resolves.toBeUndefined();
    expect(session.hasAccessToken()).toBe(false);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("never lets a refresh already in flight resurrect a session the user ended", async () => {
    const refreshCall = deferredResponse();

    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);

      if (url.endsWith("/auth/login")) {
        return grant("token-1");
      }

      if (url.endsWith("/auth/refresh")) {
        refreshCall.begin();

        return refreshCall.response;
      }

      if (url.endsWith("/auth/logout")) {
        return emptyResponse(204);
      }

      return jsonResponse(401, { statusCode: 401 });
    });

    const session = createSession();
    await session.login({ email: "buyer@example.test", password: "secret" });

    const ended = vi.fn();
    session.onSessionEnded(ended);

    // A business request meets an expired token and asks for a refresh, which does not answer.
    const business = session
      .request({ path: "/purchase-requests" })
      .catch((error: unknown) => error);

    await refreshCall.started;

    const loggingOut = session.logout();

    expect(session.hasAccessToken()).toBe(false);

    // The grant the user no longer wants, arriving after the fact.
    refreshCall.settle(grant("token-2"));

    await loggingOut;

    expect(session.hasAccessToken()).toBe(false);
    expect((await business) as ApiRequestError).toBeInstanceOf(ApiRequestError);
    expect(((await business) as ApiRequestError).failure.kind).toBe("unauthorized");
    // One end, from the logout. The stale refresh neither restores nor re-ends the session.
    expect(ended).toHaveBeenCalledTimes(1);
    expect(
      calledPaths(fetchMock).filter((path) => path.endsWith("/purchase-requests"))
    ).toHaveLength(1);
  });

  it("starts no new refresh for a request that meets a 401 after logout began", async () => {
    const refreshCall = deferredResponse();
    const logoutCall = deferredResponse();
    const secondBusinessCall = deferredResponse();
    let businessCalls = 0;

    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);

      if (url.endsWith("/auth/login")) {
        return grant("token-1");
      }

      if (url.endsWith("/auth/refresh")) {
        refreshCall.begin();

        return refreshCall.response;
      }

      if (url.endsWith("/auth/logout")) {
        return logoutCall.response;
      }

      businessCalls += 1;

      // The first request is refused at once; the second is held so its refusal can be
      // delivered after the user has already logged out.
      return businessCalls === 1
        ? jsonResponse(401, { statusCode: 401 })
        : secondBusinessCall.response;
    });

    const session = createSession();
    await session.login({ email: "buyer@example.test", password: "secret" });

    const ended = vi.fn();
    session.onSessionEnded(ended);

    const first = session
      .request({ path: "/purchase-requests" })
      .catch((error: unknown) => error);
    const second = session
      .request({ path: "/purchase-requests" })
      .catch((error: unknown) => error);

    await refreshCall.started;

    const loggingOut = session.logout();

    expect(session.hasAccessToken()).toBe(false);

    // Now the second request learns its token is dead — after the logout, and while the
    // refresh cookie may well still be good for one more grant.
    secondBusinessCall.settle(jsonResponse(401, { statusCode: 401 }));
    refreshCall.settle(grant("token-2"));
    logoutCall.settle(emptyResponse(204));

    await loggingOut;

    for (const failure of [await first, await second]) {
      expect(failure).toBeInstanceOf(ApiRequestError);
      expect((failure as ApiRequestError).failure.kind).toBe("unauthorized");
    }

    expect(
      calledPaths(fetchMock).filter((path) => path.endsWith("/auth/refresh"))
    ).toHaveLength(1);
    expect(session.hasAccessToken()).toBe(false);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("asks for no refresh at all once logout has begun", async () => {
    const logoutCall = deferredResponse();

    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);

      return url.endsWith("/auth/logout") ? logoutCall.response : grant("token-1");
    });

    const session = createSession();
    await session.login({ email: "buyer@example.test", password: "secret" });

    const loggingOut = session.logout();
    const refused = await session
      .request({ path: "/purchase-requests" })
      .catch((error: unknown) => error);

    expect((refused as ApiRequestError).failure.kind).toBe("unauthorized");
    // The request never left: no refresh was attempted, and no business call either.
    expect(calledPaths(fetchMock)).toEqual([
      `${BASE_URL}/auth/login`,
      `${BASE_URL}/auth/logout`
    ]);

    logoutCall.settle(emptyResponse(204));

    await expect(loggingOut).resolves.toBeUndefined();
  });

  it("gives a new session back its right to refresh only through an explicit login", async () => {
    fetchMock
      .mockResolvedValueOnce(grant("token-1"))
      .mockResolvedValueOnce(emptyResponse(204))
      .mockResolvedValueOnce(grant("token-2"))
      .mockResolvedValueOnce(jsonResponse(401, { statusCode: 401 }))
      .mockResolvedValueOnce(grant("token-3"))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const session = createSession();
    await session.login({ email: "buyer@example.test", password: "secret" });
    await session.logout();

    await session.login({ email: "buyer@example.test", password: "secret" });

    await expect(session.request({ path: "/purchase-requests" })).resolves.toEqual({
      ok: true
    });
    expect(calledPaths(fetchMock).at(4)).toBe(`${BASE_URL}/auth/refresh`);
    expect(new Headers(requestInit(fetchMock, 5).headers).get("Authorization")).toBe(
      "Bearer token-3"
    );
  });

  it("never lets an obsolete refresh overwrite a newer login", async () => {
    const refreshCall = deferredResponse();

    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);

      if (url.endsWith("/auth/refresh")) {
        refreshCall.begin();

        return refreshCall.response;
      }

      return url.endsWith("/auth/login")
        ? grant("token-2")
        : jsonResponse(200, { ok: true });
    });

    const session = createSession();
    // A reload bootstraps, and the refresh hangs. The reader signs in by hand instead.
    const bootstrapping = session.bootstrap();

    await refreshCall.started;
    await session.login({ email: "buyer@example.test", password: "secret" });

    refreshCall.settle(grant("token-stale"));

    await expect(bootstrapping).resolves.toBe(false);
    expect(session.hasAccessToken()).toBe(true);

    await session.request({ path: "/purchase-requests" });

    expect(new Headers(requestInit(fetchMock, 2).headers).get("Authorization")).toBe(
      "Bearer token-2"
    );
  });

  it("never lets an obsolete refresh failure end a newer login", async () => {
    const refreshCall = deferredResponse();

    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);

      if (url.endsWith("/auth/refresh")) {
        refreshCall.begin();

        return refreshCall.response;
      }

      return grant("token-2");
    });

    const session = createSession();
    const bootstrapping = session.bootstrap();

    await refreshCall.started;
    await session.login({ email: "buyer@example.test", password: "secret" });

    const ended = vi.fn();
    session.onSessionEnded(ended);

    refreshCall.fail(new Error("network down"));

    await expect(bootstrapping).resolves.toBe(false);
    expect(session.hasAccessToken()).toBe(true);
    expect(ended).not.toHaveBeenCalled();
  });

  it("reports a transport failure as a recoverable network failure", async () => {
    fetchMock
      .mockResolvedValueOnce(grant("token-1"))
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:3001"));

    const session = createSession();
    await session.login({ email: "buyer@example.test", password: "secret" });

    const failure = await session
      .request({ path: "/purchase-requests" })
      .catch((error: unknown) => error);

    expect((failure as ApiRequestError).failure.kind).toBe("network");
    expect((failure as ApiRequestError).failure.message).not.toContain("ECONNREFUSED");
  });
});

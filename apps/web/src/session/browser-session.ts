import { apiBaseUrl } from "./api-configuration";
import {
  ApiRequestError,
  failureOfKind,
  networkFailure,
  normalizeApiFailure
} from "./api-error";

/**
 * The browser's whole authority over its own session: one access token, held in the memory
 * of one document.
 *
 * Nothing here writes to `localStorage`, `sessionStorage`, IndexedDB or a cookie the script
 * can set. A reload therefore starts with no token and re-derives one from the HttpOnly
 * refresh cookie, which is the only durable credential in the browser and one this code
 * cannot read.
 *
 * Two rules keep the rotation safe. Rotation is compare-and-swap server-side and a
 * concurrent replay revokes the session family, so **at most one refresh is ever in flight**
 * per document. And the auth routes themselves never go through the refresh path, so a
 * failing refresh cannot ask itself to refresh.
 *
 * A third rule keeps the token honest in time. Every event that decides who this document is
 * — a login, a logout, a session that ended — supersedes a *generation*. A refresh reads the
 * generation before it leaves and may only write a token back while that same generation is
 * still current, so an answer that arrives after the question stopped mattering is discarded
 * instead of applied.
 *
 * And a fourth rule closes the other half of the same race. Ending a session also withdraws
 * the document's standing to renew one: after a logout no 401 starts a refresh, because the
 * refresh cookie may outlive the logout request by a moment and would happily mint a token
 * nobody asked for. A successful login is the only thing that gives that standing back.
 */
export interface AccessTokenGrant {
  readonly accessToken: string;
  readonly expiresAt: string;
}

export interface PasswordCredentials {
  readonly email: string;
  readonly password: string;
}

export interface AuthenticatedRequestInput {
  readonly path: string;
  readonly method?: "GET" | "POST" | "PUT";
  readonly body?: unknown;
  /** REL-004. Sent verbatim, never logged, and preserved across a refresh replay. */
  readonly idempotencyKey?: string;
}

export interface BrowserSession {
  login(credentials: PasswordCredentials): Promise<void>;
  /** One refresh attempt. True when the document now holds a usable access token. */
  bootstrap(): Promise<boolean>;
  logout(): Promise<void>;
  request<T>(input: AuthenticatedRequestInput): Promise<T>;
  hasAccessToken(): boolean;
  onSessionEnded(listener: () => void): () => void;
}

export interface BrowserSessionOptions {
  readonly fetchImplementation?: typeof globalThis.fetch;
  readonly resolveBaseUrl?: () => string;
}

const AUTH_LOGIN_PATH = "/auth/login";
const AUTH_REFRESH_PATH = "/auth/refresh";
const AUTH_LOGOUT_PATH = "/auth/logout";

async function readJsonBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }

  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

function isAccessTokenGrant(body: unknown): body is AccessTokenGrant {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { accessToken?: unknown }).accessToken === "string" &&
    typeof (body as { expiresAt?: unknown }).expiresAt === "string"
  );
}

export function createBrowserSession(
  options: BrowserSessionOptions = {}
): BrowserSession {
  const resolveBaseUrl = options.resolveBaseUrl ?? apiBaseUrl;
  const listeners = new Set<() => void>();

  // The token. A module-level closure, not storage: it dies with the document.
  let accessToken: string | null = null;
  let refreshInFlight: Promise<string | null> | null = null;
  /**
   * Which authority the document currently holds. Not a credential and never sent anywhere:
   * a counter whose only job is to let a refresh recognize that it is answering a question
   * nobody is asking any more.
   */
  let sessionGeneration = 0;
  /**
   * Whether this document may still ask the refresh cookie for a token on its own.
   *
   * A generation says *which* session an answer belongs to; this says whether the document
   * is allowed to ask the question at all. A fresh document may, once, to bootstrap a
   * reload. A session that ended may not, however valid the cookie still looks to the
   * server: the user said stop, and a 401 arriving a moment later must not be read as an
   * invitation to re-authenticate silently. Only an explicit login restores it.
   */
  let automaticRefreshAllowed = true;

  /**
   * Ends the current generation. Whatever a refresh started under it may still resolve, but
   * it can no longer grant anything, and it is no longer shareable with a later caller.
   */
  function supersedeGeneration(): void {
    sessionGeneration += 1;
    refreshInFlight = null;
  }

  function endSession(): void {
    accessToken = null;
    automaticRefreshAllowed = false;
    supersedeGeneration();

    for (const listener of listeners) {
      listener();
    }
  }

  async function send(
    path: string,
    init: RequestInit
  ): Promise<{ response: Response; body: unknown }> {
    let response: Response;

    try {
      response = await (options.fetchImplementation ?? globalThis.fetch)(
        `${resolveBaseUrl()}${path}`,
        init
      );
    } catch {
      // The reason is deliberately dropped rather than logged: it is diagnostics for the
      // person at the keyboard, not for the console of a shared machine.
      throw new ApiRequestError(networkFailure());
    }

    return { response, body: await readJsonBody(response) };
  }

  /**
   * The three cookie-bearing routes. They include credentials, they carry no bearer token,
   * and — this is the invariant — they never consult the refresh path themselves.
   */
  async function sendAuthRequest(path: string, payload?: unknown): Promise<unknown> {
    const { response, body } = await send(path, {
      method: "POST",
      credentials: "include",
      headers:
        payload === undefined ? undefined : { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new ApiRequestError(normalizeApiFailure(response.status, body));
    }

    return body;
  }

  async function performRefresh(): Promise<string | null> {
    // Read before the request leaves, compared after it lands. A logout or a newer login in
    // between makes this attempt obsolete, and an obsolete attempt decides nothing: it must
    // neither grant a token nor end a session it no longer speaks for.
    const generation = sessionGeneration;

    try {
      const body = await sendAuthRequest(AUTH_REFRESH_PATH);

      if (generation !== sessionGeneration) {
        return null;
      }

      if (!isAccessTokenGrant(body)) {
        endSession();

        return null;
      }

      accessToken = body.accessToken;

      return accessToken;
    } catch {
      // Missing, expired, replayed, revoked and unknown all arrive here and all leave the
      // same way. The browser learns only that it has no session.
      if (generation === sessionGeneration) {
        endSession();
      }

      return null;
    }
  }

  function refreshAccessToken(): Promise<string | null> {
    if (!automaticRefreshAllowed) {
      // No request is made. A cookie the server has not finished revoking would still mint a
      // token here, and that token would be one nobody asked for.
      return Promise.resolve(null);
    }

    if (refreshInFlight !== null) {
      return refreshInFlight;
    }

    const attempt = performRefresh().finally(() => {
      if (refreshInFlight === attempt) {
        refreshInFlight = null;
      }
    });

    refreshInFlight = attempt;

    return attempt;
  }

  /**
   * A token for a request that has just failed with the one it used. When another request
   * already replaced it, that newer token is the answer and no second refresh is asked for.
   */
  function renewAccessToken(usedToken: string | null): Promise<string | null> {
    if (accessToken !== null && accessToken !== usedToken) {
      return Promise.resolve(accessToken);
    }

    return refreshAccessToken();
  }

  async function sendAuthenticatedRequest(
    input: AuthenticatedRequestInput,
    token: string
  ): Promise<{ response: Response; body: unknown }> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };

    if (input.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (input.idempotencyKey !== undefined) {
      headers["Idempotency-Key"] = input.idempotencyKey;
    }

    return send(input.path, {
      method: input.method ?? "GET",
      // Explicitly omitted: a business route is authorized by the bearer token alone, and
      // the refresh cookie is scoped to /auth precisely so it never travels here.
      credentials: "omit",
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body)
    });
  }

  return {
    async login(credentials: PasswordCredentials): Promise<void> {
      const body = await sendAuthRequest(AUTH_LOGIN_PATH, {
        email: credentials.email,
        password: credentials.password
      });

      if (!isAccessTokenGrant(body)) {
        throw new ApiRequestError(failureOfKind("unknown"));
      }

      // A fresh grant is a new authority. Anything an earlier one left in flight answers for
      // a session this one has replaced, and must not overwrite the token just issued. This
      // is also the one place that gives the document back its standing to refresh.
      supersedeGeneration();
      automaticRefreshAllowed = true;
      accessToken = body.accessToken;
    },

    async bootstrap(): Promise<boolean> {
      return (await refreshAccessToken()) !== null;
    },

    async logout(): Promise<void> {
      // Before the first `await`, so the document stops being authenticated the moment the
      // user asks and not when the network agrees. This drops the token, supersedes the
      // generation so a refresh already in flight lands on nothing, and withdraws the right
      // to start another one while this request is still travelling.
      endSession();

      try {
        await sendAuthRequest(AUTH_LOGOUT_PATH);
      } catch {
        // Best effort: revoking the refresh family is the server's job and it either happened
        // or it did not. Local authority is already gone either way.
      }
    },

    async request<T>(input: AuthenticatedRequestInput): Promise<T> {
      let token = accessToken ?? (await refreshAccessToken());

      if (token === null) {
        throw new ApiRequestError(failureOfKind("unauthorized"));
      }

      let attempt = await sendAuthenticatedRequest(input, token);

      if (attempt.response.status === 401) {
        const renewed = await renewAccessToken(token);

        if (renewed === null) {
          throw new ApiRequestError(failureOfKind("unauthorized"));
        }

        token = renewed;
        // At most one replay. A second 401 is not a token problem, so retrying again would
        // only loop.
        attempt = await sendAuthenticatedRequest(input, token);

        if (attempt.response.status === 401) {
          endSession();

          throw new ApiRequestError(failureOfKind("unauthorized"));
        }
      }

      if (!attempt.response.ok) {
        throw new ApiRequestError(
          normalizeApiFailure(attempt.response.status, attempt.body)
        );
      }

      return attempt.body as T;
    },

    hasAccessToken(): boolean {
      return accessToken !== null;
    },

    onSessionEnded(listener: () => void): () => void {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    }
  };
}

/** One session per document, shared by every client component through the provider. */
export const browserSession = createBrowserSession();

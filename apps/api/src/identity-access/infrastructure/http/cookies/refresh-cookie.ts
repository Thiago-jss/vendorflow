import type { CookieOptions, Request, Response } from "express";

/**
 * No `__Host-` prefix, deliberately. That prefix would force `Path=/`, sending the refresh
 * token to every endpoint of the API. Scoping the cookie to the only routes that consume it
 * is the more valuable of the two controls, and the guarantees the prefix would enforce —
 * host-only and Secure — are set explicitly below.
 */
export const REFRESH_COOKIE_NAME = "vf_refresh";

const REFRESH_COOKIE_PATH = "/auth";

function baseCookieOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    // Strict, not Lax: no cross-site navigation should ever carry this cookie, and the web
    // client shares a registrable domain with the API in production.
    sameSite: "strict",
    secure,
    path: REFRESH_COOKIE_PATH,
    // No `domain`: omitting it makes the cookie host-only, so a sibling subdomain cannot
    // receive it and a compromised one cannot set it for the API host.
  };
}

export function setRefreshCookie(
  response: Response,
  token: string,
  expiresAt: Date,
  secure: boolean,
): void {
  const remainingMilliseconds = Math.max(0, expiresAt.getTime() - Date.now());

  response.cookie(REFRESH_COOKIE_NAME, token, {
    ...baseCookieOptions(secure),
    // The remaining absolute lifetime, so the browser drops the cookie exactly when the
    // server-side session stops being usable. Rotation never extends it.
    maxAge: remainingMilliseconds,
  });
}

/**
 * Cleared on logout and on every failed refresh. A client holding an unusable token should
 * stop presenting it, and the attributes must match those used to set it or the browser
 * keeps the old cookie.
 */
export function clearRefreshCookie(response: Response, secure: boolean): void {
  response.clearCookie(REFRESH_COOKIE_NAME, baseCookieOptions(secure));
}

export function readRefreshCookie(request: Request): string | null {
  const cookies: unknown = (request as { cookies?: unknown }).cookies;

  if (typeof cookies !== "object" || cookies === null) {
    return null;
  }

  const token = (cookies as Record<string, unknown>)[REFRESH_COOKIE_NAME];

  return typeof token === "string" && token.length > 0 ? token : null;
}

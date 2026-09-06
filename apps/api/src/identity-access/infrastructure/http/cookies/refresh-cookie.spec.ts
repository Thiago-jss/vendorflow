import type { Response } from "express";
import {
  REFRESH_COOKIE_NAME,
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from "./refresh-cookie";

interface RecordedCookie {
  readonly name: string;
  readonly value: string;
  readonly options: Record<string, unknown>;
}

function recordingResponse(): {
  readonly response: Response;
  readonly set: RecordedCookie[];
  readonly cleared: RecordedCookie[];
} {
  const set: RecordedCookie[] = [];
  const cleared: RecordedCookie[] = [];

  const response = {
    cookie: (name: string, value: string, options: Record<string, unknown>) => {
      set.push({ name, value, options });
    },
    clearCookie: (name: string, options: Record<string, unknown>) => {
      cleared.push({ name, value: "", options });
    },
  } as unknown as Response;

  return { response, set, cleared };
}

describe("refresh cookie", () => {
  it("is HttpOnly, SameSite=Strict, host-only and scoped to the auth routes", () => {
    const { response, set } = recordingResponse();

    setRefreshCookie(
      response,
      "opaque-token",
      new Date(Date.now() + 60_000),
      false,
    );

    expect(set).toHaveLength(1);
    expect(set[0]?.name).toBe(REFRESH_COOKIE_NAME);
    expect(set[0]?.value).toBe("opaque-token");
    expect(set[0]?.options).toMatchObject({
      httpOnly: true,
      sameSite: "strict",
      path: "/auth",
    });
    // No Domain attribute: the cookie must stay host-only so no sibling subdomain sees it.
    expect(set[0]?.options).not.toHaveProperty("domain");
  });

  it("marks the cookie Secure in production and not in local development", () => {
    const production = recordingResponse();
    const development = recordingResponse();

    setRefreshCookie(
      production.response,
      "t",
      new Date(Date.now() + 60_000),
      true,
    );
    setRefreshCookie(
      development.response,
      "t",
      new Date(Date.now() + 60_000),
      false,
    );

    expect(production.set[0]?.options).toMatchObject({ secure: true });
    expect(development.set[0]?.options).toMatchObject({ secure: false });
  });

  it("expires with the remaining absolute session lifetime, never a fresh full lifetime", () => {
    const { response, set } = recordingResponse();
    const twoDaysLeft = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

    setRefreshCookie(response, "t", twoDaysLeft, false);

    const maxAge = set[0]?.options.maxAge as number;
    expect(maxAge).toBeGreaterThan(2 * 24 * 60 * 60 * 1000 - 5_000);
    expect(maxAge).toBeLessThanOrEqual(2 * 24 * 60 * 60 * 1000);
  });

  it("never asks for a negative lifetime when the session already expired", () => {
    const { response, set } = recordingResponse();

    setRefreshCookie(response, "t", new Date(Date.now() - 60_000), false);

    expect(set[0]?.options.maxAge).toBe(0);
  });

  it("clears with the same attributes it was set with, or the browser keeps it", () => {
    const { response, set, cleared } = recordingResponse();

    setRefreshCookie(response, "t", new Date(Date.now() + 60_000), true);
    clearRefreshCookie(response, true);

    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.name).toBe(REFRESH_COOKIE_NAME);
    const { maxAge: _maxAge, ...setAttributes } = set[0]?.options ?? {};
    expect(cleared[0]?.options).toEqual(setAttributes);
  });

  it("reads only a non-empty string cookie and ignores anything else", () => {
    expect(
      readRefreshCookie({ cookies: { vf_refresh: "token" } } as never),
    ).toBe("token");
    expect(
      readRefreshCookie({ cookies: { vf_refresh: "" } } as never),
    ).toBeNull();
    expect(
      readRefreshCookie({ cookies: { vf_refresh: ["a", "b"] } } as never),
    ).toBeNull();
    expect(readRefreshCookie({ cookies: {} } as never)).toBeNull();
    expect(readRefreshCookie({} as never)).toBeNull();
  });
});

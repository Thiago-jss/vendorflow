import { describe, expect, it } from "vitest";
import {
  ApiRequestError,
  networkFailure,
  normalizeApiFailure,
  toApiFailure
} from "./api-error";

describe("api failure normalization", () => {
  it("maps every handled status to a closed kind", () => {
    const expectations: readonly (readonly [number, string])[] = [
      [400, "invalid-request"],
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not-found"],
      [409, "conflict"],
      [422, "unprocessable"],
      [429, "rate-limited"],
      [500, "server"],
      [502, "server"],
      [418, "unknown"]
    ];

    for (const [status, kind] of expectations) {
      expect(normalizeApiFailure(status, null).kind).toBe(kind);
    }
  });

  it("never renders the body of a status that is not about the payload", () => {
    const failure = normalizeApiFailure(404, {
      statusCode: 404,
      message: "Purchase request 7f0 belongs to organization ACME"
    });

    expect(failure.details).toEqual([]);
    expect(failure.message).toBe("Registro não encontrado.");
  });

  it("carries bounded plain-text details for payload failures", () => {
    const failure = normalizeApiFailure(400, {
      message: [
        "justification should not be empty",
        "items must contain at least 1 element"
      ]
    });

    expect(failure.details).toEqual([
      "justification should not be empty",
      "items must contain at least 1 element"
    ]);
  });

  it("drops details that are not printable strings or exceed the bounds", () => {
    const withControlCharacter = `carries a ${String.fromCharCode(7)} bell`;

    const failure = normalizeApiFailure(422, {
      message: [
        "first",
        withControlCharacter,
        "x".repeat(201),
        { nested: "object" },
        "second",
        "third",
        "fourth",
        "fifth",
        "sixth"
      ]
    });

    expect(failure.details).toEqual([
      "first",
      "second",
      "third",
      "fourth",
      "fifth"
    ]);
  });

  it("describes a request that never reached the api", () => {
    expect(networkFailure()).toMatchObject({ kind: "network", status: null });
  });

  it("reduces an unknown thrown value to a safe failure", () => {
    const leaky = new Error("connect ECONNREFUSED 127.0.0.1:3001");

    expect(toApiFailure(leaky).kind).toBe("unknown");
    expect(toApiFailure(leaky).message).not.toContain("ECONNREFUSED");
    expect(toApiFailure(new ApiRequestError(normalizeApiFailure(409, null))).kind).toBe(
      "conflict"
    );
  });
});

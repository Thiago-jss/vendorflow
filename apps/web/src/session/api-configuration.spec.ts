import { describe, expect, it } from "vitest";
import { ApiConfigurationError, readApiBaseUrl } from "./api-configuration";

describe("api base url", () => {
  it("keeps an origin without a trailing separator", () => {
    expect(readApiBaseUrl("http://localhost:3001/")).toBe("http://localhost:3001");
  });

  it("keeps a mounted path prefix", () => {
    expect(readApiBaseUrl("https://api.example.test/v1/")).toBe(
      "https://api.example.test/v1"
    );
  });

  it("refuses an absent value", () => {
    expect(() => readApiBaseUrl(undefined)).toThrow(ApiConfigurationError);
    expect(() => readApiBaseUrl("   ")).toThrow(ApiConfigurationError);
  });

  it("refuses a malformed or non-http value", () => {
    expect(() => readApiBaseUrl("localhost:3001")).toThrow(ApiConfigurationError);
    expect(() => readApiBaseUrl("ftp://api.example.test")).toThrow(
      ApiConfigurationError
    );
  });
});

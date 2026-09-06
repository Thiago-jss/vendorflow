import { validateEnvironment } from "./env";

describe("validateEnvironment", () => {
  const required = {
    DATABASE_URL: "postgresql://vendorflow:vendorflow@localhost:5432/vendorflow",
    CORS_ORIGINS: "http://localhost:3000, https://app.vendorflow.test",
    AUTH_JWT_SECRET: "a".repeat(32),
    AUTH_JWT_ISSUER: "vendorflow",
    AUTH_JWT_AUDIENCE: "vendorflow-api"
  };

  it("parses the API's actual database and CORS dependencies", () => {
    expect(validateEnvironment(required)).toMatchObject({
      PORT: 3001,
      CORS_ORIGINS: ["http://localhost:3000", "https://app.vendorflow.test"]
    });
  });

  it("fails fast when the required database configuration is absent", () => {
    expect(() => validateEnvironment({ ...required, DATABASE_URL: undefined })).toThrow("DATABASE_URL");
  });

  it("does not require unused Redis configuration", () => {
    expect(() => validateEnvironment(required)).not.toThrow();
  });

  it("refuses to boot without access-token signing material", () => {
    expect(() => validateEnvironment({ ...required, AUTH_JWT_SECRET: undefined })).toThrow("AUTH_JWT_SECRET");
  });

  it("rejects a signing key below the HS256 output size, counted in bytes", () => {
    expect(() => validateEnvironment({ ...required, AUTH_JWT_SECRET: "a".repeat(31) })).toThrow(
      "at least 32 bytes of key material"
    );
    // 31 multi-byte characters look long enough by length but are not.
    expect(() => validateEnvironment({ ...required, AUTH_JWT_SECRET: "á".repeat(15) })).toThrow(
      "at least 32 bytes of key material"
    );
    expect(() => validateEnvironment({ ...required, AUTH_JWT_SECRET: "á".repeat(16) })).not.toThrow();
  });

  it("requires an explicit issuer and audience", () => {
    expect(() => validateEnvironment({ ...required, AUTH_JWT_ISSUER: "" })).toThrow("AUTH_JWT_ISSUER");
    expect(() => validateEnvironment({ ...required, AUTH_JWT_AUDIENCE: undefined })).toThrow("AUTH_JWT_AUDIENCE");
  });

  it("applies the approved token and rate-limit defaults", () => {
    expect(validateEnvironment(required)).toMatchObject({
      AUTH_ACCESS_TOKEN_TTL_SECONDS: 900,
      AUTH_REFRESH_TOKEN_TTL_SECONDS: 2_592_000,
      AUTH_IP_RATE_LIMIT: 10,
      AUTH_IP_RATE_LIMIT_WINDOW_SECONDS: 60,
      AUTH_ACCOUNT_MAX_FAILED_ATTEMPTS: 5,
      AUTH_ACCOUNT_LOCKOUT_WINDOW_SECONDS: 900
    });
  });

  it("canonicalizes allowed origins so the auth Origin allowlist compares exact strings", () => {
    expect(
      validateEnvironment({ ...required, CORS_ORIGINS: "https://app.vendorflow.test/" }).CORS_ORIGINS
    ).toEqual(["https://app.vendorflow.test"]);
  });
});

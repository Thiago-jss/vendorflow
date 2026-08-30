import { validateEnvironment } from "./env";

describe("validateEnvironment", () => {
  const required = {
    DATABASE_URL: "postgresql://vendorflow:vendorflow@localhost:5432/vendorflow",
    REDIS_URL: "redis://localhost:6379",
    CORS_ORIGINS: "http://localhost:3000, https://app.vendorflow.test"
  };

  it("parses explicit infrastructure and CORS configuration", () => {
    expect(validateEnvironment(required)).toMatchObject({
      PORT: 3001,
      CORS_ORIGINS: ["http://localhost:3000", "https://app.vendorflow.test"]
    });
  });

  it("fails fast when required infrastructure configuration is absent", () => {
    expect(() => validateEnvironment({ ...required, DATABASE_URL: undefined })).toThrow("DATABASE_URL");
  });
});

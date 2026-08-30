import { validateEnvironment } from "./env";

describe("validateEnvironment", () => {
  const required = {
    DATABASE_URL: "postgresql://vendorflow:vendorflow@localhost:5432/vendorflow",
    CORS_ORIGINS: "http://localhost:3000, https://app.vendorflow.test"
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
});

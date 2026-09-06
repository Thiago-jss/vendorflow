/**
 * Runs before every test file loads, because `ConfigModule.forRoot()` validates the
 * environment while `app.module.ts` is being imported — long before any `beforeAll`.
 *
 * These are non-secret test values. Individual suites override them through
 * `ApiIntegrationTestHarness.start()`, which applies its overrides before importing the
 * application module.
 */
const TEST_ENVIRONMENT: Readonly<Record<string, string>> = {
  NODE_ENV: "test",
  CORS_ORIGINS: "http://localhost:3000",
  AUTH_JWT_SECRET: "integration-test-access-token-signing-key-0123456789",
  AUTH_JWT_ISSUER: "vendorflow-test",
  AUTH_JWT_AUDIENCE: "vendorflow-api-test",
};

for (const [name, value] of Object.entries(TEST_ENVIRONMENT)) {
  process.env[name] ??= value;
}

import { validateEnvironment } from "./env";

describe("validateEnvironment", () => {
  const required = {
    DATABASE_URL: "postgresql://vendorflow:vendorflow@localhost:5432/vendorflow",
    RABBITMQ_URL: "amqp://vendorflow:vendorflow@localhost:5672"
  };

  it("accepts the worker's actual dependencies", () => {
    expect(validateEnvironment(required)).toMatchObject(required);
  });

  it("requires a RabbitMQ endpoint", () => {
    expect(() => validateEnvironment({ ...required, RABBITMQ_URL: undefined })).toThrow("RABBITMQ_URL");
  });

  it("requires PostgreSQL now that the relay and the consumer are database-backed", () => {
    expect(() => validateEnvironment({ ...required, DATABASE_URL: undefined })).toThrow("DATABASE_URL");
  });

  it("does not require unused Redis configuration", () => {
    expect(() => validateEnvironment(required)).not.toThrow();
  });

  it("defaults to the production retry ladder", () => {
    expect(validateEnvironment(required).CONSUMER_RETRY_DELAYS_MS).toEqual([10_000, 60_000, 300_000]);
  });

  it("parses a shortened retry ladder for tests", () => {
    const environment = validateEnvironment({ ...required, CONSUMER_RETRY_DELAYS_MS: "100, 200" });

    expect(environment.CONSUMER_RETRY_DELAYS_MS).toEqual([100, 200]);
  });

  it("refuses a retry ladder that is not positive integers", () => {
    expect(() => validateEnvironment({ ...required, CONSUMER_RETRY_DELAYS_MS: "100,0" })).toThrow(
      "CONSUMER_RETRY_DELAYS_MS"
    );
  });

  it("refuses a confirm timeout that outlives its own publication lease", () => {
    expect(() =>
      validateEnvironment({
        ...required,
        OUTBOX_LEASE_SECONDS: "5",
        OUTBOX_PUBLISH_CONFIRM_TIMEOUT_MS: "5000"
      })
    ).toThrow("OUTBOX_PUBLISH_CONFIRM_TIMEOUT_MS");
  });
});

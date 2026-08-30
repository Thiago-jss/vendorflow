import { validateEnvironment } from "./env";

describe("validateEnvironment", () => {
  const required = {
    DATABASE_URL: "postgresql://vendorflow:vendorflow@localhost:5432/vendorflow",
    REDIS_URL: "redis://localhost:6379",
    RABBITMQ_URL: "amqp://vendorflow:vendorflow@localhost:5672"
  };

  it("accepts worker infrastructure configuration", () => {
    expect(validateEnvironment(required)).toMatchObject(required);
  });

  it("requires a RabbitMQ endpoint", () => {
    expect(() => validateEnvironment({ ...required, RABBITMQ_URL: undefined })).toThrow("RABBITMQ_URL");
  });
});

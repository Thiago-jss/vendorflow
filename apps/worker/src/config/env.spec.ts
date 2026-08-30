import { validateEnvironment } from "./env";

describe("validateEnvironment", () => {
  const required = {
    RABBITMQ_URL: "amqp://vendorflow:vendorflow@localhost:5672"
  };

  it("accepts the worker's actual RabbitMQ dependency", () => {
    expect(validateEnvironment(required)).toMatchObject(required);
  });

  it("does not require unused database or Redis configuration", () => {
    expect(() => validateEnvironment(required)).not.toThrow();
  });

  it("requires a RabbitMQ endpoint", () => {
    expect(() => validateEnvironment({ ...required, RABBITMQ_URL: undefined })).toThrow("RABBITMQ_URL");
  });
});

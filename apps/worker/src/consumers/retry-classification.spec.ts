import { classifyRetry, completedRetryTiers } from "./retry-classification";

const RETRY_QUEUES = [
  "vendorflow.purchase-request-events.retry.1",
  "vendorflow.purchase-request-events.retry.2",
  "vendorflow.purchase-request-events.retry.3"
];

function death(queue: string, count = 1) {
  return { queue, count, reason: "expired", exchange: "vendorflow.events" };
}

describe("completedRetryTiers", () => {
  it("counts nothing for a first delivery", () => {
    expect(completedRetryTiers(undefined, RETRY_QUEUES)).toBe(0);
    expect(completedRetryTiers({}, RETRY_QUEUES)).toBe(0);
  });

  it("reads the tier from the queue the broker delayed the message in", () => {
    expect(completedRetryTiers({ "x-death": [death(RETRY_QUEUES[0] as string)] }, RETRY_QUEUES)).toBe(1);
    expect(completedRetryTiers({ "x-death": [death(RETRY_QUEUES[1] as string)] }, RETRY_QUEUES)).toBe(2);
    expect(completedRetryTiers({ "x-death": [death(RETRY_QUEUES[2] as string)] }, RETRY_QUEUES)).toBe(3);
  });

  it("keeps escalating when the broker drops earlier entries on republish", () => {
    // RabbitMQ 4 discards a client-supplied x-death, so the second delay arrives carrying only
    // the second retry queue. Reading the tier from the name is what makes that survivable;
    // summing counts would report one completed cycle forever.
    expect(completedRetryTiers({ "x-death": [death(RETRY_QUEUES[1] as string)] }, RETRY_QUEUES)).toBe(2);
  });

  it("takes the furthest tier when a broker does accumulate the array", () => {
    const headers = {
      "x-death": [death(RETRY_QUEUES[0] as string), death(RETRY_QUEUES[1] as string, 2)]
    };

    expect(completedRetryTiers(headers, RETRY_QUEUES)).toBe(2);
  });

  it("ignores dead-letter records from queues that are not retry tiers", () => {
    const headers = {
      "x-death": [death("vendorflow.purchase-request-events", 5)]
    };

    expect(completedRetryTiers(headers, RETRY_QUEUES)).toBe(0);
  });

  it("treats an unreadable x-death as no retries rather than refusing the message", () => {
    expect(completedRetryTiers({ "x-death": "corrupted" }, RETRY_QUEUES)).toBe(0);
    expect(completedRetryTiers({ "x-death": [null, 7] }, RETRY_QUEUES)).toBe(0);
  });
});

describe("classifyRetry", () => {
  it("sends a first failure to the first tier", () => {
    expect(classifyRetry(0, 3)).toEqual({ kind: "retry", tier: 0 });
  });

  it("escalates through the ladder", () => {
    expect(classifyRetry(1, 3)).toEqual({ kind: "retry", tier: 1 });
    expect(classifyRetry(2, 3)).toEqual({ kind: "retry", tier: 2 });
  });

  it("is terminal once the ladder is exhausted (REL-006)", () => {
    expect(classifyRetry(3, 3)).toEqual({ kind: "dead-letter" });
    expect(classifyRetry(9, 3)).toEqual({ kind: "dead-letter" });
  });
});

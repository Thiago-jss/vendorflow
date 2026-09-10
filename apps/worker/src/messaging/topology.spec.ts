import { topologyNames } from "./topology";

describe("topologyNames", () => {
  const names = topologyNames("vendorflow", 3);

  it("declares one exchange per retry tier, so a delayed message keeps its routing key", () => {
    expect(names.retryExchanges).toEqual([
      "vendorflow.events.retry.1",
      "vendorflow.events.retry.2",
      "vendorflow.events.retry.3"
    ]);
    expect(names.retryQueues).toHaveLength(names.retryExchanges.length);
  });

  it("namespaces every object, so a test can declare its own ladder", () => {
    const scoped = topologyNames("test-abc", 2);

    expect(scoped.workQueue).toBe("test-abc.purchase-request-events");
    expect(scoped.deadLetterQueue).toBe("test-abc.purchase-request-events.dlq");
    expect(scoped.retryQueues).toHaveLength(2);
  });

  it("binds by event family rather than by a single event type", () => {
    // Two families, because there are two aggregates. A consumer that cares about purchase
    // orders can bind to purchase_order.# without receiving every request transition, and a
    // new event inside either family needs no topology change at all.
    expect(names.bindingPatterns).toEqual([
      "purchase_request.#",
      "purchase_order.#",
    ]);
  });
});

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * NFR-008: one correlation identifier propagated across the request *and any asynchronous
 * continuation of it*. The outbox is that continuation — the message the worker publishes
 * minutes later has to be attributable to the request that caused it.
 *
 * `AsyncLocalStorage` rather than a request-scoped provider, because the alternative would
 * make every use case that emits an outgoing fact request-scoped, and that cascades through
 * the whole procurement dependency graph to solve a problem that is not a dependency problem.
 * The store follows promise continuations, which is exactly the propagation the requirement
 * describes.
 */
export const CORRELATION_HEADER = "x-correlation-id";

interface CorrelationStore {
  readonly correlationId: string;
}

const correlationStorage = new AsyncLocalStorage<CorrelationStore>();

export function newCorrelationId(): string {
  return randomUUID();
}

export function runWithCorrelationId<T>(
  correlationId: string,
  operation: () => T,
): T {
  return correlationStorage.run({ correlationId }, operation);
}

/**
 * `undefined` outside a bound operation — a unit test, or a future background job that is not
 * a continuation of any request. Callers decide what that means for them rather than being
 * handed a fabricated identifier that looks like it came from somewhere.
 */
export function currentCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}

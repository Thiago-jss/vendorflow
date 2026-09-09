import { z } from "zod";

/**
 * The envelope, and the only thing that crosses the broker.
 *
 * It is deliberately small and closed: identity, version, type, time, tenant provenance,
 * aggregate coordinates, correlation and a scalar payload. There is no actor object, no
 * embedded aggregate, no free text and no envelope extension point, because none of those has
 * a consumer (ADR-003).
 */
export const supportedEventTypes = [
  "PURCHASE_REQUEST_SUBMITTED",
  "PURCHASE_REQUEST_APPROVAL_DECIDED",
] as const;

export type SupportedEventType = (typeof supportedEventTypes)[number];

export const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * The routing key of each event type, written out rather than derived from the enum name. A
 * derivation would silently rename every queue binding the day an enum value is renamed; a
 * table makes that a compile error.
 */
const ROUTING_KEYS: Readonly<Record<SupportedEventType, string>> = {
  PURCHASE_REQUEST_SUBMITTED: "purchase_request.submitted",
  PURCHASE_REQUEST_APPROVAL_DECIDED: "purchase_request.approval_decided",
};

export function isSupportedEventType(
  value: string,
): value is SupportedEventType {
  return supportedEventTypes.some((candidate) => candidate === value);
}

export function routingKeyFor(eventType: SupportedEventType): string {
  return ROUTING_KEYS[eventType];
}

/**
 * Scalars only, mirroring what the API is allowed to write. A payload that arrives with a
 * nested object did not come from this system's outbox and is treated as poison.
 */
const payloadValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

/**
 * `.strict()` for the same reason the HTTP boundary rejects unknown fields (SEC-004): an
 * unexpected property is a signal that something is wrong, not something to ignore. Types are
 * validated structurally here and the *meaning* of `eventType` and `schemaVersion` is checked
 * by the consumer, so an unsupported version is reported as unsupported rather than as
 * malformed.
 */
export const eventEnvelopeSchema = z
  .object({
    eventId: z.string().uuid(),
    schemaVersion: z.number().int().positive(),
    eventType: z.string().min(1),
    occurredAt: z.string().datetime({ offset: true }),
    organizationId: z.string().uuid(),
    aggregateType: z.string().min(1),
    aggregateId: z.string().uuid(),
    correlationId: z.string().uuid(),
    payload: z.record(payloadValue),
  })
  .strict();

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export interface EventEnvelopeSource {
  readonly id: string;
  readonly organizationId: string;
  readonly eventType: SupportedEventType;
  readonly schemaVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
  readonly payload: Record<string, unknown>;
}

export function toEventEnvelope(source: EventEnvelopeSource): EventEnvelope {
  return eventEnvelopeSchema.parse({
    eventId: source.id,
    schemaVersion: source.schemaVersion,
    eventType: source.eventType,
    occurredAt: source.occurredAt.toISOString(),
    organizationId: source.organizationId,
    aggregateType: source.aggregateType,
    aggregateId: source.aggregateId,
    correlationId: source.correlationId,
    payload: source.payload,
  });
}

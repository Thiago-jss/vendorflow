import {
  eventEnvelopeSchema,
  isSupportedEventType,
  routingKeyFor,
  toEventEnvelope
} from "./event-envelope";

const source = {
  id: "6f1b8f34-1f2b-4a1e-9d4b-8f2f2b6f1a11",
  organizationId: "0a2f5f9e-2c3d-4a6b-8c1d-2e3f4a5b6c7d",
  eventType: "PURCHASE_REQUEST_SUBMITTED" as const,
  schemaVersion: 1,
  aggregateType: "PURCHASE_REQUEST",
  aggregateId: "11111111-2222-3333-4444-555555555555",
  correlationId: "99999999-8888-7777-6666-555555555555",
  occurredAt: new Date("2026-09-09T12:00:00.000Z"),
  payload: { status: "SUBMITTED", estimatedTotalCents: "100000", approvalStepCount: 1 }
};

describe("routing keys", () => {
  it("names one key per supported event type", () => {
    expect(routingKeyFor("PURCHASE_REQUEST_SUBMITTED")).toBe("purchase_request.submitted");
    expect(routingKeyFor("PURCHASE_REQUEST_APPROVAL_DECIDED")).toBe(
      "purchase_request.approval_decided"
    );
  });

  it("recognizes only the event types this worker implements", () => {
    expect(isSupportedEventType("PURCHASE_REQUEST_SUBMITTED")).toBe(true);
    expect(isSupportedEventType("PURCHASE_REQUEST_CANCELLED")).toBe(false);
  });
});

describe("toEventEnvelope", () => {
  it("uses the outbox row identity as the event identity", () => {
    expect(toEventEnvelope(source).eventId).toBe(source.id);
  });

  it("serializes the occurrence as an offset-bearing instant", () => {
    expect(toEventEnvelope(source).occurredAt).toBe("2026-09-09T12:00:00.000Z");
  });
});

describe("eventEnvelopeSchema", () => {
  const envelope = toEventEnvelope(source);

  it("accepts what the relay produces", () => {
    expect(eventEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("refuses an unknown field rather than ignoring it", () => {
    expect(eventEnvelopeSchema.safeParse({ ...envelope, extra: "x" }).success).toBe(false);
  });

  it("refuses a nested payload, which this system never produces", () => {
    expect(
      eventEnvelopeSchema.safeParse({ ...envelope, payload: { nested: { a: 1 } } }).success
    ).toBe(false);
  });

  it("refuses a missing identity, tenant or correlation", () => {
    for (const field of ["eventId", "organizationId", "correlationId"] as const) {
      const { [field]: _removed, ...rest } = envelope;

      expect(eventEnvelopeSchema.safeParse(rest).success).toBe(false);
    }
  });
});

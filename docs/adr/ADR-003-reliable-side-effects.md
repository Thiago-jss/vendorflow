# ADR-003 — Reliable Side Effects

## Status

**Accepted**
**Date:** 2026-09-09
**Deciders:** Project owner (acting as Principal Engineer / Architect)
**Supersedes:** —
**Superseded by:** —

## Context

ADR-001 deferred this decision by name: *"Reliable side effects: the transactional outbox, the
publishing path, idempotent consumption, retry and dead-lettering (REL-002…REL-006). This is
the ADR that must justify a message broker with a concrete problem, or decline to introduce
one."* This is that justification.

The requirements that constrain it, and what each one actually forbids:

- **REL-002.** A side effect must not be lost when the transaction commits, and must not fire
  when it rolls back. This rules out both obvious implementations at once.
- **REL-003.** Processing is at-least-once and every consumer is idempotent.
- **REL-006.** Failures are retried with backoff and, on exhaustion, parked for inspection.
  They are never dropped silently and never block the originating transaction.
- **REL-007.** Business decisions keep committing while the notification path is degraded.
- **REL-008.** Readiness distinguishes "process alive" from "dependencies usable".
- **AUD-004.** A business change and its audit event commit together.
- **NFR-008.** One correlation identifier spans the request and its asynchronous continuation.

The characteristics of *this* system that decide the answer:

**C-1 — There is already one transaction, and it already spans three modules.** Phase 7's
submission and Manager decision commit a request transition, an approval-ladder change and an
append-only audit event through one opaque `TransactionScope`. Adding a fourth write to that
transaction costs nothing structural.

**C-2 — There is no consumer of a business side effect yet.** Notifications (FR-062) are in the
MVP but not built, and quotation, ordering and suppliers do not exist. Whatever this ADR builds
has to be provable *today*, without inventing a product capability to hang it on.

**C-3 — PostgreSQL is authoritative and RabbitMQ is transport.** ADR-002 already settled this:
RabbitMQ receives no identity authority, and a consumer treats a message's tenant as
provenance, not as permission.

**C-4 — RabbitMQ is already provisioned and already connected.** Docker Compose runs it and the
worker holds an idle connection with `amqplib` installed. What does not exist is any topology,
publisher, consumer, retry or dead-letter behaviour.

**C-5 — The worker has no database responsibility yet.** ADR-002 explicitly deferred that:
*"when ADR-003 introduces a transactional outbox or a real database-backed job, let the worker
depend on `@vendorflow/database`, require `DATABASE_URL`, and define a trusted system-operation
context."*

**C-6 — Team of one.** Every exchange, queue, table and environment variable is paid for out of
the same budget as feature work.

## Decision

**A transactional outbox in PostgreSQL, owned by `platform`, published by a relay in the worker
using publisher confirms, delivered at-least-once through RabbitMQ, and consumed by consumers
that deduplicate durably before producing any observable effect.**

1. **The intent is a row, not a call.** A business transition that requires an outgoing effect
   inserts one `outbox_messages` row inside the *same* PostgreSQL transaction as its state
   change and its audit event. No broker is contacted there; no network I/O of any kind happens
   inside a transaction that changes business state.

2. **`platform` publishes a capability, not a table.** Business modules call
   `RecordOutgoingEvent` with the `TransactionScope` they already hold. They cannot publish,
   list, inspect or republish, and they do not import Prisma, `amqplib` or any broker type.
   Organization comes from the `TrustedPrincipal` and correlation from the request-bound
   context; neither is accepted as caller input.

3. **The outbox row's UUID is the event identity, end to end.** It is the AMQP `messageId` and
   the consumer's deduplication key. There is no second event identifier.

4. **The relay lives in the worker**, which now depends on `@vendorflow/database` and requires
   `DATABASE_URL`. The API never imports `amqplib`; a lint rule enforces it.

5. **Claim, publish, record — three separate steps.** A short transaction claims rows with
   `SELECT … FOR UPDATE SKIP LOCKED` and takes a time-boxed lease; the claim commits *before*
   any broker I/O; the publication waits for a confirm with no transaction open; a second short
   transaction records the publication under a predicate proving the lease is still ours.

6. **Ambiguity is never success.** A confirm timeout, a nack, an unroutable `mandatory` return
   or a closed channel leaves the row eligible. A crash between confirm and record produces a
   duplicate, never a loss. That is what makes delivery at-least-once (REL-003).

7. **Two dead-letter destinations, because there are two failure domains.** A publication that
   exhausts its attempts becomes a durable `FAILED` row in PostgreSQL — when the broker is the
   thing that is broken, there is nowhere else to put it. A *consumption* that exhausts its
   attempts reaches a RabbitMQ dead-letter queue.

8. **Retry is a real ladder: 10s → 60s → 300s → terminal DLQ.** One retry exchange and one TTL
   queue per tier. The tier is chosen from RabbitMQ's own `x-death` dead-letter bookkeeping —
   specifically from *which retry queue* delayed the message, not from a running total — because
   a counter the consumer maintained would only be correct while the consumer was. See
   [Correction](#correction-x-death-does-not-survive-a-client-republish) below.

9. **Two event types, chosen because they already exist.** `purchase_request.submitted` and
   `purchase_request.approval_decided`. No generic event bus, no universal schema, no registry.

10. **The first consumer is infrastructure, not product.** `outbox-delivery-recorder` writes a
    durable receipt keyed `(consumer, event_id)`. It proves durable idempotency, tenant
    validation, bounded retry and terminal dead-lettering without inventing Notifications.

11. **Readiness is split.** The worker gains HTTP liveness and readiness; readiness requires
    PostgreSQL *and* a usable broker. The API's readiness is unchanged and deliberately does not
    consult RabbitMQ (REL-007).

## Alternatives Considered

### A — Publish after the commit, from the use case

Zero new tables, zero new moving parts, and it is what most systems do first.

**Rejected** because it loses the effect in exactly the window REL-002 names: the process dies
between `COMMIT` and `publish`, the business change is durable and its consequence is gone.
There is no retry to schedule, because nothing durable records that anything was owed. The
failure is silent, and it is invisible in every test that does not kill a process.

### B — Publish inside the transaction

**Rejected** for the mirror-image reason, plus two others. A rollback after a successful publish
announces a fact that does not exist. It puts a network round trip under a row lock. And it
makes broker availability decide whether a purchase decision commits, which contradicts C-3 and
REL-007 directly.

### C — Change Data Capture from the write-ahead log (Debezium)

Removes the relay entirely and gives strong ordering.

**Rejected** on C-6. It requires Kafka Connect or an equivalent runtime, replication slots, and
operational familiarity with a second distributed system. It also promotes the physical schema
to a published contract, which is a large commitment to make while the domain is still moving
(ADR-001, C-6).

### D — `LISTEN`/`NOTIFY` as the transport, with no broker

Attractive because it needs nothing new.

**Rejected** because `NOTIFY` is not durable: a disconnected listener loses the notification
outright, so a durable store and a polling fallback would be needed anyway — at which point the
notification is an optimization, not a transport. It also offers no queue semantics, no
consumer acknowledgement, no retry with backoff and no dead-letter destination, which are three
quarters of REL-006.

**Retained as a future optimization** for waking the relay sooner than its poll interval.

### E — A single fixed-TTL retry queue

Half the objects of the chosen ladder.

**Rejected** because a single fixed delay is not backoff, and calling it backoff would be
dishonest. Per-message TTL in one queue is the usual workaround and is worse: TTL expiry is
evaluated at the head of the queue, so one long-delayed message blocks every shorter-delayed
message behind it.

### F — Transactional outbox with a broker relay (chosen)

Keeps the single transaction (C-1), needs no product consumer to be correct (C-2), keeps
PostgreSQL authoritative (C-3), uses the process and dependency that already exist (C-4),
discharges the deferral in ADR-002 (C-5), and costs two tables, ten topology objects and one
relay loop (C-6).

## Correction: `x-death` does not survive a client republish

The first implementation of point 8 summed the `count` fields of every `x-death` entry naming
one of this worker's retry queues, on the assumption that the array accumulates across passes.
It does not, on RabbitMQ 4. Verified directly against the broker:

```text
after retry.1  x-death: [{count:1, reason:"expired", queue:"probe.retry1", …}]
after retry.2  x-death: [{count:1, reason:"expired", queue:"probe.retry2", …}]
```

The first entry is gone. When a *client* publishes a message carrying an `x-death` header, the
broker discards it; the array is rebuilt from the broker's own state, which for a freshly
published message is empty. Summing counts therefore reports "one completed cycle" forever, and
a message loops on the second tier until something else stops it.

The tier is now read from **the retry queue's name**, which makes each pass self-describing and
depends only on the single entry the broker does keep. The highest tier named wins, so the
reading is also correct on a broker that accumulates the array. Terminal messages additionally
carry an explicit `x-vf-completed-retry-tiers` header, because the same discard means a
dead-lettered message would otherwise not record how far the ladder got.

This is recorded rather than quietly fixed: the mechanism is a property of the broker version,
and anyone changing the ladder needs to know it was measured, not assumed.

## Consequences

**Positive**

- No business transition can fail, block or roll back because a broker is unavailable.
- Duplicates are a designed-for event with a named mechanism, not a latent bug.
- The state of every outgoing fact is a SQL query. "What did not get published, and why" has an
  answer an operator can type.
- The worker gains its first real responsibility, and its readiness now means something.
- One correlation identifier now spans the HTTP request, the outbox row, the message and the
  consumer's log line.

**Negative**

- **At-least-once is contagious.** Every future consumer must deduplicate durably. A consumer
  that forgets is a correctness defect, not a style problem, and nothing in the type system
  catches it.
- **No ordering guarantee**, neither global nor per aggregate. Parallel batches, leases and
  retries all reorder. Consumers must be order-independent; a consumer that needs ordering needs
  a different design, not a configuration change.
- **Latency** of up to one poll interval between commit and publication.
- **Two operational tables that grow.** No retention job exists yet (see below).
- **The outbox is mutable and the audit trail is not.** They look similar and are opposite in
  this one respect. The migration documents it and a test asserts it, because conflating them
  would either break the relay or weaken AUD-003.

## Trade-offs

| Accepted trade-off | Benefit | Revisit when |
| --- | --- | --- |
| Duplicates instead of lost intents | REL-002 and REL-003 hold under process death at any point | Never on this basis. Exactly-once delivery is not available; exactly-once *effect* is what the receipt provides |
| Polling instead of `LISTEN`/`NOTIFY` | One code path, correct with or without a live connection | Publication latency becomes a stated requirement |
| One global claim order instead of per-tenant fairness | One index, one query, no scheduler | One tenant's burst measurably delays another's |
| Fixed three-tier ladder instead of per-consumer policy | Bounded, explicit, inspectable | A consumer appears whose failures have a genuinely different recovery profile |
| Infrastructure consumer instead of a product one | The contract is proven before anything depends on it | Notifications (FR-062) arrive and replace the effect, keeping the deduplication |
| No retention job | Nothing is deleted by a job nobody has reviewed | Table growth becomes measurable, or personal-data retention is defined (§ 12.7 of the requirements) |

## Security Invariants

1. Organization identity in an event is **trusted internal provenance**, never authorization.
   The producer derives it from the `TrustedPrincipal`; the consumer validates it against the
   persisted row by `(organization_id, id)` before touching tenant data, and dead-letters a
   mismatch without writing anything.
2. Payloads carry identifiers, enums, counts and money as digit strings. They never carry
   access tokens, refresh tokens, passwords, cookies, request bodies, justifications, approval
   reasons, names or email addresses. A consumer that needs those reads PostgreSQL under a
   tenant-scoped query.
3. Diagnostics stored on a failed row and written to logs are the error message only, truncated,
   and never a payload, a stack trace or a connection URL.
4. The relay's cross-tenant claim is a separately named trusted system operation. It reads no
   business data. A tenant-scoped product repository never gains an unscoped overload.
5. Correlation identifiers are generated server-side. A client-supplied correlation header is
   ignored, because it would otherwise reach durable storage and every log line.
6. RabbitMQ remains outside the trust boundary for authorization. Nothing a message says can
   change a Purchase Request's state, a tenant relationship or a permission.

## Compliance

This ADR is satisfied when:

1. A rolled-back business transaction leaves no outbox row, no audit event and no message.
2. A committed submission or winning decision leaves exactly one outbox row.
3. No PostgreSQL transaction that changes business state performs broker I/O.
4. Nothing outside `apps/worker` imports `amqplib`, and no business module imports the outbox
   tables.
5. A duplicate delivery produces no second observable effect.
6. A consumer acknowledges only after its transaction commits, and only on the channel that
   delivered the message. A delivery whose channel has closed is left for redelivery rather
   than settled on a replacement.
7. An exhausted publication is a durable `FAILED` row; an exhausted consumption is in the DLQ.
8. Worker readiness fails when either PostgreSQL or RabbitMQ is unusable, and API readiness does
   not consult RabbitMQ.

Violations are defects against this ADR, not stylistic preferences.

## Explicitly Not Decided Here

- **Client idempotency keys (REL-004).** Still deferred. The outbox guarantees one intent per
  winning transition; REL-004 solves a different problem — returning the original response to a
  retried client request — and is not a prerequisite for any of the above.
- **Notifications (FR-062, FR-063).** The consumer this ADR builds is infrastructure. The
  product capability is a later phase that inherits a proven idempotency contract.
- **Outbox retention.** Documented as an operational follow-up, with no foreign key standing in
  its way.
- **Tenant fairness in publisher scheduling.** Documented as an operational follow-up.
- **Ordering guarantees.** Deliberately not offered.

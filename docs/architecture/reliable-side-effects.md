# Reliable Side Effects

**Status:** Implemented
**Last updated:** 2026-09-09
**Scope:** the transactional outbox, the worker relay, the RabbitMQ topology, the idempotent
consumer, retry and dead-lettering

This document makes [`ADR-003`](../adr/ADR-003-reliable-side-effects.md) concrete. It is the
companion to [`approval-workflow.md`](./approval-workflow.md), which remains the reasoning for
the transitions that now emit outgoing facts.

It does **not** introduce Notifications, email, push, websockets, quotation, suppliers,
purchase orders, client idempotency keys or any user interface. Every one of those is named in
[Deliberately deferred](#deliberately-deferred) rather than approximated.

## The pipeline

```text
┌─ apps/api ──────────────────────────────────────────────────────────────────┐
│  one PostgreSQL transaction                                                 │
│    request transition  ─┐                                                   │
│    approval ladder      ├─ commit together, or none of them (REL-001)       │
│    audit event          │                                                   │
│    outbox_messages row ─┘  status PENDING, attempt_count 0                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                   │  no broker contact anywhere above
┌─ apps/worker ─────────────────────▼─────────────────────────────────────────┐
│  1. claim   short transaction: FOR UPDATE SKIP LOCKED + lease, then COMMIT  │
│  2. publish no transaction open: confirm channel, mandatory, persistent     │
│  3. record  short transaction: PUBLISHED, under a lease-ownership predicate │
└─────────────────────────────────────────────────────────────────────────────┘
                                   │
                         vendorflow.events (topic)
                                   │
                  vendorflow.purchase-request-events
                                   │
┌─ apps/worker ─────────────────────▼─────────────────────────────────────────┐
│  one PostgreSQL transaction                                                 │
│    validate (organization_id, id) against the committed row                 │
│    INSERT receipt  ← the deduplication claim                                │
│    observable effect                                                        │
│  COMMIT, then ack — in that order, always                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

The three-step split in the worker is the whole design. Step 1 commits before any network
contact, so no PostgreSQL transaction is ever held open across a broker round trip. The gap
between steps 2 and 3 is where at-least-once lives, and the consumer's receipt is what makes
that gap safe.

## What is emitted, and what is not

| Transition | Event type | Routing key |
| --- | --- | --- |
| `DRAFT → SUBMITTED` | `PURCHASE_REQUEST_SUBMITTED` | `purchase_request.submitted` |
| Manager approves or rejects | `PURCHASE_REQUEST_APPROVAL_DECIDED` | `purchase_request.approval_decided` |

Cancellation emits nothing. No downstream actor is waiting on it, and it exercises no failure
mode the two above do not.

The payload is deliberately narrower than the audit payload next to it. Both describe the same
decision; only one of them leaves the process.

| Carried | Never carried |
| --- | --- |
| Identifiers, enums, counts | Justification text, approval and rejection reasons |
| Money as digit strings (BR-031) | Names, email addresses |
| Correlation identifier | Tokens, cookies, request bodies |

A consumer that needs a rejection reason reads it from PostgreSQL under a tenant-scoped query.
It does not receive it on a queue.

## The envelope

```jsonc
{
  "eventId": "…",          // outbox_messages.id: AMQP messageId and deduplication key
  "schemaVersion": 1,
  "eventType": "purchase_request.approval_decided",
  "occurredAt": "2026-09-09T12:34:56.789Z",
  "organizationId": "…",   // provenance to validate, never authority to act on
  "aggregateType": "PURCHASE_REQUEST",
  "aggregateId": "…",
  "correlationId": "…",
  "payload": { /* scalars only */ }
}
```

There is one identity, not two: the outbox row's UUID *is* the event identity, the AMQP
`messageId` and the deduplication key. Schema validation is strict — an unknown field is a
signal, not something to ignore (SEC-004).

## Storage

Two tables, both tenant-owned, both **mutable operational state**. Neither carries the
append-only trigger `audit_events` has, and the migration says so explicitly: the relay rewrites
status, lease and attempt columns for the life of a row. The audit trail is history; the outbox
is transport bookkeeping.

`outbox_messages` makes its own lifecycle a database invariant rather than a relay convention:

| Status | What PostgreSQL enforces |
| --- | --- |
| `PENDING` | no lease, no publication timestamp |
| `PUBLISHING` | a lease owner *and* an expiry, no publication timestamp |
| `PUBLISHED` | a publication timestamp, no lease |
| `FAILED` | no lease, no publication timestamp, and not claimable |

A relay bug is therefore a failed statement, not a message that is silently never published
again.

`outbox_consumer_receipts` is keyed `(consumer, event_id)`. That primary key *is* the
idempotency mechanism. It holds no foreign key to `outbox_messages`: `RESTRICT` would make every
receipt a reason its outbox row can never be pruned, and `CASCADE` would delete the proof that
something was already processed. The consumer validates the originating row by
`(organization_id, id)` instead, which is also what makes a forged tenant detectable.

### Indexes

The claim index is the one index in this repository that does not lead with `organization_id`.
It serves a trusted cross-tenant infrastructure sweep and never a product query, and the
separately named claim operation is its only caller. The investigation indexes are
tenant-leading as usual.

## Concurrency

Claiming uses **both** `SELECT … FOR UPDATE SKIP LOCKED` **and** a lease, because they solve
different problems:

- `SKIP LOCKED` settles contention *at the moment of claiming*. Two relays never select the same
  row; the second skips it.
- The lease settles what `SKIP LOCKED` cannot: a relay that dies *after* claiming. Holding the
  selecting transaction open across the publication would also solve that, at the price of an
  open PostgreSQL transaction for the duration of a round trip to a broker that may be
  unreachable.

`OUTBOX_PUBLISH_CONFIRM_TIMEOUT_MS` must be shorter than `OUTBOX_LEASE_SECONDS`, and the
environment schema refuses to boot otherwise. If a merely slow publication outlived its lease,
the system would manufacture duplicates it did not have to.

Recording a publication is predicated on still owning the lease. A relay whose lease was taken
over cannot overwrite the state of the relay that took it.

## RabbitMQ topology

```text
                  publish (topic, routing key = event type)
  relay ───────────────────► vendorflow.events ──► vendorflow.purchase-request-events
                                    ▲                          │ consumer failure
                 TTL expiry ────────┘                          ▼
  vendorflow.events.retry.1 ──► …retry.1 queue   (10s)  ──┐  republish to the next tier
  vendorflow.events.retry.2 ──► …retry.2 queue   (60s)  ──┼───────────┘
  vendorflow.events.retry.3 ──► …retry.3 queue  (300s)  ──┘
                                                            exhausted / poison
  vendorflow.events.dlx ─────► vendorflow.purchase-request-events.dlq ◄────────┘
```

**One exchange per retry tier, not one retry exchange with tier-specific routing keys.** A
dead-lettered message keeps the routing key it was published with unless its queue overrides it.
A shared retry exchange would either return messages to the main exchange under a key nothing is
bound to, or force a fixed override that destroys the event's real routing key for every
consumer that comes later.

**The work queue dead-letters to the terminal exchange, not to a retry tier.** Retrying is a
decision the consumer makes and executes by republishing. The queue's own dead-letter route is
the backstop for what the consumer never got to decide, and sending those into a retry loop
would hide them.

**The tier is read from `x-death`, and specifically from the queue named in it.** RabbitMQ writes
a dead-letter record naming the queue a message expired out of. The tier's position in the ladder
is its identity, so one pass through `…retry.2` means two delays have been served. A counter the
consumer incremented itself would only be correct while the consumer was: a process that died
between republishing and acknowledging would replay its own count, and one that died before
writing it would reset the ladder to zero and retry forever.

Summing the `count` fields instead — the obvious reading — does not work, and this was measured
rather than assumed. RabbitMQ 4 discards a client-supplied `x-death` when a message is published
again, so after a second delay the header contains only the second retry queue's entry:

```text
after retry.1  x-death: [{count:1, reason:"expired", queue:"probe.retry1", …}]
after retry.2  x-death: [{count:1, reason:"expired", queue:"probe.retry2", …}]
```

A running total therefore stays at one and the message loops on tier two forever. Reading the
queue name depends only on the entry the broker does keep. For the same reason a dead-lettered
message carries an explicit `x-vf-completed-retry-tiers` header: without it the terminal queue
would not record how far the ladder got.

`requeue: true` appears nowhere in the worker. An immediate requeue is a hot loop with no
backoff, which is the failure REL-006 exists to prevent.

## Settlement is bound to the channel that delivered

An AMQP delivery tag is a per-channel number, not a message identifier. Tag 7 on a channel that
has since closed is not "that event": on the replacement channel it is whatever that channel
delivered seventh, or nothing at all.

That matters here because the consumer is asynchronous by design — it acknowledges only after a
PostgreSQL transaction commits, and a transaction easily outlives a connection blink. So the
messaging layer hands the handler a `ConsumerDelivery`: the message together with the only two
settlements allowed on it, captured at delivery time and bound by closure to the exact channel
and its liveness. There is no "acknowledge this message" call that resolves a channel later,
because such a call could only resolve the *current* one.

A delivery whose channel has closed is not settled at all. The broker already requeued
everything left unacknowledged when the channel died, so the message returns on its own, and
the receipt absorbs it. For the same reason the consumer does not republish to a retry tier or
to the dead-letter exchange once its delivery is unsettleable: the republished copy plus the
broker's own redelivery would be two, where redelivery alone is one and reaches the same verdict.

## Failure behaviour

| Situation | What happens |
| --- | --- |
| Business transaction rolls back | No audit event, no outbox row, no message. The insert shares the fate of the compare-and-swap before it |
| API dies just after commit | The row is `PENDING` and is published on a later sweep |
| Broker unreachable | The relay claims **nothing**, so no attempt is spent on an outage the messages had nothing to do with. The API keeps committing decisions |
| Confirm times out, is nacked, or the channel closes | Treated as ambiguous, which means *not published*. The row stays eligible; a duplicate is possible, a loss is not |
| Message is unroutable (`mandatory` return) | A publication nobody can receive is a topology defect. Retried with backoff, and `last_error` says so |
| Relay dies between confirm and record | The lease expires, another relay republishes, the consumer's receipt absorbs the duplicate |
| Relay's lease is taken over mid-publication | Recording is refused; the row belongs to the new owner. Logged, because a steady stream means the lease is too short |
| Publication attempts exhausted | `FAILED`, durable, indexed, never claimed again. An operator decides |
| Event type or schema version the relay cannot publish | `FAILED` on the first attempt. Another try would reach the same conclusion |
| Duplicate delivery | The receipt insert finds the row already there. No second effect, acknowledged normally |
| Consumer transient failure | Republished to the next retry tier with the original headers, so `x-death` keeps accumulating |
| Consumer failures exhausted | Published to the dead-letter queue with `x-vf-failure-reason: retries-exhausted` and `x-vf-completed-retry-tiers` |
| Unparseable body, unknown schema version, unknown event type | Terminal on first delivery. Retrying a broken contract three times reaches the same answer three times |
| Envelope names an event that no committed row produced, or a different organization | Terminal, with nothing written. The tenant on a message is provenance to validate, not authority to act on |
| Broker refuses even the republish | Rejected without requeue, so the work queue's own dead-letter route carries it to the DLQ |
| Connection lost while a consumer transaction is running | Nothing is settled and nothing is republished: the delivery tag died with its channel. The broker redelivers, and the receipt absorbs it |

## Correlation

`pino-http`'s default request identifier was a per-process counter: it cannot identify a request
across a restart, across two API instances, or in the row a request leaves behind. It is now a
UUID, generated server-side, bound to the request through `AsyncLocalStorage`, echoed as
`x-correlation-id`, and persisted on the outbox row.

`AsyncLocalStorage` rather than a request-scoped provider, because the alternative makes every
use case that emits an outgoing fact request-scoped, cascading through the whole procurement
dependency graph to solve something that is not a dependency problem.

A client-supplied correlation header is ignored. It would otherwise reach durable storage and
every log line as attacker-controlled text, and nothing needs a client to choose it.

## Health and readiness (REL-008)

| Process | Liveness | Readiness |
| --- | --- | --- |
| API | unchanged | unchanged: PostgreSQL only. **Not** RabbitMQ — decisions must keep committing while the side-effect path is degraded (REL-007) |
| Worker | process is up | PostgreSQL healthy **and** a usable broker connection |

The worker does not exit when the broker drops. It reconnects with a delay and reports itself
unready meanwhile. A worker that crash-loops on a broker blink is a worse outage than the blink,
and the outbox it drains is perfectly safe in PostgreSQL in the meantime.

## Verification

Unit tests, no infrastructure: the backoff curve including its jitter floor, `x-death` tier
classification including the republish-discard case, the envelope schema and its strictness, topology naming, and environment
validation including the confirm-timeout-versus-lease rule.

PostgreSQL-real, through the API (`apps/api/test/integration/outbox-persistence.integration.spec.ts`):
one row per submission with the request's coordinates; the correlation identifier the caller was
given; one row per decision, with the rejection reason present in the audit trail and absent
from the message; a lost race leaving no second row; a refused decision leaving nothing; a
foreign manager leaving nothing; cross-tenant reads returning nothing; every lifecycle CHECK
constraint rejecting an invalid state; and the outbox accepting an `UPDATE` that `audit_events`
refuses.

PostgreSQL **and** RabbitMQ-real (`apps/worker/test/integration/outbox-pipeline.integration.spec.ts`):
publication with confirms and the message properties that carry identity; two relays never
claiming the same row; recovery of a lease from a relay that died; refusal to record under a
stolen lease; an unroutable publication retried with backoff; exhaustion parked as `FAILED` and
not re-claimed; a receipt per delivery; a duplicate delivery absorbed; a forged tenant
dead-lettered with nothing written; poison dead-lettered without entering the ladder; a
transient failure recovering on a later tier with `deliveryCount` proving it; the full ladder
escalating through all three retry queues before the DLQ; and a broker outage spending no retry
budget.

The retry ladder is configurable specifically so the last of those can run: a test cannot wait
370 seconds to prove that RabbitMQ can count to three.

## Deliberately deferred

| Deferred | Why, and what it waits on |
| --- | --- |
| Notifications, in-app or otherwise (FR-062, FR-063) | The consumer here is infrastructure. The product capability is a later phase and inherits an idempotency contract that is already proven |
| Client idempotency keys (REL-004) | Still a different problem: returning the *original response* to a retried client request. The outbox guarantees one intent per winning transition and is not a prerequisite for it |
| Outbox retention and archival | Nothing is deleted by a job nobody has reviewed. No foreign key stands in the way of adding one |
| Per-tenant fairness in the claim scan | One index, one query, no scheduler. Revisited when one tenant's burst measurably delays another's |
| Ordering guarantees | Not offered, neither global nor per aggregate. Consumers must be order-independent |
| `LISTEN`/`NOTIFY` to wake the relay | Polling is correct with or without a live connection. This is latency work, and latency is not yet a stated requirement |
| Per-consumer retry policy | One ladder, until a consumer appears whose failures recover differently |
| Publishing outside the trust boundary | Every queue here is internal. An externally consumable queue is a separate trust-boundary decision (ADR-002) |

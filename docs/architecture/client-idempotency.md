# Client Idempotency

**Status:** Implemented (Phase 9)
**Last updated:** 2026-09-10
**Requirements:** REL-004, REL-001, MT-002, MT-003, SEC-004, SEC-009, AUD-004
**Related:** ADR-002 (multi-tenant data isolation), ADR-003 (reliable side effects)

REL-004: *"Client-initiated operations that create durable artifacts — submission, approval
decision, quote selection, purchase order issuance — accept an idempotency key so that a retried
request cannot produce a duplicate."*

This document records what "cannot produce a duplicate" was taken to mean, and the decisions that
would be expensive to change later.

---

## 1. Four operations, and no generic facility

`IdempotentOperation` names exactly the four operations the requirement names. There is
deliberately no "make any request idempotent" middleware.

An idempotency record is a **promise that a retry produces no second effect**, and that promise
can only be kept where the effect is a single transaction whose semantic outcome can be described
in a few scalars. A generic wrapper would extend the promise to operations that cannot keep it —
anything spanning two transactions, anything whose result is unbounded — and a promise that is
sometimes false is worse than none.

Supplier deactivation is the instructive counter-example: it is a durable client operation and it
is *not* on the list, because REL-004 does not name it and it does not need to be. Its conditional
write is naturally at-most-once, and a retry of a completed deactivation is a stated 409 rather
than a duplicated effect.

---

## 2. What the key is, and what is stored

The `Idempotency-Key` header is an **opaque bounded token**: 8 to 200 printable non-whitespace
characters. It is never parsed, only compared.

Requiring a UUID would buy nothing and would refuse perfectly good keys, such as a request
identifier from the caller's own tracing system. What is enforced is what matters: it is present,
it is bounded, and it carries no whitespace or control characters that could be smuggled into a
log line or a header echo.

**The raw key is never persisted, logged or echoed.** `hashIdempotencyKey` validates and digests
in one step, because there is no legitimate use for a validated raw key: the caller needs the
digest, and every extra place the raw value travels is a place it can be logged. A refusal names
the rule and never the submitted token.

An `idempotency_records` row holds:

| Column | Contents |
| --- | --- |
| `organization_id`, `actor_id`, `operation` | the uniqueness boundary, with the digest below |
| `idempotency_key_hash` | SHA-256 of the key, `BYTEA`, CHECKed at 32 bytes |
| `request_fingerprint` | SHA-256 of the normalized semantic request |
| `outcome` | a bounded scalar map, enough to replay the semantic result |

It holds **nothing else**: no request body, no Authorization header, no cookie, no token, no
password, no free-text reason or rationale, no fiscal identifier, no name, no email address, no
phone number.

---

## 3. The fingerprint is the intent, not the spelling

`fingerprintSemanticRequest` digests the organization, the actor, the operation and a list of
parts the use case supplies **after** validation and normalization. So a body whose fields
arrived in a different order or with different surrounding whitespace produces the same
fingerprint, while a genuinely different intent produces a different one.

Route resource identifiers are parts: selecting quote A and selecting quote B are different
requests even under one key.

**Free text is a part, and is stored nowhere.** A rejection reason and a selection rationale
change the outcome — they are recorded in the audit trail — so they must change the fingerprint.
A digest is how that happens without the text ever being persisted in the record.

Every part is length-prefixed as well as separated, so no arrangement of parts can be rewritten
into a different arrangement with the same digest.

### What is deliberately *not* in the fingerprint

The identifier of the approval step being decided. It changes the moment the decision commits,
so including it would make every legitimate replay look like a different request. The intent is
*"decide this request, this way, for this reason"*, and that is what is hashed.

---

## 4. The order of operations is the design

```
1. hash the key, build the fingerprint          → 400 on a malformed key, before anything else
2. look for a committed record
     fingerprint matches   → replay
     fingerprint differs   → 409, fail closed
3. open the business transaction
     reserve first          → a concurrent same-key call blocks here and loses
     run the business logic
     record the outcome     → same transaction
4. on a lost reservation, re-read the winner and replay
```

**Reserve first, inside the transaction.** A concurrent call carrying the same key blocks on the
unique index before doing any work, and loses. It never reaches the business logic, so there is
no duplicate audit event, no second outbox row and no second allocated purchase order number to
undo.

**The pre-check in step 2 is a fast path and a better error, never the authority.** The unique
constraint in step 3 is the authority.

**Failing closed on a changed fingerprint is not a convenience.** Replaying the first answer
would tell the caller that something happened which did not; executing the second would defeat
the key. Neither is acceptable, so it is a conflict and the caller must choose a new key for a
new intent.

### Why the state check moved inside the transaction

A retry of a submission necessarily arrives at a request that is no longer a `DRAFT`. A retry of
an approval decision necessarily arrives after the rung it decided has been decided. If the
state check ran *before* consulting the key, every legitimate retry would answer 409 — which is
precisely the case the key exists to make safe.

So the state-dependent checks live inside the wrapped operation. Everything they refuse — a 404,
a 403, a 409 — rolls the reservation back with it, which means **a refused call consumes no
key**: a caller who probes a foreign identifier can still use that key for a real request.

Capability checks that depend only on the principal stay in front of the wrapper, because they
need no read and disclose nothing.

---

## 5. Two database invariants

**The uniqueness boundary is complete.**
`UNIQUE (organization_id, actor_id, operation, idempotency_key_hash)` — a record is never shared
across users, tenants or operations. Two people presenting the same key are two operations, and
one of them must never replay the other's answer.

**A committed record is always replayable.** The reservation is written before its outcome, so a
row exists mid-transaction with `outcome` and `completed_at` null. A `DEFERRABLE INITIALLY
DEFERRED` constraint trigger refuses at `COMMIT` to keep a reservation that never completed.

The trigger **re-reads the row** rather than trusting `NEW`. A deferred constraint trigger fires
at commit with the row as it looked when the statement that queued the event ran — which for a
reservation is always the incomplete version. What has to hold at `COMMIT` is a property of the
row as it will actually be committed.

Together these mean an "in-flight" record is never observable: a concurrent reader either sees
nothing, or sees a completed record.

---

## 6. Retention is not implemented, and that is a stated limitation

Records accumulate. Nothing deletes them, and this phase deliberately does not build a retention
worker.

The honest reasons:

- A retention policy is a product decision — *how long may a client retry?* — and no requirement
  states one. Guessing at it would bake an arbitrary number into a table that is expensive to
  reason about later.
- Deleting a record makes its key usable again. A retention job is therefore a **correctness**
  mechanism, not a cleanup one, and it deserves its own design rather than being appended here.

What the table is prepared for: `(organization_id, created_at)` is indexed, so a retention job can
find expired rows by tenant without a full scan, and each row is small — two 32-byte digests and a
handful of scalars — so the growth rate is bounded by write volume rather than by payload size.

At the design target of 50,000 purchase requests per organization, the four durable operations
produce on the order of 10⁵ rows per tenant. That is not a problem worth solving before the policy
that governs it exists.

---

## 7. What the outcome is for

The stored outcome identifies **what happened**, so a replay can re-read it through the same
authorized path the first caller used. It is not a cached response.

That distinction matters: a replay performs the same tenant- and ownership-scoped read the
original call's authorization passed, so a retry can never see anything the first request could
not — and it writes nothing. No second decision, no second transition, no second audit event, no
second outbox row, no second allocated number.

| Operation | Outcome |
| --- | --- |
| submission | request identifier, resulting status, approval flow identifier |
| approval decision | request identifier, resulting status, step identifier, decision |
| quote selection | request identifier, quote identifier, resulting status, next responsibility |
| purchase order issuance | order identifier, number, request identifier, resulting status |

A purchase order **number** is in there and is not sensitive: it is the identifier a person will
use to talk about the order.

---

## 8. HTTP contract

`Idempotency-Key` is required on:

| Route | |
| --- | --- |
| `POST /purchase-requests/{id}/submit` | FR-023 |
| `POST /purchase-requests/{id}/approval-decision` | FR-031, FR-034 |
| `POST /purchase-requests/{id}/quotes/{quoteId}/select` | FR-044 |
| `POST /purchase-orders` | FR-050 |

| Situation | Answer |
| --- | --- |
| header absent, or outside 8–200 printable non-whitespace characters | **400** |
| same key, same semantic request | **200/201**, replayed |
| same key, different semantic request | **409** |
| concurrent same key | one committed outcome, one replay |
| the wrapped operation refused (404/403/409/422) | that status, and the key stays usable |

The translation lives in one place — `platform/idempotency/infrastructure/http/idempotency-http.ts`
— because a mapping copied into four controllers is four chances for one of them to answer
differently, and for a header a client retries on that would be a genuinely confusing
inconsistency.

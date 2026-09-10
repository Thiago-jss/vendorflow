# Approval Workflow and Audit Trail

**Status:** Implemented
**Last updated:** 2026-09-06
**Scope:** ApprovalFlow, ApprovalStep, the BR-001 policy, the Manager decision, and the
append-only AuditEvent

This document makes the `approval` and `audit` modules of ADR-001 concrete, and explains the
one transaction that ties them to `procurement`. It is the companion to
[`procurement-domain-foundation.md`](./procurement-domain-foundation.md), which remains the
reasoning for the request itself.

It does **not** introduce quotation, purchasing or finance decisioning, quote-triggered
re-evaluation, per-tenant policy, an audit query surface, idempotency keys, the outbox,
RabbitMQ, notifications or any user interface. Every one of those is named in
[Deliberately deferred](#deliberately-deferred) rather than approximated.

## Model

```text
Organization (tenant)
  └─ PurchaseRequest
       └─ ApprovalFlow            exactly one per request, materialized at submission
            └─ ApprovalStep       sequence, role, state, evaluated amount, decision facts
  └─ AuditEvent                   append-only, ordered per (organization, aggregate)
```

An ApprovalFlow belongs to exactly one PurchaseRequest and a PurchaseRequest has at most one
flow — a `UNIQUE (organization_id, purchase_request_id)`, not a convention. BR-003 will
*extend* that flow when a selected quote lands in a higher tier; it will not create a second
one.

An ApprovalStep belongs to exactly one flow and carries its request's identifier as well. That
denormalization is deliberate: it lets the steps of a request be read and written without
joining through the flow, and the composite foreign key
`(organization_id, approval_flow_id, purchase_request_id) → approval_flows(organization_id, id, purchase_request_id)`
is what stops the two from ever disagreeing. PostgreSQL, not application code, refuses a step
that names a different request than its own flow.

An AuditEvent has no foreign key to its aggregate. It is polymorphic by design (AUD-002 asks
for an aggregate *type* and identifier), and a `RESTRICT` foreign key to every future aggregate
would make the audit trail a reason a business row cannot be deleted. Its tenant and its actor
*are* foreign keys, so an event attributed to another organization's user is rejected by the
database.

## BR-001, in centavos

The policy is a pure function of one amount, in
`approval/application/support/approval-policy.ts`. It imports nothing and no part of the
workflow knows how it reaches its answer — which is the isolation § 12.1 of the requirements
asks for, so the policy can become tenant-owned data later without the workflow changing.

| Amount (centavos) | Required steps, in order |
| --- | --- |
| `0n … 100_000n` | MANAGER |
| `100_001n … 500_000n` | MANAGER → PURCHASING |
| `500_001n …` | MANAGER → PURCHASING → FINANCE |

`100_000n` is R$ 1,000.00 and `500_000n` is R$ 5,000.00. Both bounds are **inclusive**, which
is assumption A-1: the brief left the amounts between "up to 1,000" and "1,001 through 5,000"
undefined, and continuous intervals with an inclusive upper bound is the reading taken.

The comparisons are `bigint` comparisons against `bigint` literals. There is no `Number`, no
division and no float anywhere in the file, so "one centavo over the boundary" is a distinction
the types can actually express — and the unit tests pin exactly `100000`, `100001`, `500000`
and `500001`.

The step's responsibility is **not** the same vocabulary as a principal's role. A Purchasing
step is decided by a `BUYER`; the mapping lives in `APPROVAL_STEP_DECIDER_ROLE` and is the only
place the two vocabularies meet. Collapsing them would make the approval ladder depend on the
identity module's role names.

## Initial materialization, and what is *not* re-evaluated

Submission materializes the **whole** ladder at once, from the estimated total (BR-002):

- every step exists, with a server-assigned `sequence` that is 1-based and gap-free — it is the
  position in the policy's output list, never a value a client supplies;
- exactly the **first** step is `ACTIONABLE`;
- every later step is `PENDING`: it exists, it is visible, and it cannot be decided until the
  steps ahead of it complete (FR-035);
- every step records the amount it was evaluated against, in exact centavos (FR-036).

`ACTIONABLE` is a state, not an inference from which timestamps are null. That matters twice
over: a query can find "what is waiting on me" with a predicate rather than a join and a
negation, and PostgreSQL can enforce the invariant. A partial unique index —
`UNIQUE (organization_id, approval_flow_id) WHERE state = 'ACTIONABLE'` — makes "a flow waits on
at most one step" true for any write path, including one that never asked the application.

**Approving the Manager step promotes nothing.** BR-002 evaluates the Purchasing and Finance
steps against the *selected quote total*, which does not exist until a buyer selects a quote.
Promoting the next step at manager approval would mean asking a buyer to approve an amount the
requirements say is not the amount they approve. So a two- or three-step flow stays `ACTIVE`
with its later steps `PENDING`, and only a first-tier flow — whose sole step is the Manager's —
reaches `COMPLETED` in this phase.

## Authorization

Four separate questions, asked in the order that leaks least. Each answers something different,
and no one of them can stand in for another (AUTHZ-002).

| # | Question | Failure | Where it is enforced |
| --- | --- | --- | --- |
| 1 | Does the principal hold MANAGER at all? | `403` | `assertMayDecideApprovalStep`, before any read |
| 2 | Is the request inside the caller's Department? | `404` | the read predicate, and again in the write |
| 3 | Is the caller the requester? (BR-005) | `403` | `assertNotSelfApproval`, before the transaction |
| 4 | Is there an actionable step of that responsibility? | `409` | the conditional `UPDATE` |

**Capability.** `principal.roles` is not a token claim: the access-token guard discards the
claims and rebuilds `TrustedPrincipal` from the `user_roles` rows, so a role revoked a moment
ago stops granting this on the next request. ADMIN grants nothing here (AUTHZ-007), and neither
BUYER nor FINANCE may decide a Manager step (AUTHZ-006). The refusal names the action and never
a resource, so it confirms nothing about what exists.

**Responsibility.** AUTHZ-004 makes a Manager's boundary their Department. Two departments are
involved and they are not the same thing:

- the **resource's** department is the request's own persisted `department_id` — the snapshot
  BR-042 took when the request was raised. Moving the requester between departments afterwards
  must not move their existing requests into another manager's queue, so this is never read
  through the requester's current profile;
- the **actor's** department is the manager's own current membership, read through
  `identity-access`.

The read is `findDepartmentRequest({ organizationId, departmentId, purchaseRequestId })`. Tenant,
resource and boundary are one predicate, so a request in another department — or another tenant
— is never loaded, and an unknown identifier, a foreign-tenant one and a foreign-department one
produce one bare `404` (MT-004). The department is restated inside the conditional write as
well, so the boundary is a predicate and not only a pre-check.

**Self-approval.** BR-005 has no fallback and no override: holding MANAGER does not let a person
approve what they raised, and holding ADMIN as well does not either. It is refused before the
transaction opens, so no decision, no transition and no audit event is written. It answers `403`
rather than `404` deliberately — the caller raised this request, so the refusal discloses
nothing they did not already know, and hiding the rule would leave them unable to understand
why. The same rule is applied to the queue, in the predicate: a queue of work a person is
forbidden to do is not a queue.

## The decision, and why it is final

FR-031 and BR-006. Approving moves `SUBMITTED → IN_QUOTATION`; rejecting moves it to
`REJECTED`, which is terminal (BR-004) and voids the steps that will now never be decided —
voids, not deletes, so the ladder that was required stays readable.

- A rejection requires a reason of at least **10 non-whitespace characters**, counted after
  trimming, enforced in the domain (`422`) *and* by a PostgreSQL `CHECK`.
- An approval may omit a reason. If one is given it is validated and stored: silently
  discarding text a manager typed is how an approval loses the only explanation anyone
  recorded. A blank one is refused rather than treated as absent.
- There is no un-approve, no edit, no retry-as-a-new-decision and no second decision path. A
  decided step no longer matches `state = ACTIONABLE`, so every later attempt is a `409`.

The step's decision facts — who, when, why, and against what amount — are stored on the step
itself rather than reconstructed from the request's current state, and a `CHECK` requires a
decided step to carry a decider and a timestamp and an undecided one to carry neither.

## Transaction boundary and concurrency

ADR-001 rule 4 and REL-001: one business operation, one transaction. Three of them exist.

| Operation | What commits together |
| --- | --- |
| Submit | `DRAFT → SUBMITTED`, the flow, all its steps, the `PURCHASE_REQUEST_SUBMITTED` event |
| Decide | the step's decision, the flow's resulting state, `SUBMITTED → IN_QUOTATION\|REJECTED`, the decision event |
| Cancel | `→ CANCELLED`, the voiding of an unfinished flow and its undecided steps, the `PURCHASE_REQUEST_CANCELLED` event |

The application layer may not import Prisma (ADR-002), and a transaction has to cross three
modules. `platform/persistence` resolves that with a `TransactionScope`: an opaque, empty
branded type that a use case can only receive and pass along. Only a persistence adapter can
turn it back into a database client, through `transactionClient`. So the transaction is shared
by construction, and application code cannot open a second one or reach the database directly.

**The conditional write is the concurrency authority.** Every read that precedes a write exists
to classify the failure — to say `404` instead of `409`, or to produce a message worth reading.
It is never what makes the rule true. Each write restates its own precondition:

```sql
UPDATE approval_steps SET state = 'APPROVED', …
 WHERE id = $1 AND organization_id = $2 AND purchase_request_id = $3
   AND role = 'MANAGER' AND state = 'ACTIONABLE';        -- affected rows must be exactly 1

UPDATE purchase_requests SET status = 'IN_QUOTATION'
 WHERE id = $1 AND organization_id = $2 AND department_id = $3
   AND status = 'SUBMITTED';                             -- affected rows must be exactly 1
```

Two managers deciding the same step at the same time therefore produce exactly one of
everything. The first transaction takes the step's row lock; the second blocks, re-evaluates
its `WHERE` under READ COMMITTED once the lock is released, matches nothing, and **throws** —
which rolls back everything it had written. There is no path that commits a decided step
without its request transition, or either without its audit event, and no path that writes a
second audit event for a decision that did not happen. The loser gets `409`; nothing is
silently overwritten (REL-005).

The same shape guards submission and cancellation, and the audit sequence has its own
`UNIQUE (organization_id, aggregate_type, aggregate_id, sequence)` as a second net: a writer
that computed a position another transaction already committed is refused by PostgreSQL rather
than interleaved.

## Audit events

AUD-002's shape, for the four transitions AUD-001 lists that this phase can produce:

| Column | Meaning |
| --- | --- |
| `organization_id`, `actor_id` | From the `TrustedPrincipal`, never from the emitter's payload |
| `event_type` | `PURCHASE_REQUEST_SUBMITTED`, `PURCHASE_REQUEST_CANCELLED`, `APPROVAL_STEP_APPROVED`, `APPROVAL_STEP_REJECTED` |
| `aggregate_type`, `aggregate_id` | `PURCHASE_REQUEST` and the request's id — including for the decisions |
| `sequence` | 1-based, unique per `(organization, aggregate type, aggregate id)` |
| `occurred_at` | `TIMESTAMPTZ(3)`, the instant of the business change |
| `payload` | `JSONB`, typed at the emitting boundary |

All four events are filed under the **request**, with the step's identity inside the decision
payload. That is what makes AUD-005 hold in one ordered read: `sequence` reconstructs the
decisions on a request without ambiguity, and does not depend on clock resolution.

The decision payload records the decision, the reason when there was one, the evaluated amount,
and the step's identity, sequence and role:

```json
{
  "decision": "REJECTED",
  "decisionReason": "Not budgeted for this quarter",
  "evaluatedAmountCents": "500001",
  "approvalStepId": "…", "approvalStepSequence": 1, "approvalStepRole": "MANAGER",
  "approvalFlowId": "…", "approvalFlowState": "REJECTED",
  "resultingStatus": "REJECTED"
}
```

Amounts inside a payload are **digit strings**, for exactly the reason amounts are strings on
the wire: a JSON number is an IEEE-754 double to every reader, and this is the record that is
supposed to be authoritative.

**Append-only (AUD-003)** is enforced twice. The published interface has one method and it
appends — there is no update, no delete and no "correct an event" to call. And a PostgreSQL
trigger raises on `UPDATE` or `DELETE` against `audit_events` whatever issued it; the test
database is reset with `TRUNCATE`, which is not a row operation and does not fire it.
Restricting the application's database role is the operational half of the same rule and
belongs to deployment.

`append` takes a `TransactionScope` and has no overload that writes outside one, so AUD-004 is
not a discipline: an event cannot be written except as part of the change it describes.

## Module boundaries

ADR-001 gives `approval` ApprovalFlow, ApprovalStep and the policy, and `audit` the AuditEvent
write path. Both own exactly that, and no other module touches their tables.

`approval` has no controller. Every operation it publishes is one half of a purchase request
transition, and the orchestration of a transition that spans modules lives with the module that
owns the aggregate whose lifecycle it is — `procurement`. The dependency therefore runs one way,
`procurement → {approval, audit, identity-access}`, with no cycle and no `forwardRef`.

The manager queue is read as two tenant-scoped queries rather than one join: `procurement`
selects its own department's `SUBMITTED` requests (keyset, newest first, on the tenant-leading
`(organization_id, department_id, status, created_at DESC, id DESC)` index), and `approval`
returns the actionable Manager steps for those requests. Each module queries only the tables it
owns, and the tenant predicate is on both halves.

## HTTP contract

Both routes sit on the existing `/purchase-requests` surface and are default-deny like every
other. The queue is declared **before** `:purchaseRequestId` in the same controller, so its
literal segment is matched as a route and never as an identifier — an ordering guarantee two
controllers could not give.

| Method | Path | Success | Notes |
| --- | --- | --- | --- |
| `GET` | `/purchase-requests/awaiting-my-approval` | `200` | The caller's Manager queue. Query: `limit` (1…100, default 20), `cursor` |
| `POST` | `/purchase-requests/{id}/approval-decision` | `200` | Decides the pending Manager step |

`GET /purchase-requests/{id}` now carries the approval flow as well: the pending step and the
full ordered history, each step with its actor, decision, reason, evaluated amount and
timestamp (FR-026). It is `null` for a DRAFT — which has no flow — rather than an empty object.

The decision body is a closed world of two fields:

```json
{ "decision": "REJECTED", "reason": "Not budgeted for this quarter" }
```

There is no step identifier, no actor, no amount, no sequence and no status: the step is the one
the flow is waiting on, the actor is the authenticated principal, and the resulting state is the
policy's. None of them is declared on the DTO, and the global `ValidationPipe` runs with
`forbidNonWhitelisted`, so sending one is a `400` rather than a value the server must remember
to ignore.

| Status | Meaning |
| --- | --- |
| `400` | Malformed body, unknown field, unknown decision, non-UUID identifier, unusable cursor |
| `401` | No usable access token |
| `403` | No MANAGER role, or BR-005 self-approval. Names no resource |
| `404` | Unknown, another tenant's, or another department's identifier — indistinguishable |
| `409` | No actionable Manager step, or a concurrent decision won the race |
| `422` | A rejection without a 10-character reason, or a blank approval reason |

Nothing logs a request body, a justification or a decision reason (SEC-009). The reason is
*persisted* — FR-036 requires it — which is not the same as logging it.

## Verification

Unit tests, no infrastructure (NFR-007):

- BR-001 at exactly `100000`, `100001`, `500000`, `500001` centavos, and above
  `Number.MAX_SAFE_INTEGER`; the ladder's order and its gap-free 1-based sequence;
- materialization — exactly one `ACTIONABLE` step at every tier, and never a Purchasing or
  Finance step among them;
- the flow state a decision produces, including that an approval with steps remaining promotes
  nothing;
- the rejection reason rule at and below the boundary, whitespace-only text, an over-long
  reason, an optional approval reason, and a blank one refused rather than dropped;
- the decider mapping, every non-granting role set including ADMIN alone, and BR-005 against
  every role combination a requester could hold.

PostgreSQL/Testcontainers integration tests:

- a submission writes the exact ladder and its audit event in one transaction, and an induced
  audit failure leaves no transition, no flow, no steps and no event;
- two concurrent decisions leave exactly one decision, one matching transition, one matching
  audit event and one conflict;
- the database refuses a cross-tenant flow, a cross-tenant step, a step naming a different
  request than its flow, a decision attributed to another tenant's user, and a cross-tenant
  audit actor;
- the database refuses a second actionable step in a flow, a duplicate sequence, a second flow
  for a request, a rejection without a 10-character reason, a decided step with no decider, an
  undecided step carrying a reason, a negative evaluated amount and a non-positive sequence;
- `audit_events` refuses `UPDATE` and `DELETE`, numbers events per aggregate, and refuses a
  duplicate position.

Authenticated HTTP tests over the real application:

- the three tiers materialize as tabled above, only the first step actionable;
- the requester — and only the requester — reads the pending step and the ordered history, with
  the decision's actor, reason, amount and timestamp;
- the queue holds the department's `SUBMITTED` requests and nothing else: not drafts, not
  decided or cancelled requests, not another department's, not another tenant's, not the
  caller's own;
- a principal holding EMPLOYEE, BUYER, FINANCE or ADMIN alone is refused on both routes; a
  manager of another department and a manager of another tenant get the same `404` an unknown
  identifier gets; a requester holding MANAGER cannot decide their own request, and nothing is
  written in any of those cases;
- approval moves exactly `SUBMITTED → IN_QUOTATION` and completes a first-tier flow; rejection
  moves exactly `SUBMITTED → REJECTED`, stores the trimmed reason and voids the rest;
- a rejection under ten characters is refused with no state, decision or audit change;
- a Purchasing step cannot be reached through the manager route by anyone;
- a decision is immutable afterwards, and exactly one decision audit event exists;
- cancellation voids an unfinished flow while preserving decisions already made, leaves a
  completed flow alone, still works from `IN_QUOTATION`, and keeps its requester-ownership and
  anti-enumeration behaviour.

Generated-document tests: the two new operations, the approval schemas, the closed-world
decision DTO, the queue page, every `400`/`401`/`403`/`404`/`409`/`422` outcome, and the
security-relevant descriptions.

## Deliberately deferred

| Deferred | Why, and what it waits on |
| --- | --- |
| ~~Purchasing and Finance decision execution~~ | **Implemented in Phase 9.** See § "Post-quotation decisions" below |
| ~~Quote-triggered flow extension and voiding (BR-003)~~ | **Implemented in Phase 9.** See § "Post-quotation decisions" below |
| Per-tenant configurable thresholds | § 12.1: the policy is code in the MVP. It is one pure function of an amount, so it can become data without the workflow changing |
| Administrator audit querying (FR-061, AUD-006) | A query surface needs an administrator surface and its own authorization story. The `audit` module publishes only the write direction |
| ~~Idempotency keys (REL-004)~~ | **Implemented in Phase 9.** Submission and the approval decision now require an `Idempotency-Key`; see `docs/architecture/client-idempotency.md` |
| ~~Transactional outbox and RabbitMQ (REL-002, REL-006)~~ | **Implemented in Phase 8.** Notification *delivery* (FR-062, FR-063) is still deferred: the outgoing facts are committed and published, and nothing consumes them into a notification yet |
| Hash chaining and external anchoring (AUD-007) | Explicitly out of the MVP. The event shape does not preclude it |
| Approval delegation and substitute approvers | § 12.2. An absent manager stalls the request; nothing models it |
| Frontend | Out of scope for the whole backend phase set so far |
| A department-scoped detail read for managers | The queue carries summaries, as every collection response in this module does. A manager reviewing a request's items needs a read this phase does not add |

---

## Post-quotation decisions (Phase 9)

Three things changed when quotation arrived. Each one is recorded here because the reasoning is
not visible in the code that resulted from it.

### The step decides who may act, not the route

The decision route is no longer Manager-only. The flow is waiting on exactly one step; that step
names a responsibility; the principal is checked against **that** (AUTHZ-006).

The alternative — a route per responsibility, or a `role` field in the payload — would let
someone holding both MANAGER and BUYER pick whichever rung happened to be available. It would
also make the client responsible for knowing which route to call, which is a fact about the
server's state that the client cannot reliably have.

One consequence is worth stating plainly, because it is a **behavioural change from Phase 8**:
a BUYER acting on a request whose Purchasing rung is still `PENDING` now receives `409`, where
before they received `403`. Both refuse, and `409` is the accurate one: they are not missing a
capability, they are acting on a rung that is not waiting on anyone yet.

### Scope differs by responsibility, and the read has to respect that first

AUTHZ-004 puts a Manager at Department scope and Buyer and Finance at organization scope. So the
request is read under the **narrowest scope the principal could ever act in** — their Department
when they hold only MANAGER, the organization when they hold BUYER or FINANCE — *before* the
actionable step is looked up.

That ordering is what keeps MT-004's parity intact. Reading tenant-wide first would let a manager
distinguish "exists in my tenant but outside my department, and its ladder is idle" (`409`) from
"does not exist" (`404`).

A cheap gate runs before even that read: a principal holding none of MANAGER, BUYER or FINANCE is
refused outright, so an EMPLOYEE or a lone ADMIN cannot use the difference between `403` and
`404` to discover whether a request exists.

### BR-003 re-evaluation is a pure function

`approval/application/support/approval-reevaluation.ts` takes the current ladder, the flow's
state and one amount, and returns a plan: which steps to void, which to reprice, which to append,
which one to promote, and whether anything changed at all. It touches no database, no clock and
no principal, so all nine estimated-tier to selected-tier combinations are provable without
infrastructure (NFR-007).

The rules it encodes, and why:

- **The Manager step is untouchable.** BR-002 evaluates it against the *estimated* total and it
  has already gated entry into quotation. Re-pricing a decision someone already made against a
  different number would rewrite history; voiding it would un-approve the very step that
  authorized the quotation work.
- **A decided step is never re-appended.** A tier requiring PURCHASING when a PURCHASING step
  exists in any non-voided state is already satisfied by that step; adding a second would ask the
  same person to approve the same request twice.
- **A step is repriced only when the amount actually changes.** A selected total that lands on
  the estimate leaves the ladder alone, so `changed` stays honest and the trail is not filled
  with re-evaluations that re-evaluated nothing.
- **Exactly one step is promoted** — the earliest remaining undecided one (FR-035). The
  repository applies the plan in an order that never leaves two `ACTIONABLE` steps even
  momentarily, because a partial unique index refuses that outright.

An `APPROVAL_FLOW_REEVALUATED` audit event is written **only when the ladder actually moved**.
"The rule was consulted" is not an audited action; "two steps were voided and Finance was
appended" is.

### Promotion after a decision

`shouldPromoteNextStepAfterDecision` states the asymmetry: a **Manager** approval promotes
nothing, because BR-002 says the next rungs are evaluated against a total that does not exist
yet. A **Purchasing** approval promotes Finance immediately, because by then the amount already
*is* the selected quote total.

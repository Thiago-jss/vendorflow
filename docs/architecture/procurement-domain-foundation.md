# Procurement Domain Foundation

**Status:** Implemented foundation
**Last updated:** 2026-09-05
**Scope:** PurchaseRequest, PurchaseRequestItem, and the requester's half of the request
state machine

This document makes the `procurement` module of ADR-001 concrete for the requester's own
purchase requests. It does not introduce approval, quotation, ordering, audit events, the
outbox, or any user interface. Where a requirement depends on one of those, the gap is named
below rather than simulated.

## Model

```text
Organization (tenant)
  └─ PurchaseRequest        requester + department snapshot + status + estimated total
       └─ PurchaseRequestItem   description, unit of measure, quantity, estimated unit price
```

A PurchaseRequest belongs to exactly one Organization, is raised by exactly one User, and
carries the Department that User belonged to **at creation time** (BR-042). The department is
a column on the request, not a join through the requester: moving a person between
Departments later must not reassign the requests they already raised.

A PurchaseRequestItem has no life outside its request (domain glossary). It is created,
replaced and deleted as part of the request, and its `position` is assigned by the server
from list order so the item list has a deterministic order that no client controls.

## Money and quantity

BR-030 and BR-031 are structural here, not conventional:

- BRL only. There is no currency column and no currency field on any DTO.
- Every monetary value is an integer number of centavos in PostgreSQL (`BIGINT`), in the
  domain (`bigint`) and on the wire (a digit string). No `float`, no `Number`, no
  `parseFloat`.
- Quantities are **exact decimals**, held as a `bigint` count of thousandths — 1.25 is
  `1250n`. Parsing goes from the wire string to scaled units by digit manipulation, and
  formatting goes back the same way. No binary float ever holds a quantity, so 0.1 + 0.2 has
  no opportunity to become 0.30000000000000004.

### Why strings on the wire

A JSON number is an IEEE-754 double in every parser this API will meet. It cannot hold 0.1
exactly, and it cannot hold a centavo amount above 2^53 at all. Since this system sets no
ceiling on how much may be requested, both cases are reachable, so quantities and amounts
cross the boundary as text:

```json
{ "quantity": "1.250", "estimatedUnitPriceCents": "549900" }
```

Quantities are always rendered at the declared scale — `4` comes back as `"4.000"` — so a
reader can see the precision the system keeps rather than infer it from whichever value
happened to have trailing zeros.

### What is bounded, and why

There are **no product caps**. Item count, quantity magnitude and unit price have no maximum
in the requirements, and none is invented here. What remains is finite because storage is
finite, and each limit is a property of a column rather than a policy:

| Limit | Value | What it is |
| --- | --- | --- |
| quantity scale | 3 decimal places | the scale of `NUMERIC(20, 3)`; the precision the system keeps and round-trips |
| maximum quantity | `99999999999999999.999` | the largest value `NUMERIC(20, 3)` holds — 20 significant digits, 3 after the point |
| monetary amounts | ±2^63−1 centavos | the range of `BIGINT` |
| request body | the HTTP server's body limit | not a domain rule at all |

The maximum quantity is **derived** from the declared precision and scale
(`10^precision − 1` in thousandths) rather than written as a literal, so changing the column
changes one constant.

Both quantity limits are enforced by the domain, not by the driver. A quantity carrying more
than three decimal places is **refused**, never rounded to fit — silently dropping a digit
the caller wrote is how a quantity stops meaning what it said — and a quantity wider than the
column is refused before Prisma is called, so it produces a stated domain answer instead of a
PostgreSQL numeric overflow. The request total's own `BIGINT` check cannot stand in for this:
a unit price of `0` makes any quantity total zero.

The refusals are split by layer, and never conflated:

| Input | Answer | Why |
| --- | --- | --- |
| `"1.2345"` | `400` | more precision than the wire format defines — a malformed representation |
| `"1e3"`, `"-1"` | `400` | not the decimal format at all |
| `"0"` | `422` | well formed, refused by BR-012 |
| `"100000000000000000.000"` | `422` | well formed, beyond what the system stores exactly |

An amount that would overflow the monetary column is reported the same way: as exceeding what
the system stores exactly, never truncated or wrapped.

### Rounding (BR-033)

Rounding is half-up, at the centavo, applied **once** at the line total and never at the unit
price:

```
scaledTotal = quantityInThousandths × unitPriceCents      (exact integer arithmetic)
lineTotal   = scaledTotal / 1000, rounded half-up
requestTotal = Σ lineTotal                                (already-rounded lines)
```

The multiplication happens before any division, so the single half-up step is the only
rounding in the whole calculation. `remainder × 2 ≥ 1000` is that test written without a
division that would reintroduce rounding.

The request total sums the **already rounded** lines, so the number a requester sees on a
line is the number that contributes to the total. Rounding once at the end instead would
produce a total that no set of displayed lines adds up to — two lines of 0.5 centavos each
would show as 1 and 1 and total 1.

BR-032 is enforced by omission: no DTO declares `estimatedTotalCents`, and the global
`ValidationPipe` runs with `forbidNonWhitelisted`, so a client that supplies one gets `400`
rather than a value the server has to remember to ignore.

## State machine

BR-010's eight states all exist in the PostgreSQL enum. Declaring them now means a later
phase adds *transitions*, not a migration.

BR-011's full transition table is deliberately **not** implemented. This phase implements
only the three edges a requester drives:

```text
DRAFT      → SUBMITTED
DRAFT      → CANCELLED
SUBMITTED  → CANCELLED
```

`SUBMITTED → IN_QUOTATION | REJECTED` and everything past it belong to actors and aggregates
that do not exist yet. A state machine that declares edges nothing can drive is a state
machine no test can prove, so each phase adds its own.

Two consequences worth stating plainly:

- **SUBMITTED is a legitimate resting state in this phase.** Nothing advances it, because
  nothing exists to advance it.
- **FR-024 is only half implemented.** Submission computes and persists the estimated total
  and the transition. It does *not* materialize an Approval Flow, because `ApprovalFlow` is
  the subject of the next phase. No placeholder flow, synthetic step or fake event is
  written: a fake approval structure would be harder to remove than the real one is to add.

FR-026 is likewise partial by construction. A requester can read the current state of their
own request. There is no pending step and no step history, and empty ones are not returned —
that would be a contract the next phase has to break.

## Authorization

Authorization is entirely server-side (AUTHZ-001) and has two distinct parts. Conflating them
is the mistake this section exists to prevent.

### Capability: who may create one

FR-020 grants creation to an **Employee**. Authentication is not authorization: a principal
holding only MANAGER, BUYER, FINANCE or ADMIN authenticates perfectly well and is still
refused with `403` (AUTHZ-003). ADMIN is explicitly not a bypass (AUTHZ-007).

The check reads `principal.roles`, which is **not a token claim**: the access-token guard
discards the claims and rebuilds `TrustedPrincipal` from the `user_roles` rows, so a role
revoked a moment ago stops granting this capability on the next request rather than at token
expiry, and a forged or stale `roles` claim buys nothing. A `roles` field in the request body
is refused by the closed-world DTO before it is even looked at.

It lives in `assertMayCreatePurchaseRequest`, called by the use case rather than only by a
guard, so it protects the application behaviour for any caller — not only for one that
arrived through this module's controller. It is deliberately one explicit rule rather than a
policy engine: there is one capability to guard in this module, and a framework built for it
would have exactly one user.

### Ownership: who may act on an existing one

"Requester" is not a Role; it is what a User is called while they own a request (domain
glossary). Reading, editing a DRAFT, submitting, cancelling and deleting are therefore
authorized by ownership alone, and **not** by EMPLOYEE. A person whose roles changed after
raising a request keeps control of it — no requirement says a role change should strand
existing work, so none is invented.

Every requester-owned operation puts tenant, resource and owner in the same database
predicate:

```ts
findOwnRequest({ organizationId, requesterId, purchaseRequestId });
```

A foreign row is never loaded, so there is nothing to decide about after the fact and nothing
to leak through an error shape, a timing difference or a log line. Three distinct situations
— unknown identifier, another requester in the same tenant, another tenant entirely —
produce one `PurchaseRequestNotFoundError` and one bare `404` (MT-004).

Every transition additionally re-states the permitted source states inside the write:

```ts
updateMany({ where: { id, organizationId, requesterId, status: "DRAFT" }, data: … });
// affected count must be exactly 1
```

The check that produces the useful error runs before the write; the check that *guarantees*
the rule is the predicate inside it. Two concurrent submissions cannot both observe `DRAFT`
and both succeed — one updates a row and one updates none, and the loser gets `409`
(AUTHZ-005).

## HTTP contract

Every route is authenticated by the global default-deny guard. None is `@Public()`.

| Method | Path | Success | Notes |
| --- | --- | --- | --- |
| `POST` | `/purchase-requests` | `201` | Creates a DRAFT. Requires EMPLOYEE. Body: `justification`, `neededBy`, `items[]` |
| `GET` | `/purchase-requests` | `200` | Own requests, paginated. Query: `limit` (1…100, default 20), `cursor` |
| `GET` | `/purchase-requests/{id}` | `200` | Own request with its items |
| `PUT` | `/purchase-requests/{id}` | `200` | Replaces a DRAFT's editable content |
| `POST` | `/purchase-requests/{id}/submit` | `200` | DRAFT → SUBMITTED |
| `POST` | `/purchase-requests/{id}/cancel` | `200` | DRAFT or SUBMITTED → CANCELLED |
| `DELETE` | `/purchase-requests/{id}` | `204` | Deletes a DRAFT |

Item body fields: `description`, `unitOfMeasure`, `quantity` (decimal string),
`estimatedUnitPriceCents` (integer-centavo string).

Failure mapping, uniform across every route:

| Status | Meaning |
| --- | --- |
| `400` | Malformed payload, unknown field, unusable pagination cursor, non-UUID identifier |
| `401` | No usable access token |
| `403` | Authenticated, but the principal does not hold EMPLOYEE (creation only) |
| `404` | Unknown, another requester's, or another tenant's identifier — indistinguishable |
| `409` | The current state does not permit the action, or it changed underneath the caller |
| `422` | Well-formed payload that a domain rule refuses (e.g. `2026-02-30`) |

The state is not a writable field. `PUT` replaces the *content* of a draft; a transition is a
named command with its own route, so a client can never ask for an arbitrary status.

Replacement rather than a partial patch is deliberate: an item list is the thing being
stated, and a per-field patch would require a client-visible identity for lines that have no
meaning outside their request.

### Pagination

Keyset, on `(created_at DESC, id DESC)`, backed by the tenant-leading index. `id` breaks ties
so a page cannot shift or repeat when rows share a `created_at`.

The cursor is the last row's ordering key, base64url-encoded so clients treat it as opaque.
It is deliberately neither signed nor encrypted: it carries no secret, both halves were in
the response that produced it, and the query consuming it is already scoped to the caller's
organization and requester id. A forged cursor can only move a caller around inside their own
rows.

There is no total count, because a count is a second query nobody asked for.

## PostgreSQL constraints

Per ADR-002's migration-review checklist:

- **Tenant column and parent.** Both tables carry `organization_id` with a `RESTRICT` foreign
  key to `organizations`.
- **Composite foreign keys.** `(organization_id, requester_id) → users`,
  `(organization_id, department_id) → departments`, and
  `(organization_id, purchase_request_id) → purchase_requests`. A request in Organization A
  cannot reference a User, Department or parent request in Organization B, whatever the
  application believes.
- **Tenant-aware candidate keys.** `UNIQUE (organization_id, id)` on both tables;
  `UNIQUE (organization_id, purchase_request_id, position)` on items.
- **Delete behaviour.** `RESTRICT` everywhere except request → items, which `CASCADE`s. That
  is the only cascade in the schema and it is deliberate: an item has no life outside its
  request, so deleting a draft must take its lines with it.
- **Checks.** Non-empty justification, description and unit of measure; `quantity > 0` and
  `estimated_unit_price_cents >= 0` (BR-012), with no upper bound on either; a DRAFT can carry
  no `submitted_at`; `status = 'CANCELLED'` if and only if `cancelled_at` is set.
- **Exact numeric types.** `quantity` is `NUMERIC(20, 3)` and never a binary float type;
  amounts are `BIGINT` centavos.
- **Tenant-leading index.** `(organization_id, requester_id, created_at DESC, id DESC)`,
  matching the only product query this phase has.

## Deleting a draft

FR-022 grants the requester free deletion while the request is a DRAFT, and a hard delete is
correct **here and only here**: a DRAFT has never been submitted, so nothing in the system
references it — no approval flow, no quote, no order — and its items go with it through the
declared cascade. There is no soft-delete flag, because no requirement asks to read a deleted
draft back and a speculative one would have to be honoured by every later query.

When `AuditEvent` arrives, deleting a draft becomes an auditable fact. That is a change to
this use case, not a reason to build a tombstone now.

## Module boundary

The module follows the `identity-access` shape: `application/{contracts,support,use-cases}`
and `infrastructure/{persistence,http}`. The application layer imports no infrastructure and
no Prisma; the repository contract lives in `application/contracts` and its only
implementation lives in `infrastructure/persistence`.

The contract is not a mirror of Prisma. It exposes the seven operations the use cases
actually perform, each scoped by construction — there is no read by identifier alone and no
optional `organizationId`, so an unscoped query is not expressible.

`procurement` reads exactly one thing it does not own: the requester's Department at creation
time. `users` belongs to `identity-access`, so that read goes through
`GetCurrentOrganizationContext`, the use case that module exports, rather than through a
query from here (ADR-001, rule 2).

## Verification

Unit tests, no infrastructure (NFR-007):

- the state machine — the three permitted edges, every refusal including the ones later
  phases will add, terminal states, and BR-013;
- exact decimal quantity — parsing and formatting of fractional values, `0.1 + 0.2 === 0.3`
  in thousandths, magnitudes beyond `Number.MAX_SAFE_INTEGER`, refusal of every ambiguous
  representation, round-tripping, and the storage boundary: `99999999999999999.999` is
  accepted and the next value up is refused as unstorable;
- the estimated total — half-up rounding at the line including the exact-half case, the
  unit price never being rounded, aggregation of already-rounded lines, and exactness above
  `Number.MAX_SAFE_INTEGER`;
- draft invariants — at least one item, no maximum item count, quantity and price limited
  only by the storage width, and real calendar dates;
- the creation capability — EMPLOYEE grants it, every other role set (ADMIN included) does
  not, and the refusal names no resource.

PostgreSQL/Testcontainers integration tests, two organizations plus a second requester inside
one of them:

- an own request is readable; a foreign tenant's and a colleague's are absent in both
  directions;
- update, submit, cancel and delete against a foreign request change nothing and report
  nothing;
- lists exclude other tenants and other requesters, and keyset pagination neither repeats nor
  skips a row;
- two concurrent submissions produce exactly one winner;
- an exact decimal quantity round-trips through `NUMERIC(20, 3)` — `0.100` and `0.200` come
  back as written — and an amount of 2^53 + 1 centavos is stored and read back exactly;
- PostgreSQL itself rejects a cross-tenant requester, a cross-tenant department, and a
  cross-tenant item inserted by raw SQL, plus a non-positive quantity, a negative unit price,
  a negative total, an impossible DRAFT, and a quantity wider than the declared precision.

Authenticated HTTP tests over the real application:

- DRAFT → SUBMITTED, then every edit, delete and resubmission refused;
- cancellation from DRAFT and from SUBMITTED, and never twice;
- a principal holding EMPLOYEE creates; one holding MANAGER, BUYER, FINANCE and ADMIN gets
  `403`, no row is written, and neither a `roles` body field nor a `requesterId` bypasses it;
- a non-EMPLOYEE still reads, submits and cancels a request they already own;
- fractional quantities round half-up once per line, and an amount above 2^53 survives the
  raw response body intact;
- a quantity wider than the column, priced at zero so no amount check can catch it, returns
  `422` with the domain's own message, writes no row, and leaks no Prisma or PostgreSQL text;
- a body carrying `organizationId`, `requesterId`, `departmentId`, `status`, `roles`,
  `estimatedTotalCents` or an item `position` is rejected, and no row is written;
- a foreign identifier and an unknown identifier produce byte-identical `404` responses
  across all five object-level routes;
- pagination bounds, unknown query parameters and unusable cursors.

Generated-document tests (no database):

- `/docs-json` lists all seven purchase request operations, their request and response
  schemas, their query parameters, their `400`/`401`/`403`/`404`/`409`/`422` outcomes, and
  the bearer security requirement on every one of them;
- the schemas contain the wire types the domain accepts — `quantity` and every amount as
  strings — and contain none of the server-owned fields.

## OpenAPI

NFR-009 requires the API to be documented from the same source of truth used for request
validation. `@nestjs/swagger` builds the document from the controllers' routing metadata and
the DTO classes the `ValidationPipe` already validates against, so the contract cannot drift
from behaviour the way a hand-written document does. Nothing in the annotations restates a
rule; the rules live on the DTOs.

- Served at **`/docs`** (browsable) and **`/docs-json`** (the raw document).
- Configured in `platform/http/openapi.ts` and wired from `configureHttpApplication`, the
  same function the production bootstrap and the integration harness both call — so the
  document the tests assert against is the document the application serves.
- Response shapes are classes rather than interfaces, because an interface leaves no runtime
  metadata for the generator to read.
- Swagger's routes are registered as middleware rather than Nest handlers, so the global
  access-token guard does not cover them. That is deliberate: the document describes the
  contract and contains no tenant data, and every route it lists stays default-deny.
  Restricting the documentation route in production is a deployment concern.

This document above remains the *reasoning* — why the boundaries are where they are. The
generated OpenAPI is the *contract*.

## Known gaps

- **FR-024's Approval Flow is not implemented.** Submission persists the transition and the
  total, and nothing else. See the state-machine section.
- **FR-026's pending step and step history do not exist.** Only the current state is exposed.
- **No audit event is written** for creation, submission, cancellation or draft deletion.
  `AuditEvent` and the transactional outbox are ADR-003's subject.
- **No idempotency key on submission.** A duplicate submission is already harmless — the
  second one loses the compare-and-swap and gets `409` — but a genuine idempotency contract
  belongs with the outbox work.
- **`identity-access` is documented thinly.** The generated document lists its routes because
  they are real Nest handlers, but they carry no operation summaries or response schemas yet.
  Annotating them is their module's change, not this one's.

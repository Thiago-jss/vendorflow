# Suppliers, Quotes and Purchase Orders

**Status:** Implemented (Phase 9)
**Last updated:** 2026-09-09
**Requirements:** FR-010 – FR-013, FR-040 – FR-054, FR-062, BR-002, BR-003, BR-020 – BR-025,
BR-030 – BR-033, MT-002, MT-004, MT-006, AUD-001 – AUD-005, REL-001, REL-002, REL-005
**Related:** ADR-001 (modular monolith), ADR-002 (multi-tenant data isolation),
ADR-003 (reliable side effects), `docs/architecture/approval-workflow.md`,
`docs/architecture/client-idempotency.md`

This document records the decisions in this phase that are **expensive to reverse** — a schema
shape, a data-minimization boundary, an ownership rule. Everything a reader can get from the
code by reading it is deliberately not repeated here.

---

## 1. Fiscal identity is a declared type, not an inferred one

A Supplier carries three fields for one concept:

| Column | What it is |
| --- | --- |
| `tax_identifier_type` | `CNPJ` or `OTHER`, declared by the caller |
| `tax_identifier` | exactly what was typed, trimmed |
| `tax_identifier_normalized` | the comparison form, and the only one uniqueness is decided on |

**The type is never sniffed from the value.** "Fourteen digits, therefore a CNPJ" is a claim
about a national registry made by a regular expression, and it would silently mislabel an
internal supplier code that happens to be fourteen digits long. `CNPJ` means the value was
reduced to its 14 digits and its two modulus-11 check digits were verified in application logic
(`supplier/application/support/tax-identifier.ts`). `OTHER` means the value is stored faithfully
and **no national validation is claimed** — which is a statement the API makes explicitly rather
than leaving a reader to assume.

**Both forms are kept because they answer different questions.** The original spelling exists so
a person recognizes their own data: `11.222.333/0001-81` reads as a CNPJ and `11222333000181`
does not. The normalized form exists so FR-013's uniqueness is decided on meaning rather than on
punctuation — registering both spellings must collide, and it does.

**Uniqueness ignores the type.** `UNIQUE (organization_id, tax_identifier_normalized)` has no
type column in it, deliberately: one company must not become registerable twice by relabelling
its identifier as `OTHER`.

Two shape rules are database CHECKs rather than application habits, because the normalized form
is what every later comparison depends on: it must be uppercase alphanumeric, and it must be
exactly 14 digits when the type claims CNPJ.

**A repeated-digit CNPJ is refused even though the arithmetic accepts it.** `00000000000000` and
its siblings satisfy modulus 11. They are not CNPJs, and letting one through is the kind of
correctness that looks fine until an invoice is issued against it.

### What never leaves tenant storage

No fiscal identifier, legal name, trade name, email address or phone number appears in an
`AuditEvent` payload or in an outgoing broker message. The audited fact is *"this actor
registered a supplier"*, and the supplier itself is one tenant-scoped authorized read away.
Copying it into an append-only store would make a permanent duplicate of fiscal and personal
data that nothing needs (SEC-009, AUD-003).

The audit payload does keep the identifier's **type**, because "registered as a validated CNPJ"
and "registered as an unvalidated other identifier" are different decisions and the trail should
say which one was made.

---

## 2. BR-021 is enforced three times, and only one of them is the authority

A Supplier Quote must price **every** item of its request, exactly once, and no item of any
other request. Three separate mechanisms say so, and they are not redundant — each catches
something the others cannot.

1. **In the domain**, for a good error message. `RegisterSupplierQuote` rejects a missing line, a
   duplicate line and a foreign line with a 422 that names the rule.
2. **A composite foreign key**, for the relationship. A quote line carries
   `purchase_request_id` denormalized from its quote, and reaches its request line through
   `purchase_request_items (organization_id, purchase_request_id, id)`. A line of request A
   therefore has nowhere to point in request B — *including inside the same tenant*, which is
   the case an `organization_id`-only key would miss.
3. **A deferred constraint trigger**, for the count. "This quote has exactly as many lines as its
   request has items" is only decidable once every line of the insert has been written, so it is
   evaluated at `COMMIT`, where the answer is final.

The application check can be raced by a concurrent draft edit; the foreign key cannot express a
count; the trigger cannot produce a helpful message. Together they cover the rule.

`supplier_quotes.item_count` exists so the trigger has a declared value to compare against.
A quote row alone therefore states how many lines it must have.

---

## 3. Quote registration takes the request's row lock first

FR-025 lets a requester cancel from `IN_QUOTATION`. Without a lock, a buyer's registration could
read "still in quotation", and a cancellation could commit in the gap before the quote row is
inserted — leaving an **ACTIVE quote against a request nobody can act on**. That is a live
commercial offer with no owner, not a benign inconsistency.

So `procurement` publishes `ProvePurchaseRequestQuotable`, which takes `SELECT … FOR UPDATE` on
the tenant-scoped request row and returns it only if the status is `IN_QUOTATION`. Everything a
quotation transaction writes afterwards is conditional on having won that lock.

This establishes the **lock order used everywhere in this system**:

> request → quote or approval flow → derived rows

Two operations that take the same rows in opposite orders deadlock; one that never reads the
request's state under a lock races it instead. Ordering issuance, quote selection and quote
registration all begin the same way.

---

## 4. Exactly-one invariants are partial unique indexes, not application checks

| Rule | Mechanism |
| --- | --- |
| BR-022: one ACTIVE quote per supplier per request | `UNIQUE (organization_id, purchase_request_id, supplier_id) WHERE status = 'ACTIVE'` |
| BR-024: one SELECTED quote per request | `UNIQUE (organization_id, purchase_request_id) WHERE status = 'SELECTED'` |
| FR-050: one purchase order per request | `UNIQUE (organization_id, purchase_request_id)` |

Each is translated at the persistence boundary into a named domain conflict and answered as a
409. A race that an application pre-check missed therefore answers exactly as a sequential
duplicate does, and no driver detail or 500 ever reaches a caller (ADR-002).

Validity (BR-023) is the same idea in a different shape: the conditional `UPDATE` that selects a
quote restates both `status = 'ACTIVE'` and `valid_until >= today`, so a quote that expires
between the read and the write does not slip through. `valid_until` is a `DATE` and the
comparison is made on the calendar day, because a quote valid *until the 5th* is selectable at
any time on the 5th — comparing an instant would expire it at midnight UTC for a buyer whose
working day has not finished.

---

## 5. A Purchase Order is a snapshot, and PostgreSQL proves whose

FR-051 requires an order to be independent of later changes to the supplier, the quote and the
request. So every value is **copied**, and the line table holds **no foreign key** to a quote
line or a request line: a snapshot that a later edit can drag along is not a snapshot.

| Copied from | Fields |
| --- | --- |
| the request line | description, unit of measure, quantity, position |
| the selected quote line | unit price, line total |
| the quote | freight, discount, totals, delivery lead time |
| the supplier | legal name, tax identifier, identifier type |

**Not copied, deliberately:** trade name, contact email, contact phone, the selection rationale
and any cancellation rationale. An order records a legal identity and a price. It is not a copy
of the address book, and it is not the reasoning behind the choice.

### The four-column foreign key

That the order's supplier really is the selected quote's supplier is **not** left to application
code:

```sql
FOREIGN KEY (organization_id, supplier_quote_id, purchase_request_id, supplier_id)
  REFERENCES supplier_quotes (organization_id, id, purchase_request_id, supplier_id)
```

A check in code can be raced, bypassed by another write path, or forgotten during a refactor.
This makes the wrong row unrepresentable. It is the single most important constraint added in
this phase, and `purchase-order-persistence.integration.spec.ts` proves it directly.

### Numbering

`purchase_order_number_sequences` holds one counter per tenant, and allocation is one statement
inside the issuance transaction:

```sql
INSERT INTO purchase_order_number_sequences (organization_id, next_value, updated_at)
     VALUES ($1, 2, CURRENT_TIMESTAMP)
ON CONFLICT (organization_id) DO UPDATE
        SET next_value = purchase_order_number_sequences.next_value + 1
  RETURNING next_value - 1
```

Three properties follow, and all three are load-bearing:

- **The first allocation of an organization returns 1.** Inserting `2` and returning
  `next_value - 1` is what makes that true without a second statement and a window between them.
- **Concurrent issuances serialize** on the counter row's lock, so two buyers produce one order.
- **A rollback consumes no visible number.** The allocation is inside the transaction, so a
  failed audit or outbox write returns the counter with everything else, and the next successful
  issuance gets the value the failed attempt would have had.

A PostgreSQL `SEQUENCE` would have given none of these: sequences are non-transactional (a
rollback burns the value) and are not per tenant.

The format is `PO-000001`, zero-padded to **at least** six digits. The database CHECK says "six
or more" on purpose: an organization that issues more than 999,999 orders gets `PO-1000000`
rather than a wrapped identifier. A format that silently stops being unique is worse than one
that gets longer.

One counter per tenant is also a tenancy decision: `PO-000001` is the first order of *every*
organization, so no tenant can infer another's purchasing volume from the numbers it sees.

---

## 6. Cancellation emits an audit event and no message

FR-054 makes purchase order cancellation terminal and **local**: it does not reopen the request,
does not return it from `ORDERED`, and does not make the selected quote selectable again. The
state machine declares no edge out of `ORDERED` for anything to drive.

No outbox event is written, and that is a decision rather than an omission. FR-062 requires
notifying the next actor, and notifying the requester on approval, on rejection and on order
issuance. Cancellation is none of those, and no consumer in this system subscribes to one.

An event with no reader is not a feature: it is a retry ladder, a dead-letter queue and an
operational surface that nothing justifies. The audit event records the fact; a notification can
be added the day a requirement asks for one.

The same reasoning excludes quote registration, quote withdrawal and supplier maintenance from
the outbox. **Four** outgoing event types exist, and the ones that are absent are as deliberate
as the ones that are present.

---

## 7. Module ownership, and the one inverted dependency

```
supplier ──────────────┐
                       ├──► (published operations) ◄── quotation ──► approval
procurement ◄──────────┘                                    │
     ▲                                                      │
     └───────────────── purchase-order ◄───────────────────┘
```

- `supplier` owns the registry. It publishes `ProveSupplierQuotable` (may this supplier receive a
  new quote, inside this transaction?) and `GetSupplierSnapshot` (what legal identity is this
  order issued against?), which is how the other modules read supplier data without touching the
  table.
- `quotation` owns SupplierQuote and SupplierQuoteItem. It transitions purchase requests only
  through `procurement`'s published operations and changes approval ladders only through
  `approval`'s.
- `purchase-order` owns PurchaseOrder, PurchaseOrderItem and numbering.
- `procurement` still owns the PurchaseRequest state machine, and **does not import** `quotation`
  or `purchase-order`. An ESLint rule fails the build if it ever does, and
  `test/architecture/module-boundaries.spec.ts` proves the rule is not vacuous by linting
  synthetic files at real module paths and asserting both the refusals and the permissions.

### The inverted ports

FR-026 asks a requester's own request read to show which quote won and whether an order was
issued. Both facts belong to other modules, and importing them would invert the dependency the
rest of the system rests on — the only way to express the resulting cycle in Nest is
`forwardRef`, which hides a wrong dependency direction rather than fixing one.

So `procurement` declares two narrow ports in
`application/contracts/purchase-request-supplements.ts`, and the owning modules implement them.
They are injected `@Optional()`, so `procurement` compiles, boots and serves every route it owns
with neither module present.

`QuotationModule` and `PurchaseOrderModule` are `@Global()` for exactly this reason: the provider
that satisfies a port has to be visible to `procurement`'s injector without `procurement`
importing anything from those modules. What each exports is one read.

**This is two named ports with one implementation each, not a plugin registry.** A third fact
would be a third named port, not a list.

---

## 8. Where the money rules live

Quote arithmetic is `quotation/application/support/quote-money.ts`, and it builds on the exact
primitives in `platform/numeric`: the thousandths representation of a quantity
(`scaled-quantity.ts`), the centavo representation of money together with the `BIGINT` storable
range (`centavos.ts`), and the single half-up line-total step (`line-total.ts`). The calendar-day
representation is `platform/calendar/calendar-date.ts`.

Those are *representation*, not any one module's private state, which is why they are in
`platform` rather than in whichever module happened to need them first: two modules that each
define their own idea of "half-up at the centavo" will eventually disagree about a total, and a
disagreement about a total is a disagreement about what a supplier is owed.

What stays with its owner is the part that is only true of that owner. `procurement` keeps the
estimated line and `calculateEstimatedTotalCents`; `quotation` keeps freight, discount and the
refusals BR-032 attaches to them. `platform/persistence/scaled-quantity.mapper.ts` *consumes* the
quantity primitive to talk to the driver and deliberately does not own it — there is no domain
arithmetic in persistence.

The linter enforces the direction. A module may import another module's published use cases,
contracts and declared shared vocabulary, and nothing else of its `application/support`;
`apps/api/test/architecture/module-boundaries.spec.ts` lints synthetic files at real module paths
to prove the rule both refuses `quotation` reaching into `procurement/application/support` and
still permits the published access it needs.

- Each line is `halfUp(quantityThousandths × unitPriceCents / 1000)`, computed **once**
  (BR-033). The multiplication happens in exact integer arithmetic before any division, so the
  single half-up step is the only rounding in the whole calculation.
- The quote total is `sum(rounded line totals) + freight − discount` (FR-042). Lines are summed
  *after* rounding, so the number a buyer sees on a line is the number that contributes to the
  total.
- Nothing is `Number`, `parseFloat`, `toFixed` or a JSON number anywhere in the chain.
- A negative freight, a negative discount, a discount larger than the goods plus freight, and an
  intermediate sum wider than `BIGINT` are all **stated domain refusals**. The overflow check is
  on the intermediate subtotal as well as the result, so a large discount cannot mask it.

`supplier_quotes` restates the identity as a CHECK — `total = items_total + freight − discount` —
so a row whose total disagrees with its own parts cannot exist whatever wrote it.

**No total, line total or quantity is ever accepted from a client.** Quantity comes from the
persisted `PurchaseRequestItem`: a quote prices what was asked for, it does not restate it
(BR-025). The only two things a client sends per line are which line it is and what the unit
price is, and the first is checked against the request's own lines rather than trusted.

---

## 9. The comparison is a bounded keyset page

`GET /purchase-requests/{id}/quotes` (FR-043) is ordered `total_cents ASC, id ASC` and returns
`items` plus an opaque `nextCursor`.

Both halves of the key matter. `total_cents` alone is not unique — two suppliers quoting the same
amount is the ordinary case the comparison exists to resolve — so a cursor carrying only the total
would either skip the rest of a tied group or serve it twice. The quote identifier breaks the tie
with a value that is unique by construction, which makes the pair a total order and puts every
quote on exactly one page.

The cursor is `base64url("<totalCents>|<quoteId>")`. The total is a digit string rather than a
JSON number for the same reason it leaves that way on the wire: a total above 2⁵³ does not survive
an IEEE-754 double, and a cursor that loses precision is a cursor that skips rows. It is not
signed — it carries no secret, and the query that consumes it is scoped to one tenant *and* one
purchase request, so a forged cursor can only move a caller inside a comparison they were already
allowed to read.

A cursor that is not base64url, has no separator, carries a non-canonical total or an identifier
that is not a UUID is a **400**, not an empty page and not a silent restart from the top. The page
size is bounded by the query DTO (1–100, default 20) and restated in the use case for callers with
no HTTP boundary in front of them; an out-of-range value is a 400 rather than a silent clamp.

Withdrawn quotes remain in the page with their status (FR-046). NFR-004 is answered by bounding
the *page* and never the business: there is deliberately no cap on how many suppliers a buyer may
approach, because capping the comparison to make it fit one response would make the comparison
wrong.

---

## 10. Known limitations

- **Rate limiting is process-local.** The budgets on quote selection and purchase order issuance
  live in one process's heap, so they are correct for exactly one API instance and are lost on
  restart. A second instance multiplies the effective allowance by the number of instances. A
  shared counter is a prerequisite for horizontal scaling and belongs to the phase that
  introduces distributed responsibilities.
- **Idempotency records accumulate.** See `docs/architecture/client-idempotency.md` § 6.

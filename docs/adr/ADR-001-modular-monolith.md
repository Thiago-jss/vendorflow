# ADR-001 — Application Architecture Style

**Status:** Accepted
**Date:** 2026-08-30
**Deciders:** Project owner (acting as Principal Engineer / Architect)
**Supersedes:** —
**Superseded by:** —

---

## Context

VendorFlow must implement a single, tightly coupled business workflow: a purchase request
moves through review, quotation, threshold-based approval and purchase-order issuance, with
tenant isolation and an audit trail (see `docs/product/requirements.md`).

The characteristics that actually constrain this decision — not the ones that merely sound
important:

**C-1 — One transactional core.** The system's central operations are state transitions on a
purchase request that must commit atomically together with the approval decision and the
audit event (REL-001, AUD-004). Approval, quotation and ordering are not independent
concerns that occasionally talk; they are steps in one consistency chain.

**C-2 — Side effects must be reliable, and they cross the transaction.** Notifications and
downstream processing must neither be lost on commit nor fire on rollback (REL-002). The
standard solution — committing the *intent* to emit alongside the state change, then
publishing it separately — requires the emitting code and the business write to share one
database transaction.

**C-3 — Tenant isolation is the top-ranked quality attribute.** MT-005 requires scoping at
a single enforced choke point rather than re-implemented per query. A leak is
product-ending. The fewer independent places that construct data access, the smaller the
surface on which this can fail.

**C-4 — Modest, predictable scale.** 500 users and 50,000 requests per organization
(NFR-003). No component has a load profile meaningfully different from the others. There is
no part of this workload that needs to scale, deploy or fail independently.

**C-5 — Team of one.** A single developer builds and operates this. Operational complexity
is paid for out of the same budget as feature work, at full price.

**C-6 — Boundaries will move.** This is a discovery-phase product. Several open questions
(configurable approval policies, delegation, attachments, per-tenant thresholds) will change
where responsibilities sit. Any boundary chosen today is provisional.

**C-7 — The project must be explainable.** It doubles as an engineering reference. The
architecture must be defensible on the merits of *this* system, and a reader must be able to
see why each boundary exists.

**C-8 — Domain complexity is real but bounded.** Fifteen entities, one workflow, one policy
family. This is not a trivial CRUD app — the approval ladder, its re-evaluation after quote
selection, and the audit guarantees carry genuine rules. It is also not a sprawling domain
with several independent subdomains.

## Decision

**VendorFlow is built as a modular monolith: a single deployable backend application,
internally partitioned into modules with explicit boundaries, sharing one PostgreSQL
database and one transactional context.**

Concretely:

1. **Modules are vertical slices by business capability**, not horizontal layers by technical
   type. Initial partition:

   | Module | Owns |
   | --- | --- |
   | `identity-access` | Organization, Branch, Department, User, Role, authentication, authorization primitives |
   | `supplier` | Supplier registry |
   | `procurement` | PurchaseRequest, PurchaseRequestItem, the request state machine |
   | `approval` | ApprovalFlow, ApprovalStep, the approval policy and its evaluation |
   | `quotation` | SupplierQuote, SupplierQuoteItem, selection |
   | `purchase-order` | PurchaseOrder issuance and cancellation |
   | `audit` | AuditEvent — write path and query path |
   | `notification` | Notification production and read state |
   | `platform` | Cross-cutting: tenant scoping, transactions, outbox, correlation, error model |

2. **A module owns its tables.** No module reads or writes another module's tables directly.
   Cross-module reads go through the owning module's published interface.

3. **Modules communicate in-process**, synchronously via published module interfaces, or
   asynchronously via domain events for side effects. Asynchronous is used where the
   requirement is asynchronous (REL-002, REL-006), not to simulate distribution.

4. **One database, one transaction boundary.** A single business operation commits its state
   change, its audit event and its outgoing-effect intent in one transaction (C-1, C-2).

5. **Tenant scoping lives in `platform`** and is enforced for every module (C-3, MT-005).
   Tenant isolation is not a per-module responsibility, because a rule that every module must
   remember is a rule that one module will forget.

6. **Boundaries are enforced mechanically** — module-scoped import rules in the linter and in
   the build. A boundary maintained by discipline alone decays; a boundary that fails CI does
   not.

7. **The audit module's write path is one-directional.** Other modules emit audit facts; no
   module may read, alter or delete them (AUD-003).

## Alternatives Considered

### Alternative A — Traditional layered monolith

One deployable, organized horizontally: `controllers/`, `services/`, `repositories/`,
`entities/`, each containing every entity in the system.

**In its favour:** the lowest-friction structure to start; universally understood; no
boundary rules to maintain; identical operational footprint to the chosen option; genuinely
adequate for many systems this size. Given C-4 and C-5, this is a serious candidate, and
dismissing it as "wrong" would be dishonest.

**Why rejected:**

- **It has no unit of ownership.** Cohesion is by technical kind, so everything related to
  approvals is spread across four directories and nothing related to approvals is grouped.
  With C-6 (boundaries will move), the structure gives no place where a moving
  responsibility lives.
- **Coupling is invisible and therefore unbounded.** Any service may call any other service
  and any repository may be touched by anyone. There is nothing to enforce, so nothing gets
  enforced. At fifteen entities this is survivable; the cost arrives exactly when the domain
  rules get interesting, which is where this project intends to spend its effort (C-8).
- **It weakens the top-ranked quality attribute.** With no ownership of data access, MT-005's
  "single enforced choke point" becomes a convention rather than a structural property (C-3).
- **It teaches the wrong lesson.** For C-7, a layered structure makes it hard to show *why*
  a boundary exists, because the boundaries are technical accidents rather than decisions.

### Alternative B — Microservices

Separate deployables per capability — for example procurement, approval, quotation, ordering
— each with its own database, communicating over the network.

**In its favour:** independent deployment and scaling; strong, unavoidable boundary
enforcement; failure isolation; and the ability to demonstrate distributed-systems technique.

**Why rejected:**

- **It breaks C-1 head-on.** Approving a step, transitioning the request and writing the
  audit event would span services, replacing one local transaction with a distributed
  protocol — sagas, compensations, eventual consistency — to solve a consistency problem that
  does not exist in a single database. This is the decisive objection: it introduces the
  hardest class of bug in the system in exchange for benefits the system does not need.
- **No driver for independent scaling or deployment.** C-4 says the load profile is uniform
  and small. Independent scalability is the primary reason to pay for microservices, and it
  has no claim here.
- **The operational cost lands on one person.** C-5: service discovery, distributed tracing
  as a necessity rather than a nicety, per-service pipelines, versioned contracts between
  services, multi-service local development. All paid for from the feature budget.
- **Boundaries are provisional.** C-6: microservices make boundaries expensive to move,
  precisely when the boundaries are least certain. Distributing a domain you have not yet
  understood is the most common way to arrive at a distributed monolith.
- **Cross-tenant isolation gets harder, not easier.** N services enforcing tenant scope is N
  chances to get C-3 wrong, versus one.
- **Portfolio value does not survive scrutiny.** A reviewer who knows the trade-offs reads
  unjustified microservices as a signal of weak judgement, not strong skill. Choosing
  distribution to look advanced would violate the project's own stated principle against
  infrastructure as decoration.

### Alternative C — Modular monolith (chosen)

Assessed against the same criteria: preserves the single transaction (C-1, C-2), gives
tenant scoping one owner (C-3), matches the scale and the team (C-4, C-5), keeps boundaries
movable while still explicit (C-6), makes each boundary a documentable decision (C-7), and
provides enough structure for the real domain rules without inventing ceremony (C-8).

## Consequences

**Positive**

- Business operations remain single-transaction. Consistency is a property of the database,
  not of a protocol that must be written and debugged.
- Tenant scoping and the transactional-outbox mechanism each have exactly one implementation
  and one owner.
- Local development, testing and CI stay simple: one process to start, one database, one
  pipeline. End-to-end tests do not require orchestrating a fleet.
- Refactoring across boundaries is cheap. Moving a responsibility between modules is an
  in-repository change, not a contract negotiation and a migration.
- Each module is a candidate for later extraction *if* a real driver appears — a genuinely
  different scaling profile, an isolation requirement, a separate team. The decision is
  deferred rather than foreclosed.

**Negative**

- **Boundaries are conventional, not physical, so they need active enforcement.** Without
  the mechanical import rules of point 6, this decays into Alternative A within months.
- **Shared failure domain.** One module can exhaust the process — a memory leak, a hot loop,
  an unbounded query — and take the whole application down. Mitigation is limits and
  observability, not architecture.
- **Deployment is all-or-nothing.** A one-line change to notifications redeploys the
  approval engine. Acceptable at C-4/C-5; unacceptable at a scale this project does not have.
- **Scaling is whole-application scaling.** Fine at the stated target; a real constraint if
  one capability ever becomes disproportionately expensive.
- **A shared database is a standing temptation.** Nothing at the database level stops a
  module from reading another module's table. Table ownership is a convention that must be
  reviewed for; when this matters more, schema separation per module is the next step.

## Trade-offs Accepted

| Given up | Gained | Revisit when |
| --- | --- | --- |
| Independent deployability | One transaction, one consistency model, simple operations | A capability needs a release cadence the rest cannot follow |
| Per-capability scaling | Uniform, predictable resource use at the target scale | One module's load profile diverges measurably from the rest |
| Physically enforced boundaries | Cheap refactoring while boundaries are still being learned | Import rules stop being sufficient, or more than one team contributes |
| Failure isolation between capabilities | No partial-failure semantics to design, test or explain | Availability requirements are stated per capability rather than per system |
| A distributed-systems showcase | An architecture defensible on this system's actual characteristics | Never, on this basis alone. Distribution needs a driver, not an audience |

## Follow-on Decisions Deferred

Recorded here so they are not made accidentally:

- **ADR-002** — Tenant isolation mechanism: how MT-005's single choke point is implemented
  and how an unscoped query is made a detectable defect.
- **ADR-003** — Reliable side effects: the transactional outbox, the publishing path,
  idempotent consumption, retry and dead-lettering (REL-002…REL-006). This is the ADR that
  must justify a message broker with a concrete problem, or decline to introduce one.
- **ADR-004** — Where the approval policy lives: evaluated in code with an isolated
  evaluator, or driven by tenant-owned configuration (Open Question 1).
- **ADR-005** — Caching policy: what may be cached, and how the rule that a cache is never
  authoritative is enforced rather than merely intended.
- **ADR-006** — Testing strategy: which guarantees are proven without infrastructure, which
  require a real database, and how cross-tenant isolation (MT-007) is verified.

## Compliance

This ADR is satisfied when:

1. The backend is a single deployable with the module partition above.
2. Cross-module imports that bypass a published module interface fail the build.
3. Tenant scoping has exactly one implementation, owned by `platform`.
4. A business state change and its audit event are written in one transaction.
5. No module writes to another module's tables.

Violations are defects against this ADR, not stylistic preferences. If a violation is
correct, this ADR is amended or superseded — it is not ignored.

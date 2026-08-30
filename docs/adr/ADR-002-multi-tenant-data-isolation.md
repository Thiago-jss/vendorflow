# ADR-002 — Multi-Tenant Data Isolation

## Status

**Accepted**
**Date:** 2026-08-30
**Deciders:** Project owner (acting as Principal Engineer / Architect)
**Supersedes:** —
**Superseded by:** —

## Context

Organization is VendorFlow's tenant and security boundary. Branch and Department are
subdivisions inside an Organization: they may constrain a person's responsibility, but they
must never select a database tenant. PostgreSQL is authoritative for business state, and the
API and background worker share one transactional core under ADR-001.

The primary threat in the MVP is an authenticated or unauthenticated client manipulating an
identifier, filter, relationship, or pagination cursor so that application code reads or
changes another Organization's row. Accidental unscoped queries by contributors are also in
scope. A compromised database administrator, a hostile process with production database
credentials, and regulatory requirements for physical customer separation are not current
threat-model drivers. Those stronger threats would justify a different operational cost.

Authentication, tenant isolation, authorization, and resource responsibility are separate
decisions:

1. authentication establishes who the principal is;
2. tenant isolation limits all candidate data to the principal's Organization;
3. authorization decides which actions the principal's roles may perform there; and
4. responsibility rules decide whether this particular resource is in the principal's
   branch, department, ownership, assignment, or workflow boundary.

A role check cannot replace any of the other three decisions. This ADR establishes the
tenant boundary before identity or business tables exist; it does not implement
authentication, RBAC, procurement, outbox, consumers, or CRUD.

The bootstrap placed Prisma under `apps/api`, even though the worker will need the same
schema, migration history, and transaction infrastructure for outbox publication,
reconciliation, and database-backed workflows. Redis is provisioned but has no runtime
responsibility. RabbitMQ is transport, not an identity authority. The neutral
`platform_metadata` table only made the initial migration concrete.

## Decision

VendorFlow will use **application-level tenant scoping at module-owned persistence
boundaries, backed by PostgreSQL relational constraints as defense in depth**.

Every application operation starts with a `TrustedPrincipal` whose `organizationId` was
established by future authentication infrastructure. NestJS exposes that principal through
a request-scoped `TenantContext`. Client bodies, paths, queries, ordinary headers, and
cookies never populate the context directly. Application entry points obtain the trusted
principal and pass its tenant scope into use cases and persistence methods.

Every repository method for tenant-owned data is scoped by construction. For example:

```ts
findPurchaseRequest({
  organizationId: principal.organizationId,
  id: purchaseRequestId,
});
```

There will be no public `findPurchaseRequestById(id)` followed by a tenant check after the
row has been loaded. Module persistence adapters are the places where Prisma queries are
constructed; controllers and use cases do not import Prisma Client. Repositories follow
business/application responsibilities rather than one interface per table, and there is no
generic base repository.

Prisma, its authoritative schema, and its one migration history move to
`packages/database`. That package exposes database infrastructure but owns no business
rules. The API uses it now. The worker may use it when a real database-backed responsibility
is introduced; until then the worker neither imports the module nor requires
`DATABASE_URL`. Neither process requires Redis while Redis has no runtime responsibility.

PostgreSQL Row-Level Security (RLS) is not the primary mechanism for the MVP. It remains a
documented evolution option and may later be added as a second independent enforcement
layer after transaction-local tenant settings, connection-pool behavior, migrations,
privileged maintenance paths, and tests have been designed explicitly.

## Alternatives Considered

### 1. Application-level tenant scoping — chosen

Tenant predicates are applied in the module's persistence adapter, before data is read or
changed. The design matches Prisma and the current modular monolith, keeps tenant authority
visible in method signatures, supports one PostgreSQL transaction across modules, and is
straightforward to exercise in tests. PostgreSQL constraints prevent cross-tenant
relationships even if an application validation is missed.

Its weakness is that PostgreSQL does not automatically reject every omitted tenant
predicate. VendorFlow compensates with restricted Prisma imports, deliberately scoped
repository APIs, review rules, tenant-aware constraints, and PostgreSQL-real adversarial
integration tests. An unscoped query is a security defect.

### 2. PostgreSQL Row-Level Security — deferred defense-in-depth option

RLS can make the database inject or enforce tenant predicates and can protect against some
application omissions. It is attractive for a product where tenant isolation outranks
convenience.

It is not chosen as the primary mechanism now because a pooled Prisma connection must set
the correct tenant transaction-locally for every operation, avoid context leakage between
requests, define behavior for background jobs and migrations, prevent owner or privileged
roles from bypassing policies, and keep test and production connection roles equivalent.
Mistakes in that plumbing can create a false sense of safety while making failures harder to
diagnose. RLS also does not replace authorization, responsibility checks, or composite
foreign keys. These costs are not justified before tenant-owned tables and real query shapes
exist.

### 3. Schema per tenant — rejected

A PostgreSQL schema per Organization offers namespace separation, but makes connection
search paths, schema provisioning, Prisma generation, migrations, cross-tenant operations,
and onboarding proportional to the number of customers. It also does not provide physical
resource isolation. VendorFlow's target scale, single-team operation, and shared data model
do not justify that fleet of schemas.

### 4. Database per tenant — rejected for the current threat model

A database per Organization gives the strongest blast-radius and credential separation of
the evaluated options and may be appropriate for regulated or high-value enterprise
customers. It also multiplies provisioning, migrations, backups, monitoring, connection
pools, incident response, and cross-customer operational work. That cost conflicts with the
current product stage and one-team operating model. No current requirement demands physical
separation.

## Security Invariants

1. A principal in Organization A cannot read, enumerate, infer, create a reference to,
   update, delete, approve, or otherwise affect protected data in Organization B.
2. Tenant authority originates only from a verified principal. A client-supplied
   `organizationId` is data to reject or ignore, never authorization authority.
3. Organization is the tenant. Branch and Department are responsibility scopes inside that
   tenant and never replace `organizationId` in a tenant predicate.
4. Every tenant-owned row carries a non-null `organization_id` and belongs to exactly one
   Organization.
5. Every tenant-owned query constrains `organization_id` before returning or mutating data.
   Filtering after loading an arbitrary row is prohibited.
6. Cross-tenant misses are indistinguishable from absent resources at the product boundary.
   Error shape, timing, counts, logs returned to clients, and pagination metadata must not
   disclose another tenant's row.
7. Roles grant capabilities only after tenant isolation. Responsibility and resource state
   are evaluated separately; Administrator is not a tenant or workflow bypass.
8. PostgreSQL, not Redis or RabbitMQ, is authoritative for business state, membership,
   relationships, and decisions.
9. Tenant context is request-local or operation-local. There is no mutable process-global
   current tenant.

## Data Access Rules

- HTTP/security infrastructure will authenticate and bind a `TrustedPrincipal` once per
  request. Controllers resolve it through `TenantContext` and pass it to an application use
  case. Use cases never parse JWTs, cookies, headers, query parameters, or request bodies to
  determine the tenant.
- Public repository operations for tenant-owned resources require an explicit
  `organizationId` taken from the trusted principal, ideally in one criteria object with the
  resource identifier. An unscoped overload is prohibited.
- A single-resource read uses both tenant and resource identity in its database predicate.
  If no row matches, the application returns its ordinary not-found result; it does not run
  a second unscoped query to distinguish “foreign” from “missing.”
- Updates and deletes include tenant scope in the mutation predicate. Use a tenant-aware
  compound unique selector where the model has one, or a scoped bulk mutation whose affected
  row count must be exactly the expected count. Do not fetch unscoped and then mutate by ID.
- List, count, aggregate, search, export, filter, and pagination queries always include the
  tenant predicate. Cursor lookup itself must be tenant-scoped; cursors must not reveal
  foreign row contents, counts, or ordering.
- Relationship creation resolves or connects both sides inside the same Organization.
  Application validation improves the error, but a composite foreign key is the final
  protection against a race or missed check.
- Raw SQL is exceptional, parameterized, locally reviewed, and carries an explicit
  `organization_id` predicate. `$queryRawUnsafe` and string-built SQL are prohibited.
- Cross-module transactions pass the same Prisma transaction client and the same trusted
  tenant scope. No nested operation may substitute a tenant from its payload.
- Direct `@prisma/client` imports are restricted to `packages/database`. Business modules
  use `@vendorflow/database` only inside explicit persistence adapters. As modules are
  introduced, lint/architecture rules must make controller/use-case access to raw database
  infrastructure fail CI.
- Any future platform-wide or support operation that truly crosses tenants requires a
  separately named interface, separately authenticated authority, audit, and tests. It must
  not be an optional `organizationId` on a tenant repository. No such operation exists in
  the MVP.

## Defense in Depth

Future migrations for tenant-owned tables must enforce these PostgreSQL patterns:

1. **Tenant column and parent.** Add non-null `organization_id` with a foreign key to the
   owning Organization. Use deliberate `ON DELETE` behavior; business and audit history
   must not disappear through an accidental cascade.
2. **Tenant-aware identity target.** A referenced tenant-owned parent exposes a candidate
   key such as `UNIQUE (organization_id, id)`, even when `id` is globally unique. This lets
   child relationships carry and prove tenant equality.
3. **Composite foreign keys.** A relationship between tenant-owned records includes the
   tenant on both sides. Conceptually:

   ```sql
   FOREIGN KEY (organization_id, supplier_id)
     REFERENCES supplier (organization_id, id)
   ```

   A PurchaseRequest in Organization A therefore cannot reference a Supplier, Department,
   User, Quote, Approval Flow, or other parent in Organization B. The same pattern applies
   to indirect children such as items and approval steps; denormalizing `organization_id`
   onto a child is intentional when it permits the database to enforce the boundary.

4. **Tenant-aware uniqueness.** Business keys that are unique per customer use composite
   constraints such as `(organization_id, tax_identifier)`, `(organization_id, email)`, or
   `(organization_id, purchase_order_number)`. Global uniqueness is used only when it is a
   stated product rule.
5. **Tenant-leading indexes.** Indexes serving product queries begin with
   `organization_id`, followed by filter/order columns. A typical stable keyset pagination
   index is `(organization_id, created_at DESC, id DESC)`. Constraint indexes and query
   indexes are reviewed separately; one does not automatically satisfy the other.
6. **Checks and nullability.** `NOT NULL`, `CHECK`, enum/domain constraints, and appropriate
   referential actions enforce invariants that PostgreSQL can express. Application checks
   remain for useful errors, not as the only safeguard.
7. **Transactions.** Relationship validation, state mutation, audit facts, and later outbox
   records commit in the same database transaction. Transaction callbacks receive an
   explicit tenant scope and use tenant-scoped predicates throughout.
8. **Migration review.** Every migration adding a tenant-owned table must identify its
   tenant FK, compound relationship FKs, tenant-aware unique constraints, product query
   indexes, delete behavior, and PostgreSQL-real isolation tests. A migration missing this
   analysis is incomplete.

RLS, if adopted later, supplements these constraints. It does not replace composite foreign
keys, unique constraints, authorization rules, or explicit tenant-aware repository APIs.

RabbitMQ receives no identity authority. A future authorized application operation will
write business state and an outbox record containing its trusted Organization context in
one PostgreSQL transaction. The worker may publish that committed event. A consumer treats
the message tenant identifier as provenance/coordinates from a trusted internal pipeline,
not as proof that an arbitrary requested action is authorized; it re-enters through a named
system-operation boundary, scopes all database work, validates relationships, and remains
idempotent. Externally publishable queues would require a separate trust-boundary decision.

Redis remains non-authoritative and disposable. Future cache keys, rate-limit buckets, or
coordination records involving tenant data must include Organization identity derived from
trusted context. A cache miss or Redis outage cannot change a business authorization or
decision.

## Consequences

**Positive**

- Tenant selection is explicit at application and repository boundaries and easy to explain
  in code review.
- Query-level scoping avoids loading a foreign row before deciding access.
- Composite PostgreSQL constraints make cross-tenant references invalid under races,
  mistakes, or alternate write paths.
- One database and transaction model remain compatible with audit and outbox guarantees.
- One shared Prisma owner lets API and worker depend inward on database infrastructure;
  neither application imports the other.
- Unused Redis and worker-database configuration no longer make a process unavailable.

**Negative**

- The primary read-isolation mechanism still depends on correctly scoped application
  queries. Tests, import restrictions, repository shape, and review are mandatory controls.
- Tenant keys appear in persistence signatures and indexes throughout the product. This is
  deliberate repetition of a security boundary, not optional boilerplate.
- Composite foreign keys add columns and migration complexity, particularly on child rows.
- PostgreSQL-real integration tests are slower than unit tests and require lifecycle tooling
  that is not introduced until real tenant-owned tables exist.

The `platform_metadata` table remains temporarily in the authoritative schema solely to
preserve the concrete bootstrap migration. It has no runtime reader or business meaning. Do
not add artificial records or tables around it. Remove it with a new migration when the
first real domain migration makes it unnecessary; never rewrite an already-applied migration
to erase it.

## Trade-offs

| Accepted trade-off                                                    | Benefit                                                               | Revisit when                                                                                                          |
| --------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Application discipline plus mechanical tests instead of immediate RLS | Clear Prisma behavior and low operational complexity                  | Unscoped-query risk remains high after real repositories, or hostile in-process/credential threats enter scope        |
| Shared rows instead of schema/database per tenant                     | One schema, migration fleet, pool, backup plan, and transaction model | Regulation, contractual isolation, tenant-specific residency, or blast-radius requirements demand physical separation |
| Explicit tenant parameters in repository methods                      | Scope is visible and testable                                         | Never remove visibility; only supplement it with stronger enforcement                                                 |
| Composite keys and duplicated tenant columns on children              | PostgreSQL can reject cross-tenant references                         | A different physical isolation model makes row-level relationships obsolete                                           |
| Worker does not connect to PostgreSQL yet                             | Boot dependencies match real responsibilities                         | The outbox publisher, reconciliation job, or first database-backed workflow is implemented                            |

## Verification Strategy

Tests added by this issue cover only introduced primitives: the request-local principal is
an immutable snapshot, a client-shaped property cannot populate it, missing context fails
closed, rebinding is rejected, and unused Redis/database values are not required by processes
that do not use them.

Each future tenant-owned resource requires adversarial API and PostgreSQL-real integration
tests with at least two Organizations. The suite must prove:

1. Tenant A can access its own resource.
2. Tenant A cannot read Tenant B's resource by a known ID.
3. Tenant A cannot update Tenant B's resource.
4. Tenant A cannot delete Tenant B's resource.
5. Tenant A cannot create a relationship to Tenant B's entity.
6. List, search, count, aggregate, and export endpoints never return or count Tenant B rows.
7. Every pagination direction, cursor, filter, and sort combination remains isolated.
8. Foreign and nonexistent identifiers produce the same externally observable not-found
   behavior without a revealing secondary lookup.
9. Direct SQL attempts to create cross-tenant relationships fail on PostgreSQL constraints.
10. Concurrent and transactional write paths preserve the same scope and cannot bypass a
    constraint.

These tests run against real PostgreSQL with migrations applied; an in-memory database or a
mocked Prisma client cannot prove foreign keys, compound uniqueness, transaction behavior,
query plans, or future RLS. Unit tests remain appropriate for pure principal, authorization,
responsibility, and domain-policy logic. Static import rules and migration review provide
additional detection, but no single layer is treated as sufficient.

## Evolution Path

1. **First domain migration:** introduce Organization and its owned hierarchy only when the
   identity-access feature needs them. Apply the constraints above and remove
   `platform_metadata` in a new migration when safe.
2. **First module repository:** expose only tenant-scoped operations, add module import
   boundaries, and establish the reusable two-tenant PostgreSQL integration-test harness.
3. **Worker persistence:** when ADR-003 introduces a transactional outbox or a real
   database-backed job, let the worker depend on `@vendorflow/database`, require
   `DATABASE_URL`, and define a trusted system-operation context. Do not reuse HTTP parsing
   or accept arbitrary queue tenant claims.
4. **RLS defense layer:** if risk warrants it, prototype policies on real tables using a
   non-owner application role and transaction-local tenant setting. Test pool reuse,
   rollbacks, background operations, migrations, `FORCE ROW LEVEL SECURITY`, and fail-closed
   behavior before calling RLS protective.
5. **Physical isolation:** if contractual, regulatory, residency, or customer blast-radius
   needs exceed shared-table controls, migrate selected or all tenants to database-per-tenant
   routing. Preserve the application-level tenant contract so this is an infrastructure
   evolution rather than a rewrite of every use case. Schema-per-tenant remains a possible
   intermediate step only if its migration and pooling costs are justified by a concrete
   requirement.

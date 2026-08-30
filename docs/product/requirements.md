# VendorFlow — Requirements

**Status:** Draft (Phase 0 — Product Discovery)
**Last updated:** 2026-08-30

Identifier prefixes: `FR` functional · `BR` business rule · `NFR` non-functional ·
`SEC` security · `AUTHZ` authorization · `MT` multi-tenancy · `AUD` auditability ·
`REL` reliability.

Identifiers are stable. If a requirement is dropped, its ID is retired, never reused.

Requirements marked **[ASSUMPTION]** were not stated in the source brief and were decided
here to remove ambiguity. Each is listed again in § 11 for review.

---

## 1. Actors

| Actor | Responsibility |
| --- | --- |
| **Employee** | Creates purchase requests, follows their progress |
| **Manager** | Reviews requests inside their responsibility boundary |
| **Buyer** | Runs quotation, registers supplier quotes, selects the winning quote |
| **Finance** | Approves when the monetary policy requires it |
| **Administrator** | Manages organizational structure, users and role assignments |

Actors are **roles**, not accounts. One user may hold several roles (FR-006, AUTHZ-002).

---

## 2. Functional Requirements

### 2.1 Organization and structure

- **FR-001** An Administrator can create and maintain **Branches** within their organization.
- **FR-002** An Administrator can create and maintain **Departments**, each belonging to
  exactly one Branch.
- **FR-003** An Administrator can create user accounts within their organization and
  assign each user to a Branch and a Department.
- **FR-004** An Administrator can deactivate a user. Deactivation blocks authentication and
  removes the user from pending actor queues; it never deletes historical records.
- **FR-005** The system provides a fixed set of roles: Employee, Manager, Buyer, Finance,
  Administrator. Custom role definition is out of MVP scope.
- **FR-006** An Administrator can grant and revoke roles for a user. A user may hold
  multiple roles simultaneously.

### 2.2 Suppliers

- **FR-010** A Buyer or Administrator can register a Supplier with identifying data
  (legal name, trade name, tax identifier, contact email, contact phone).
- **FR-011** Suppliers belong to the organization that registered them and are not shared
  across organizations (MT-002).
- **FR-012** A Supplier can be deactivated. A deactivated Supplier cannot receive new
  quotation requests but remains attached to historical quotes and purchase orders.
- **FR-013** Supplier tax identifier is unique within an organization.

### 2.3 Purchase Request

- **FR-020** An Employee can create a Purchase Request in `DRAFT`, containing a
  justification, a needed-by date, and one or more Purchase Request Items.
- **FR-021** A Purchase Request Item carries a description, quantity, unit of measure and
  an **estimated unit price**. Estimated prices are the requester's expectation, never the
  basis for the purchase order.
- **FR-022** A request in `DRAFT` may be freely edited or deleted by its requester.
- **FR-023** A requester can submit a `DRAFT` request, moving it to `SUBMITTED`. After
  submission the request becomes immutable to the requester.
- **FR-024** On submission the system computes the **estimated total** and materializes an
  **Approval Flow** with the Approval Steps required by the monetary policy (BR-001).
- **FR-025** A requester can cancel their own request at any state before `ORDERED`.
- **FR-026** A requester can view the current state, the pending step and the full step
  history of their own requests.

### 2.4 Approval

- **FR-030** A Manager sees a queue of requests in `SUBMITTED` inside their responsibility
  boundary (AUTHZ-004).
- **FR-031** A Manager can **approve** or **reject** a submitted request. Rejection requires
  a reason of at least 10 characters.
- **FR-032** Manager approval moves the request to `IN_QUOTATION`. Rejection moves it to
  `REJECTED`, which is terminal.
- **FR-033** After a winning quote is selected, the system evaluates the remaining approval
  steps against the **selected quote total** (BR-002, BR-003).
- **FR-034** A Buyer acting on the Purchasing approval step, and a Finance user acting on
  the Finance approval step, can approve or reject with the same semantics as FR-031.
- **FR-035** Approval steps are executed **in sequence**. A step cannot be acted on while an
  earlier step is pending.
- **FR-036** Every approval decision records the acting user, the decision, the reason (when
  present), the monetary amount the decision was made against, and the timestamp.

### 2.5 Quotation

- **FR-040** A Buyer can register a **Supplier Quote** against a request in `IN_QUOTATION`,
  choosing an active Supplier of the organization.
- **FR-041** A Supplier Quote contains one **Supplier Quote Item** per Purchase Request
  Item, with the quoted unit price; plus quote-level freight, discount, validity date and
  delivery lead time in days.
- **FR-042** The system computes the quote total as
  `sum(item quantity × quoted unit price) + freight − discount`.
- **FR-043** A Buyer can list all quotes for a request side by side, ordered by total.
- **FR-044** A Buyer can **select** exactly one quote per request, with a mandatory
  selection rationale. Selection is required even when only one quote exists.
- **FR-045** Selecting a quote moves the request to `IN_FINAL_APPROVAL`, or straight to
  `APPROVED` when no approval step remains (BR-002).
- **FR-046** A quote may be **withdrawn** by the Buyer while it is not selected. Withdrawn
  quotes remain visible in history and are excluded from selection.

### 2.6 Purchase Order

- **FR-050** When a request reaches `APPROVED`, a Buyer can issue a **Purchase Order**.
- **FR-051** A Purchase Order is derived from exactly one approved request and its selected
  quote. Its lines, prices, supplier and total are copied from the selected quote at
  issuance time and are thereafter independent of later changes to supplier records.
- **FR-052** Issuing a Purchase Order moves the request to `ORDERED`.
- **FR-053** A Purchase Order carries a human-readable identifier unique within the
  organization.
- **FR-054** A Purchase Order can be **cancelled** with a reason by a Buyer or an
  Administrator. Cancellation is terminal; it does not return the request to a prior state.

### 2.7 Audit and notification

- **FR-060** Every consequential business action produces an **Audit Event** (AUD-001).
- **FR-061** An Administrator can query audit events for their organization, filtered by
  aggregate, actor, event type and time range.
- **FR-062** The system notifies the user who must act next when a request enters a state
  requiring their action, and notifies the requester on approval, rejection and order
  issuance.
- **FR-063** Notifications are readable in-app and can be marked as read. Delivery channels
  beyond in-app are out of MVP scope.

---

## 3. Business Rules

### 3.1 Approval policy

- **BR-001** Required approval steps are determined by a monetary amount in **BRL**:

  | Amount | Required steps, in order |
  | --- | --- |
  | ≤ 1,000.00 | Manager |
  | > 1,000.00 and ≤ 5,000.00 | Manager → Purchasing |
  | > 5,000.00 | Manager → Purchasing → Finance |

  **[ASSUMPTION]** The brief states "up to 1,000" and "1,001 through 5,000", which leaves
  amounts between them undefined. Boundaries are interpreted as continuous intervals with
  the upper bound inclusive, as tabled above.

- **BR-002** The **Manager** step is evaluated against the **estimated total** at submission
  and gates entry into quotation. The **Purchasing** and **Finance** steps are evaluated
  against the **selected quote total** and gate the purchase order. When the selected quote
  total falls in the lowest tier, no step remains after selection and the request becomes
  `APPROVED` immediately (FR-045).
  **[ASSUMPTION]** The brief does not say which amount the policy is applied to. Splitting
  it this way is required because the real price is unknown before quotation, while a
  manager must gate work before buyers spend effort on it.

- **BR-003** If the selected quote total lands in a **higher tier** than the estimated total,
  the missing steps are **appended** to the existing approval flow. Already-completed steps
  are never re-executed. If it lands in a **lower** tier, pending steps that the lower tier
  does not require are **voided** (recorded, not deleted).

- **BR-004** A request rejected at any step is terminal. Continuing requires a new request.
  There is no re-submission of a rejected request in the MVP.

- **BR-005** A user may not approve a step on a request they created, even when they hold
  the required role. Self-approval is refused with no fallback.
  **[ASSUMPTION]** Not stated in the brief; adopted as a baseline segregation-of-duties rule.

- **BR-006** An approval decision is **final**. There is no un-approve. Reversal happens only
  through cancellation of the request or of the purchase order.

### 3.2 Purchase request lifecycle

- **BR-010** Valid states: `DRAFT`, `SUBMITTED`, `IN_QUOTATION`, `IN_FINAL_APPROVAL`,
  `APPROVED`, `ORDERED`, `REJECTED`, `CANCELLED`.

- **BR-011** Legal transitions, and nothing else:

  ```
  DRAFT              → SUBMITTED | CANCELLED
  SUBMITTED          → IN_QUOTATION | REJECTED | CANCELLED
  IN_QUOTATION       → IN_FINAL_APPROVAL | APPROVED | CANCELLED
  IN_FINAL_APPROVAL  → APPROVED | REJECTED | CANCELLED
  APPROVED           → ORDERED | CANCELLED
  ORDERED            → (terminal)
  REJECTED           → (terminal)
  CANCELLED          → (terminal)
  ```

- **BR-012** A request must contain at least one item to be submitted, and every item must
  have quantity > 0 and estimated unit price ≥ 0.

- **BR-013** A request cannot be cancelled once `ORDERED`. The purchase order is cancelled
  instead (FR-054).

### 3.3 Quotation

- **BR-020** Quotes may only be registered while the request is `IN_QUOTATION`.
- **BR-021** A Supplier Quote must price **every** item of the request. Partial quotes are
  rejected.
- **BR-022** At most one Supplier Quote per Supplier per request may be active at a time.
  Registering a replacement requires withdrawing the previous one.
- **BR-023** A quote past its validity date cannot be selected.
- **BR-024** Exactly one quote is selected per request. Selection is immutable once the
  request leaves `IN_QUOTATION`.
- **BR-025** Quoted prices are captured as recorded; the system does not normalize,
  negotiate or adjust them.

### 3.4 Money and units

- **BR-030** All monetary amounts are **BRL only**. Currency is not a field in the MVP.
- **BR-031** Monetary values are stored as **integer minor units (centavos)**. No binary
  floating-point type is used for money at any layer, including transport.
  **[ASSUMPTION]** Storage decision, not stated in the brief; taken now because it is
  expensive to retrofit.
- **BR-032** Totals are computed by the backend and never accepted from a client. A total
  supplied in a request payload is ignored.
- **BR-033** Rounding, when unavoidable, is half-up at the centavo, applied once at the line
  total, never at the unit price.

### 3.5 Organizational structure

- **BR-040** A Department belongs to exactly one Branch. A Branch belongs to exactly one
  Organization.
- **BR-041** A user belongs to exactly one Branch and one Department.
  **[ASSUMPTION]** Multi-department membership is a plausible real requirement but doubles
  the complexity of the authorization boundary; excluded from the MVP.
- **BR-042** A purchase request belongs to the Department of its requester at creation time.
  Later moves of the user do not retroactively reassign existing requests.

---

## 4. Non-Functional Requirements

- **NFR-001** The entire system is written in TypeScript, end to end.
- **NFR-002** p95 latency for authenticated read endpoints ≤ 300 ms, and for write
  endpoints ≤ 500 ms, measured at the API boundary excluding client network time, on a
  dataset of at least 10,000 purchase requests per organization.
- **NFR-003** The system targets a working scale of 500 users and 50,000 purchase requests
  per organization. This is a design target, not a hard limit; it exists to prevent both
  under- and over-engineering.
- **NFR-004** Every list endpoint is paginated. No endpoint returns an unbounded collection.
- **NFR-005** The whole stack — application, database, supporting services — starts locally
  with a single documented command.
- **NFR-006** Automated tests run in CI on every push and pull request; the pipeline is the
  merge gate.
- **NFR-007** Domain rules (state machine, approval policy, monetary computation) are
  covered by tests that execute without infrastructure. Their correctness must not depend on
  a running database.
- **NFR-008** Structured logging with a correlation identifier propagated across the request
  and any asynchronous continuation of it.
- **NFR-009** The API is documented from the same source of truth used for request
  validation, so the contract cannot silently diverge from behaviour.
- **NFR-010** Database schema changes are applied exclusively through versioned migrations
  committed to the repository.

---

## 5. Security Requirements

- **SEC-001** Authentication uses short-lived access tokens plus refresh tokens. The access
  token carries the user identity, organization identifier and effective roles.
- **SEC-002** Passwords are stored with a memory-hard adaptive hash (Argon2id or bcrypt).
  Plaintext or reversible storage is prohibited.
- **SEC-003** Refresh tokens are revocable server-side; revocation takes effect on the next
  refresh. Logout revokes the presented refresh token.
- **SEC-004** All input crossing the API boundary is validated against an explicit schema
  before reaching domain logic. Unknown fields are rejected, not ignored.
- **SEC-005** Database access is exclusively parameterized. String-built SQL is prohibited.
- **SEC-006** Authentication and approval endpoints are rate-limited per principal and per
  source address.
- **SEC-007** Error responses expose no internal detail: no stack traces, no SQL, no
  internal identifiers of other tenants. Existence of a resource in another tenant is never
  disclosed (see MT-004).
- **SEC-008** Secrets are supplied by environment configuration. No secret is committed to
  the repository, and CI fails on detection.
- **SEC-009** Personal data in logs is limited to identifiers. Names, emails, and full
  request payloads are not written to application logs.
- **SEC-010** Dependency vulnerability scanning runs in CI, and known high-severity findings
  block the merge.

---

## 6. Authorization Requirements

- **AUTHZ-001** Authorization is enforced **server-side on every request**. Client-side
  checks are presentation only and carry no security weight.
- **AUTHZ-002** Permission is a function of `(role set, tenant, responsibility boundary,
  resource state)`. Role alone is never sufficient — a Manager is a Manager *of a
  boundary*, and a Finance user may act only on steps assigned to Finance.
- **AUTHZ-003** Default deny. An action with no explicit grant is refused.
- **AUTHZ-004** **[ASSUMPTION]** A Manager's responsibility boundary is their **Department**.
  Branch-level and organization-wide managerial scope are recognized as likely real needs
  and deferred; the model must not make them expensive to add later. Buyer, Finance and
  Administrator act at **organization** scope.
- **AUTHZ-005** A workflow transition is authorized against both the actor's permission and
  the **current state** of the aggregate. A Buyer may not select a quote on a request that
  is not `IN_QUOTATION`, regardless of role.
- **AUTHZ-006** Only the pending Approval Step's assigned role may act on it (FR-035).
- **AUTHZ-007** Administrators manage structure and identity. Administrator is **not** a
  bypass of the approval policy: an Administrator holds no implicit approval authority.
- **AUTHZ-008** Every authorization denial is logged with actor, resource, attempted action
  and reason.

---

## 7. Multi-Tenancy Requirements

- **MT-001** The **Organization** is the tenant boundary. Branch and Department are
  authorization scopes *inside* a tenant, never tenant boundaries themselves.
- **MT-002** Every tenant-owned record carries an organization identifier. Tenant-owned
  entities in the MVP: Branch, Department, User, Supplier, PurchaseRequest,
  PurchaseRequestItem, ApprovalFlow, ApprovalStep, SupplierQuote, SupplierQuoteItem,
  PurchaseOrder, AuditEvent, Notification.
- **MT-003** The tenant identifier is derived **exclusively from the authenticated
  principal**. It is never read from a request path, query string, body or header.
- **MT-004** A request for a resource belonging to another organization is answered as
  **not found**, not as forbidden. Cross-tenant existence must not be inferable.
- **MT-005** Tenant scoping is applied at a single enforced choke point in data access, not
  re-implemented per query. A new query must be scoped by construction, and it must be
  possible to demonstrate that an unscoped query is a detectable defect.
- **MT-006** Uniqueness constraints that are conceptually per-tenant (supplier tax
  identifier, purchase order number, user email) are enforced as composite constraints
  including the organization identifier.
- **MT-007** Cross-tenant isolation is verified by automated tests that attempt direct
  identifier access across organizations for every tenant-owned resource type.
- **MT-008** Caches, background jobs and asynchronous message payloads carry the tenant
  identifier. A cache key without a tenant component is a defect.

---

## 8. Auditability Requirements

- **AUD-001** Audited actions in the MVP: request submitted, request cancelled, approval
  step approved, approval step rejected, approval flow extended or voided (BR-003), quote
  registered, quote withdrawn, quote selected, purchase order issued, purchase order
  cancelled, supplier created or deactivated, user role granted or revoked, user
  deactivated, authorization denied.
- **AUD-002** An Audit Event records: organization, actor, event type, target aggregate type
  and identifier, occurrence timestamp, and a typed payload describing the change.
- **AUD-003** Audit events are **append-only**. The application performs no update or delete
  against audit storage, and the application's database role holds no such privilege.
- **AUD-004** An audit event is recorded in the **same transaction** as the business change
  that caused it. A committed business change without its audit event, or the reverse, is a
  correctness bug — not an acceptable degradation.
- **AUD-005** Audit events are ordered per aggregate such that the sequence of decisions on a
  request is reconstructable without ambiguity.
- **AUD-006** Audit events are queryable by organization, aggregate, actor, event type and
  time range (FR-061).
- **AUD-007** Tamper-evidence beyond append-only storage (hash chaining, external anchoring)
  is deliberately **not** in the MVP. The event shape must not preclude adding it.

---

## 9. Reliability Requirements

- **REL-001** State transitions and their consequences are **atomic**. A request never
  observes a state where the approval step is decided but the request state is not, or a
  purchase order exists without the request being `ORDERED`.
- **REL-002** Side effects of a business action (notification, downstream processing) must
  not be lost when the transaction commits, and must not fire when it rolls back. This
  requires the intent to emit the effect to be committed together with the state change.
- **REL-003** Side-effect processing is **at-least-once**. Every consumer of an effect is
  **idempotent** — reprocessing the same effect twice produces the same end state.
- **REL-004** Client-initiated operations that create durable artifacts — submission,
  approval decision, quote selection, purchase order issuance — accept an **idempotency key**
  so that a retried request cannot produce a duplicate.
- **REL-005** Concurrent decisions on the same aggregate are serialized. Two approvers acting
  on the same step simultaneously result in exactly one recorded decision; the loser receives
  a conflict response, never a silent overwrite.
- **REL-006** Failures in side-effect processing are retried with backoff and, on exhaustion,
  are parked in a dead-letter destination for inspection. Failures are never dropped
  silently, and never block the originating business transaction.
- **REL-007** The system remains able to serve reads and accept business transactions when
  the notification path is degraded. Notification delivery is not on the critical path of a
  purchase decision.
- **REL-008** Health and readiness endpoints distinguish "process alive" from "dependencies
  usable", so an unready instance is not sent traffic.

---

## 10. MVP Scope

**In scope — entities:** Organization, Branch, Department, User, Role, Supplier,
PurchaseRequest, PurchaseRequestItem, ApprovalFlow, ApprovalStep, SupplierQuote,
SupplierQuoteItem, PurchaseOrder, AuditEvent, Notification.

**In scope — capabilities:** organizational structure and identity management; supplier
registry; purchase request authoring and submission; threshold-driven approval flow;
supplier quotation and comparison; quote selection; purchase order issuance; audit trail;
in-app notifications; tenant isolation; server-side authorization.

### Non-Goals

Explicitly excluded from the MVP, and not to be accommodated speculatively in the design:

| Non-goal | Note |
| --- | --- |
| Payment processing | Out of the product boundary entirely |
| Accounting / ledger | Downstream of the purchase order |
| Inventory management | Different domain |
| ERP integration | Deliberately not designed for now |
| Invoice processing | Post-order, not modelled |
| Native mobile application | Responsive web only |
| Artificial intelligence features | No supplier scoring, no price prediction |
| Multi-currency | BRL only (BR-030) |
| Supplier marketplace / supplier self-service portal | Suppliers are records, not users |
| Custom / configurable role definitions | Fixed role set (FR-005) |
| Per-tenant configurable approval thresholds | Fixed policy (BR-001) — see § 12 |
| Approval delegation / substitute approver | Recognized gap, see § 12 |
| Budget ceilings per department | Horizon 3 |
| Email or push notification delivery | In-app only (FR-063) |
| Attachments on requests or quotes | Recognized gap, see § 12 |

---

## 11. Assumptions Register

| # | Assumption | Requirement | Risk if wrong |
| --- | --- | --- | --- |
| A-1 | Tier boundaries are continuous intervals, upper bound inclusive | BR-001 | Low — a policy edit, no structural change |
| A-2 | Manager approves the estimated total; Purchasing and Finance approve the selected quote total | BR-002 | **High** — changes the workflow shape and the state machine |
| A-3 | A manager's responsibility boundary is the Department | AUTHZ-004 | Medium — changes the authorization scope model |
| A-4 | A user belongs to exactly one Department | BR-041 | Medium — affects the identity model and queue queries |
| A-5 | Self-approval is prohibited | BR-005 | Low — a rule addition |
| A-6 | Rejection is terminal; no re-submission | BR-004 | Medium — adds states and transitions if wrong |
| A-7 | Money as integer minor units, BRL only | BR-030, BR-031 | Low if kept, expensive to retrofit if skipped |
| A-8 | Suppliers are records, not authenticated users | FR-010, Non-Goals | **High** — supplier login would add an actor, a trust boundary and a public surface |
| A-9 | One quote is selected per request; requests are not split across suppliers | BR-024 | Medium — partial-award splitting would change the PO model |
| A-10 | A purchase order is fully derived from one selected quote | FR-051 | Medium |

Facts taken directly from the brief — and therefore **not** assumptions: the actor set, the
three-tier threshold amounts, Organization as the tenant boundary, backend authority over
permissions and transitions, the requirement for an auditable history, the MVP entity list
and the exclusion list.

## 12. Open Domain Questions

1. **Configurable thresholds.** The policy is fixed. Real customers will want per-tenant
   thresholds. Does the MVP model the policy as data (evaluated by a rule engine over
   tenant-owned configuration) or as code? Current position: **as code**, with the
   evaluation isolated so it can become data-driven without touching the workflow.
2. **Approver absence.** If the only Manager of a department is on leave, the request stalls
   indefinitely. Delegation, escalation and substitute approvers are all unmodelled.
3. **Attachments.** Real quotations arrive as PDFs. Without attachments, buyers will keep
   the authoritative document outside the system, weakening SC-5.
4. **Post-order reality.** Deliveries arrive late, partially, or wrong. `ORDERED` is
   terminal, so the system cannot represent what actually happened. Acceptable for the MVP;
   a real deployment would need receipt.
5. **Estimated vs. actual divergence.** BR-003 handles tier changes, but there is no rule
   for a selected quote that is wildly above the estimate within the same tier. Should a
   large relative overrun force re-approval regardless of tier?
6. **Quotation sufficiency.** Should a minimum number of quotes be required above a
   threshold — a common real procurement control? Not required today (FR-044 permits one).
7. **Data retention.** Audit events are append-only forever. No retention or archival policy
   is defined, and no deletion path exists for personal-data erasure requests.

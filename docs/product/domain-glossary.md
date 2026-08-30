# VendorFlow — Domain Glossary

**Status:** Draft (Phase 0 — Product Discovery)
**Last updated:** 2026-08-30

This glossary defines **business concepts** — the shared language between the product and
the code. It deliberately does not define classes, tables, interfaces or types. Naming in
the implementation should follow these terms; where the code must diverge, the divergence is
a decision to be recorded, not an accident.

Two words are used precisely throughout:

- **Actor** — a person acting in a role (Requester, Approver, Buyer).
- **Aggregate** — a business object with its own lifecycle, consistency rules and identity
  (Purchase Request, Supplier Quote, Purchase Order).

---

## Organizational concepts

### Organization
The customer of VendorFlow, and the **tenant boundary** of the system. Everything a user can
see or touch belongs to exactly one Organization. Data never crosses this line, in either
direction, under any circumstance. An Organization owns branches, departments, users,
suppliers and every business record produced by them.

*Not to be confused with:* a Supplier. A Supplier is a company VendorFlow knows about; an
Organization is a company that uses VendorFlow.

### Branch
A physical or administrative unit of an Organization — a site, an office, a plant. Groups
departments. In the MVP, a Branch is structural: it organizes the hierarchy and gives context
to a request, but it does not carry approval authority of its own.

### Department
The unit inside a Branch that people belong to and that requests are attributed to.
A Department is the **responsibility boundary of a Manager**: it answers "whose requests are
these to review?". A Department belongs to exactly one Branch.

### Tenant
The isolation unit — in VendorFlow, always the Organization. "Tenant-scoped" means an
operation is constrained to the Organization of the authenticated actor, derived from the
authenticated identity and never from anything the caller supplies. Branch and Department
are *scopes within* a tenant; they are not tenants.

### User
A person with credentials in one Organization. A User belongs to one Branch and one
Department, and holds one or more Roles. Users are deactivated, never deleted, because they
appear in history that must remain readable.

### Role
A named set of capabilities: **Employee**, **Manager**, **Buyer**, **Finance**,
**Administrator**. A Role is *what a user may do*, not *who they are* — one person can be
both a Manager and a Buyer. A Role by itself never grants access to a record: the boundary
(Department or Organization) and the record's current state also decide.

---

## Actor concepts

### Requester
The role a user plays when they create a Purchase Request. Not a separate Role — normally an
Employee. The Requester is fixed at creation and follows the request through its life; they
may cancel it before it becomes an order, and they may never approve it.

### Approver
The role a user plays when they decide an Approval Step. Which users can be an Approver
depends on the step: Manager steps are decided by a Manager of the request's Department,
Purchasing steps by a Buyer, Finance steps by a Finance user. An Approver decides against a
**specific monetary amount**, which is recorded with the decision.

### Buyer
The actor who runs the sourcing side of the process: registers Supplier Quotes, compares
them, selects the winner, issues the Purchase Order. In the approval policy, the Buyer is
also the actor of the **Purchasing** approval step. Buyers act at Organization scope, not
department scope — purchasing is a shared function.

### Manager
The actor who decides whether a need is legitimate and worth pursuing, before any buying
effort is spent. Reviews requests from their own Department.

### Finance
The actor who decides whether the Organization will commit the money, for amounts above the
policy threshold. Finance enters late — after a real price exists — because approving a
guess is not a financial control.

### Administrator
The actor who maintains the Organization's structure and identities: branches, departments,
users, role assignments. Administrator is an operational authority, **not** a business
authority: it confers no approval power and no ability to bypass the workflow.

---

## Purchasing concepts

### Purchase Request
The central aggregate: a documented, justified need for goods or services, raised by a
Requester and carried through review, quotation, approval and ordering. It owns its items,
its state, and its Approval Flow. A Purchase Request expresses *what is needed and why*; it
does not decide *from whom, at what price* — that is the Quote's job.

Its life is a state machine (`DRAFT → SUBMITTED → IN_QUOTATION → IN_FINAL_APPROVAL →
APPROVED → ORDERED`, with `REJECTED` and `CANCELLED` as terminal exits). The state is the
single answer to "where is this?", and only defined transitions change it.

### Purchase Request Item
One line of a need: a description, a quantity, a unit of measure and an **estimated unit
price**. The estimate is the Requester's expectation — used to size the request for the
Manager's decision, and *never* used as the purchase price. Items exist only inside their
Purchase Request and have no independent life.

### Approval
A single recorded decision — approve or reject — made by an Approver against a step, an
amount and a moment in time. An Approval is a **historical fact**: once recorded it is not
edited, withdrawn or reversed. Changing the outcome means cancelling the request, not
rewriting the decision.

### Approval Flow
The full chain of approvals a specific Purchase Request must pass. It is **materialized at
submission** from the policy in force, so that the request carries its own ladder rather than
re-deriving it on every read. The flow knows which step is pending, which are done, and how
they are ordered. It can be **extended** (a higher-priced quote pulled in Finance) or have
pending steps **voided** (a cheaper quote removed a required step) — both are recorded events,
never silent edits.

### Approval Step
One position in an Approval Flow: a sequence number, a required role (Manager, Purchasing,
Finance), a status (pending, approved, rejected, voided), and — once decided — the deciding
user, the reason, the amount decided against, and the timestamp. Steps are decided **in
order**: a pending step blocks every step after it.

### Approval Policy
The rule that maps a monetary amount to the required chain of Approval Steps. In VendorFlow
it is a threshold ladder in BRL: Manager alone up to 1,000; Manager and Purchasing to 5,000;
Manager, Purchasing and Finance above that. The policy is the *rule*; the Approval Flow is
the *instance of that rule applied to one request*.

---

## Supply concepts

### Supplier
A company the Organization can buy from: legal identity, tax identifier, contact details.
A Supplier is a **record maintained by the Organization**, not a user of the system —
suppliers do not log in, do not submit quotes themselves, and see nothing. A Supplier is
deactivated rather than deleted, because it is referenced by history.

### Supplier Quote
A supplier's priced answer to a Purchase Request, registered by a Buyer: a price for every
item, plus freight, discount, validity date and delivery lead time. A Quote is a **complete
alternative** — it must price every item, so that quotes can be compared as whole offers
rather than assembled line by line. A Quote has a total, computed by the system, and a
validity window after which it can no longer be selected.

### Supplier Quote Item
One supplier's price for one Purchase Request Item. It exists only inside a Quote, and always
corresponds to exactly one item of the request being quoted.

### Quote Selection
The Buyer's act of choosing the winning Supplier Quote, with a written rationale. Selection
is what turns a set of options into a commitment path: it fixes the real amount, which the
remaining approval steps are then decided against. Exactly one quote is selected per request,
and the choice is final once the request leaves quotation. The rationale matters as much as
the choice — the cheapest quote is not always the right one, and the reason must survive.

### Purchase Order
The document that authorizes the purchase: the Organization's formal instruction to a
Supplier, derived from one fully approved Purchase Request and its selected Quote. It is a
**snapshot** — its lines, prices, supplier data and total are copied at issuance, so later
edits to supplier records or quotes cannot rewrite what was ordered. It carries an identifier
that people quote to each other in conversation. A Purchase Order can be cancelled, with a
reason; it is never silently modified.

*In VendorFlow, the Purchase Order is the end of the line.* What happens after — delivery,
invoice, payment, accounting — is outside the system boundary.

---

## Cross-cutting concepts

### Audit Event
An immutable record that something consequential happened: who did it, in which Organization,
to which aggregate, what kind of event it was, when, and what changed. Audit Events are
**produced by the domain as facts**, in the same transaction as the change they describe —
not reconstructed afterwards from table history. They are appended and never modified, so
that the sequence of decisions behind any purchase can be replayed months later.

An Audit Event is not a log line. Logs serve operators and are allowed to be lossy; audit
events serve the business and are not.

### Notification
A message telling a user that the process needs them, or that something they care about
changed: a step is waiting for their decision, their request was approved, their order was
issued. Notifications are **derived** from business events and carry no authority of their
own — losing a notification must never lose a decision, and the workflow's correctness never
depends on one being delivered.

### Idempotency Key
A caller-supplied identifier that makes a repeated request produce the original result
instead of a second one. It exists because networks retry: a lost response to "issue the
purchase order" must not become two purchase orders.

### Correlation Identifier
A value that ties together everything done on behalf of one original request — across the
API call, the database work and any asynchronous continuation — so a single business action
can be followed end to end when diagnosing behaviour.

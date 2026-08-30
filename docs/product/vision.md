# VendorFlow — Product Vision

**Status:** Draft (Phase 0 — Product Discovery)
**Last updated:** 2026-08-30

---

## 1. Problem

In small and mid-sized organizations, buying something is rarely a single act. Someone
needs an item, someone else must agree the money can be spent, someone must find a
supplier and a price, and — past a certain amount — someone in Finance must sign off.

Today this process typically runs on email threads, spreadsheets and messaging apps.
That produces four recurring failures:

1. **No authoritative state.** Nobody can answer "where is my request right now?" without
   asking a person.
2. **No enforced authorization.** Approval limits exist as policy documents, not as system
   rules. They are bypassed by accident and by pressure.
3. **No comparable quotations.** Supplier prices arrive in three different formats and are
   compared informally, so the selection rationale disappears.
4. **No audit trail.** When a purchase is questioned months later, the reasoning, the
   approvers and the rejected alternatives cannot be reconstructed.

The cost is not primarily money lost on bad prices. It is **elapsed time**, **rework**, and
**unaccountable spending decisions**.

## 2. Product Hypothesis

If the purchase request, its approval chain, the supplier quotations and the resulting
purchase order live in **one system that owns the workflow state and enforces the approval
policy**, then:

- requesters stop chasing status,
- approvers act inside their real authority,
- buyers compare quotations on equal terms,
- and every consequential action leaves a durable, queryable record.

## 3. Target User

Organizations of roughly **20–500 people**, possibly spread across multiple **branches**,
internally structured into **departments**, that:

- already have an informal approval policy based on monetary thresholds,
- purchase from a recurring set of suppliers,
- do **not** have (or do not want to extend) a full ERP procurement module.

VendorFlow is deliberately **upstream of the ERP**: it governs the decision to buy, not the
accounting consequences of having bought.

## 4. Value Proposition

| Actor | What they get |
| --- | --- |
| Employee (Requester) | Submit a need, see exactly which step it is on and who is holding it |
| Manager | A single queue of requests inside their responsibility boundary, with the numbers needed to decide |
| Buyer | Structured quotations from suppliers, side by side, with a recorded selection rationale |
| Finance | Guaranteed involvement above the policy threshold — enforced by the system, not by convention |
| Administrator | Organizational structure, identities and roles configured in one place, isolated per organization |

## 5. Product Principles

1. **The backend is the authority.** The UI presents state; it never decides who may do
   what, nor which transition is legal. Any rule that matters is enforced server-side.
2. **Explicit workflow over implicit convention.** A purchase request is a state machine
   with named states and named transitions, not a status field updated ad hoc.
3. **Tenant isolation is not a feature — it is a precondition.** Every read and write is
   scoped to an organization. There is no "global" query in the product surface.
4. **Consequential actions are recorded, not inferred.** The audit trail is produced by the
   domain as events, not reconstructed later from table diffs.
5. **Depth over breadth.** One procurement flow modelled well is worth more than five
   modules modelled shallowly. Scope is defended aggressively (see Non-Goals).

## 6. Success Criteria

The MVP is successful when a single organization can run a purchase end to end with no
out-of-band coordination:

- **SC-1** A requester can create a purchase request and, at any moment, see its current
  state and the pending actor without contacting anyone.
- **SC-2** An approval that violates the monetary policy is impossible through the API, not
  merely discouraged by the UI.
- **SC-3** At least two supplier quotations for the same request can be compared on
  normalized totals, and the selected one is recorded with its selector and timestamp.
- **SC-4** A purchase order is derived from an approved request and a selected quotation,
  and can never be issued from either alone.
- **SC-5** For any issued purchase order, the full history — who requested, who approved at
  each step, which quotations lost and why the winner was picked — is reconstructable from
  the audit trail.
- **SC-6** A principal authenticated in Organization A receives no data from Organization B
  under any request shape, including direct identifier access.

## 7. What VendorFlow Is Not

VendorFlow does not process payments, keep accounting ledgers, track inventory, integrate
with ERPs, process invoices, or act as a supplier marketplace. It stops at the issued
purchase order. See `requirements.md` § Non-Goals for the binding list.

## 8. Horizons

- **Horizon 1 (MVP)** — Single organization, the full request → approval → quotation →
  selection → purchase order flow, audit trail, in-app notifications.
- **Horizon 2** — Operational hardening: asynchronous processing of side effects with
  retry and dead-lettering, delivery guarantees for notifications, performance baselines
  under load, observability.
- **Horizon 3** — Depth on the domain: supplier performance history, budget ceilings per
  department, delegation of approval authority, request templates.

Horizons 2 and 3 are direction, not commitment. Only Horizon 1 is in scope for the
requirements document.

## 9. Secondary Objective (Explicit)

VendorFlow is also an **engineering reference project**. Every significant decision must be
expressible as:

> Problem → Decision → Alternative considered → Implementation → Trade-off accepted

This is a real constraint on the design: a solution that works but cannot be explained in
that form is treated as a worse solution. It is **not** a licence to add infrastructure for
demonstration purposes — technology enters the system only when a concrete problem in this
product justifies it.

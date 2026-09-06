-- Approval workflow and the audit trail it needs.
-- Forward-only. Introduces the tenant-owned approval ladder (ApprovalFlow, ApprovalStep) and
-- the append-only AuditEvent. Organization remains the tenant boundary, so every new table
-- carries organization_id and proves tenant equality with each parent through a composite
-- foreign key (ADR-002).
--
-- Migration review (ADR-002, "Defense in Depth", point 8):
--   tenant FK           : organization_id -> organizations(id), ON DELETE RESTRICT (all three)
--   relationship FKs    : approval_flows  (organization_id, purchase_request_id)
--                             -> purchase_requests(organization_id, id)
--                         approval_steps  (organization_id, approval_flow_id, purchase_request_id)
--                             -> approval_flows(organization_id, id, purchase_request_id)
--                         approval_steps  (organization_id, purchase_request_id)
--                             -> purchase_requests(organization_id, id)
--                         approval_steps  (organization_id, decided_by_id)
--                             -> users(organization_id, id)
--                         audit_events    (organization_id, actor_id) -> users(organization_id, id)
--   tenant-aware unique : (organization_id, id) on approval_flows and approval_steps;
--                         (organization_id, purchase_request_id) on approval_flows — one flow
--                         per request; (organization_id, id, purchase_request_id) on
--                         approval_flows, so a step cannot name a different request than its
--                         flow; (organization_id, approval_flow_id, sequence) on
--                         approval_steps; (organization_id, aggregate_type, aggregate_id,
--                         sequence) on audit_events
--   product query index : purchase_requests (organization_id, department_id, status,
--                         created_at DESC, id DESC) for the manager queue;
--                         approval_steps (organization_id, purchase_request_id, sequence) for
--                         requester detail and history;
--                         approval_steps partial (organization_id, role, purchase_request_id)
--                         WHERE state = 'ACTIONABLE' for "what is waiting on me";
--                         the audit uniqueness above is the aggregate-ordering index
--   delete behaviour    : RESTRICT everywhere. Approval and audit history must survive a
--                         rejection or a cancellation, so nothing here cascades.
--   isolation tests     : apps/api/test/integration/approval-workflow-persistence.integration.spec.ts
--                         apps/api/test/integration/approval-workflow-http.integration.spec.ts

-- BR-001 names three responsibilities in the ladder. Deliberately a separate type from
-- "role": an approval step names a responsibility in the flow, and the principal role that
-- may act on it is a separate mapping (a Purchasing step is decided by a BUYER).
CREATE TYPE "approval_step_role" AS ENUM ('MANAGER', 'PURCHASING', 'FINANCE');

-- The actionable lifecycle, stated explicitly rather than inferred from which timestamps
-- happen to be null. ACTIONABLE is the single step a flow is waiting on; PENDING steps exist
-- but may not be decided before the steps ahead of them complete (FR-035); VOIDED records a
-- step that will never be decided without deleting it (AUD-003).
CREATE TYPE "approval_step_state" AS ENUM ('PENDING', 'ACTIONABLE', 'APPROVED', 'REJECTED', 'VOIDED');

CREATE TYPE "approval_flow_state" AS ENUM ('ACTIVE', 'COMPLETED', 'REJECTED', 'VOIDED');

-- AUD-001, restricted to the transitions this phase can actually produce. A value is added
-- when the action that emits it exists, not before.
CREATE TYPE "audit_event_type" AS ENUM (
    'PURCHASE_REQUEST_SUBMITTED',
    'PURCHASE_REQUEST_CANCELLED',
    'APPROVAL_STEP_APPROVED',
    'APPROVAL_STEP_REJECTED'
);

CREATE TYPE "audit_aggregate_type" AS ENUM ('PURCHASE_REQUEST');

CREATE TABLE "approval_flows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "purchase_request_id" UUID NOT NULL,
    "state" "approval_flow_state" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "approval_flows_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_flows_organization_id_id_key" UNIQUE ("organization_id", "id"),
    -- FR-024: exactly one flow per request. BR-003 later extends this flow rather than
    -- creating a second one.
    CONSTRAINT "approval_flows_organization_id_purchase_request_id_key"
        UNIQUE ("organization_id", "purchase_request_id"),
    -- Lets a step prove, in PostgreSQL, that it belongs to the same request as its flow.
    CONSTRAINT "approval_flows_organization_id_id_request_id_key"
        UNIQUE ("organization_id", "id", "purchase_request_id")
);

CREATE TABLE "approval_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "approval_flow_id" UUID NOT NULL,
    -- Denormalized from the flow and proven equal to it by the composite foreign key below,
    -- so the steps of a request can be read without joining through the flow.
    "purchase_request_id" UUID NOT NULL,
    -- Server-assigned, 1-based and gap-free at creation.
    "sequence" INTEGER NOT NULL,
    "role" "approval_step_role" NOT NULL,
    "state" "approval_step_state" NOT NULL DEFAULT 'PENDING',
    -- FR-036/BR-002: the amount this step was evaluated against, captured when the step was
    -- materialized. Integer centavos, never a float (BR-031).
    "evaluated_amount_cents" BIGINT NOT NULL,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_reason" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "approval_steps_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_steps_sequence_check" CHECK ("sequence" > 0),
    CONSTRAINT "approval_steps_evaluated_amount_cents_check"
        CHECK ("evaluated_amount_cents" >= 0),
    -- BR-006: a decided step carries who decided it and when, and an undecided one carries
    -- neither. The database, not only the application, refuses the half-written decision
    -- that an alternate write path would otherwise leave behind. Written as two directions
    -- rather than a single boolean equality so a partial decision (exactly one of
    -- decided_by_id/decided_at set) is rejected in every state, not only accepted whenever
    -- both sides of an equality happen to be false.
    CONSTRAINT "approval_steps_decision_identity_check"
        CHECK (
            (
                "state" IN ('APPROVED', 'REJECTED')
                AND "decided_by_id" IS NOT NULL
                AND "decided_at" IS NOT NULL
            )
            OR (
                "state" IN ('PENDING', 'ACTIONABLE', 'VOIDED')
                AND "decided_by_id" IS NULL
                AND "decided_at" IS NULL
            )
        ),
    -- FR-031: a rejection states why, in at least 10 non-whitespace characters.
    CONSTRAINT "approval_steps_rejection_reason_check"
        CHECK ("state" <> 'REJECTED'
               OR ("decision_reason" IS NOT NULL
                   AND char_length(btrim("decision_reason")) >= 10)),
    -- A stored reason is a real one: blank text is refused rather than kept as evidence.
    CONSTRAINT "approval_steps_decision_reason_check"
        CHECK ("decision_reason" IS NULL OR char_length(btrim("decision_reason")) > 0),
    -- An undecided step has no reason to carry.
    CONSTRAINT "approval_steps_undecided_reason_check"
        CHECK ("state" IN ('APPROVED', 'REJECTED') OR "decision_reason" IS NULL),
    CONSTRAINT "approval_steps_organization_id_id_key" UNIQUE ("organization_id", "id"),
    -- Deterministic ordering: two steps of one flow can never share a sequence.
    CONSTRAINT "approval_steps_organization_id_flow_id_sequence_key"
        UNIQUE ("organization_id", "approval_flow_id", "sequence")
);

CREATE TABLE "audit_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "event_type" "audit_event_type" NOT NULL,
    "aggregate_type" "audit_aggregate_type" NOT NULL,
    "aggregate_id" UUID NOT NULL,
    -- AUD-005: 1-based and unique per (organization, aggregate), assigned inside the same
    -- transaction as the business change. The ordering therefore does not depend on clock
    -- resolution, and a second writer racing for the same position is refused by the unique
    -- constraint rather than silently interleaved.
    "sequence" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    -- Typed at the emitting boundary. Amounts inside the payload are digit strings, for the
    -- same reason amounts are strings on the wire: a JSON number is a double to every reader
    -- (BR-031).
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_events_sequence_check" CHECK ("sequence" > 0),
    CONSTRAINT "audit_events_payload_object_check" CHECK (jsonb_typeof("payload") = 'object'),
    CONSTRAINT "audit_events_organization_id_aggregate_sequence_key"
        UNIQUE ("organization_id", "aggregate_type", "aggregate_id", "sequence")
);

ALTER TABLE "approval_flows"
    ADD CONSTRAINT "approval_flows_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "approval_flows"
    ADD CONSTRAINT "approval_flows_organization_id_purchase_request_id_fkey"
    FOREIGN KEY ("organization_id", "purchase_request_id")
    REFERENCES "purchase_requests"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "approval_steps"
    ADD CONSTRAINT "approval_steps_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Three columns, not two: the step's request must be the flow's request, and PostgreSQL is
-- what enforces it.
ALTER TABLE "approval_steps"
    ADD CONSTRAINT "approval_steps_organization_id_flow_id_request_id_fkey"
    FOREIGN KEY ("organization_id", "approval_flow_id", "purchase_request_id")
    REFERENCES "approval_flows"("organization_id", "id", "purchase_request_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "approval_steps"
    ADD CONSTRAINT "approval_steps_organization_id_purchase_request_id_fkey"
    FOREIGN KEY ("organization_id", "purchase_request_id")
    REFERENCES "purchase_requests"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- BR-005 is an application rule; this is the tenant half of it, which PostgreSQL can prove:
-- a decision may not be attributed to a user of another organization.
ALTER TABLE "approval_steps"
    ADD CONSTRAINT "approval_steps_organization_id_decided_by_id_fkey"
    FOREIGN KEY ("organization_id", "decided_by_id") REFERENCES "users"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "audit_events"
    ADD CONSTRAINT "audit_events_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "audit_events"
    ADD CONSTRAINT "audit_events_organization_id_actor_id_fkey"
    FOREIGN KEY ("organization_id", "actor_id") REFERENCES "users"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- FR-035/AUTHZ-006 as a database invariant: a flow is waiting on at most one step. The
-- application promotes exactly one step to ACTIONABLE at materialization; this is what makes
-- a second one impossible even from an alternate write path or a race.
CREATE UNIQUE INDEX "approval_steps_one_actionable_step_per_flow_key"
    ON "approval_steps" ("organization_id", "approval_flow_id")
    WHERE "state" = 'ACTIONABLE';

-- Requester detail and ordered history (FR-026).
CREATE INDEX "approval_steps_organization_id_request_id_sequence_idx"
    ON "approval_steps" ("organization_id", "purchase_request_id", "sequence");

-- "What is waiting on me": the actionable steps of one responsibility, tenant-leading.
CREATE INDEX "approval_steps_organization_id_role_actionable_idx"
    ON "approval_steps" ("organization_id", "role", "purchase_request_id")
    WHERE "state" = 'ACTIONABLE';

-- FR-030. The manager queue: one department's requests in one state, newest first, with id
-- breaking ties so keyset pagination is stable.
CREATE INDEX "purchase_requests_organization_id_department_id_status_idx"
    ON "purchase_requests" ("organization_id", "department_id", "status", "created_at" DESC, "id" DESC);

-- AUD-003. Append-only is a property of the storage, not a habit of the caller: an UPDATE or
-- DELETE against an audit event is refused by PostgreSQL whatever issued it. Restricting the
-- application's database role is the operational half of the same rule and belongs to
-- deployment; this half travels with the schema.
CREATE FUNCTION "audit_events_append_only"() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only: % is not permitted', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_events_append_only_trigger"
    BEFORE UPDATE OR DELETE ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION "audit_events_append_only"();

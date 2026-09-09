-- Reliable side effects: the transactional outbox and durable consumer receipts.
-- Forward-only. Introduces the committed intent REL-002 requires and the durable
-- deduplication REL-003 requires, both tenant-owned (ADR-002, ADR-003).
--
-- Migration review (ADR-002, "Defense in Depth", point 8):
--   tenant FK           : organization_id -> organizations(id), ON DELETE RESTRICT (both tables)
--   relationship FKs    : none. Both tables are polymorphic over the aggregate, for the same
--                         reason audit_events is: a RESTRICT reference to every future
--                         aggregate would make an operational table a reason a business row
--                         cannot be removed. outbox_consumer_receipts deliberately holds no
--                         foreign key to outbox_messages either — see below.
--   tenant-aware unique : (organization_id, id) on outbox_messages, so a consumer can prove
--                         tenant and identity in one predicate;
--                         (consumer, event_id) primary key on outbox_consumer_receipts, which
--                         is the idempotency invariant itself
--   product query index : none. Neither table serves a product query in this phase. The
--                         claim index is a deliberate cross-tenant infrastructure index and
--                         is documented as such at its definition; the tenant-leading
--                         investigation indexes exist for operators, not for the product.
--   delete behaviour    : RESTRICT to organizations. Rows are deleted only by a future
--                         retention job, never by a cascade from business data.
--   isolation tests     : apps/api/test/integration/outbox-persistence.integration.spec.ts
--                         apps/worker/test/integration/outbox-publisher.integration.spec.ts
--                         apps/worker/test/integration/outbox-consumer.integration.spec.ts
--
-- Deliberate difference from audit_events: these tables are MUTABLE OPERATIONAL STATE and
-- carry no append-only trigger. The relay rewrites status, lease and attempt fields for the
-- life of a row, and a later retention job may delete published rows. The audit trail is the
-- history; the outbox is transport bookkeeping. Conflating them would either break the relay
-- or weaken AUD-003.

CREATE TYPE "outbox_message_status" AS ENUM ('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED');

-- The outgoing facts this phase actually emits. A value is added when the transition that
-- emits it exists, not before.
CREATE TYPE "outbox_event_type" AS ENUM (
    'PURCHASE_REQUEST_SUBMITTED',
    'PURCHASE_REQUEST_APPROVAL_DECIDED'
);

-- Separate from audit_aggregate_type on purpose: what may be audited and what may be
-- published are different decisions and must be free to diverge.
CREATE TYPE "outbox_aggregate_type" AS ENUM ('PURCHASE_REQUEST');

CREATE TABLE "outbox_messages" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id"  UUID NOT NULL,
    "event_type"       "outbox_event_type" NOT NULL,
    "schema_version"   SMALLINT NOT NULL DEFAULT 1,
    "aggregate_type"   "outbox_aggregate_type" NOT NULL,
    "aggregate_id"     UUID NOT NULL,
    "correlation_id"   UUID NOT NULL,
    "occurred_at"      TIMESTAMPTZ(3) NOT NULL,
    "payload"          JSONB NOT NULL,
    "status"           "outbox_message_status" NOT NULL DEFAULT 'PENDING',
    "attempt_count"    INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leased_by"        VARCHAR(100),
    "lease_expires_at" TIMESTAMPTZ(3),
    "published_at"     TIMESTAMPTZ(3),
    "last_error"       VARCHAR(500),
    "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "outbox_messages_organization_id_id_key" UNIQUE ("organization_id", "id"),
    CONSTRAINT "outbox_messages_attempt_count_check" CHECK ("attempt_count" >= 0),
    CONSTRAINT "outbox_messages_schema_version_check" CHECK ("schema_version" >= 1),
    -- The lifecycle as a database invariant rather than a relay convention. An invalid
    -- combination — a PENDING row still holding a lease, a PUBLISHED row with no timestamp,
    -- a PUBLISHING row with no lease to expire — is unrepresentable, so a relay bug is a
    -- failed statement instead of a message that is silently never published again.
    CONSTRAINT "outbox_messages_status_check" CHECK (
        CASE "status"
            WHEN 'PENDING'
                THEN "leased_by" IS NULL AND "lease_expires_at" IS NULL AND "published_at" IS NULL
            WHEN 'PUBLISHING'
                THEN "leased_by" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "published_at" IS NULL
            WHEN 'PUBLISHED'
                THEN "leased_by" IS NULL AND "lease_expires_at" IS NULL AND "published_at" IS NOT NULL
            WHEN 'FAILED'
                THEN "leased_by" IS NULL AND "lease_expires_at" IS NULL AND "published_at" IS NULL
        END
    )
);

ALTER TABLE "outbox_messages"
    ADD CONSTRAINT "outbox_messages_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The relay's claim scan, and the one index in this repository that deliberately does not
-- lead with organization_id. It serves a trusted cross-tenant infrastructure sweep — the
-- separately named claim operation in the worker — and never a product query. Partial on
-- PENDING so the index holds only rows that are actually claimable.
CREATE INDEX "outbox_messages_claimable_idx"
    ON "outbox_messages" ("next_attempt_at", "created_at", "id")
    WHERE "status" = 'PENDING';

-- Recovery after a relay dies holding a lease. Partial, because an expired lease is only
-- meaningful while the row is PUBLISHING.
CREATE INDEX "outbox_messages_expired_lease_idx"
    ON "outbox_messages" ("lease_expires_at")
    WHERE "status" = 'PUBLISHING';

-- REL-006: exhausted failures are inspectable, not silent. This is the operator's entry point.
CREATE INDEX "outbox_messages_failed_idx"
    ON "outbox_messages" ("created_at")
    WHERE "status" = 'FAILED';

-- Investigation: everything one tenant emitted about one aggregate, in order.
CREATE INDEX "outbox_messages_organization_id_aggregate_idx"
    ON "outbox_messages" ("organization_id", "aggregate_type", "aggregate_id", "created_at");

-- REL-003. One consumer's durable proof that it already processed one event.
--
-- The primary key IS the idempotency mechanism. A redelivered message loses the insert, and
-- the consumer produces no second observable effect. This table exists precisely because
-- broker redelivery semantics are not an idempotency mechanism.
--
-- No foreign key to outbox_messages: RESTRICT would make every receipt a reason its outbox
-- row can never be pruned, and CASCADE would silently delete the proof that something was
-- already processed. The consumer validates the originating row by (organization_id, id).
CREATE TABLE "outbox_consumer_receipts" (
    "consumer"        VARCHAR(100) NOT NULL,
    "event_id"        UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "event_type"      "outbox_event_type" NOT NULL,
    "delivery_count"  INTEGER NOT NULL DEFAULT 1,
    "processed_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_consumer_receipts_pkey" PRIMARY KEY ("consumer", "event_id"),
    CONSTRAINT "outbox_consumer_receipts_delivery_count_check" CHECK ("delivery_count" >= 1)
);

ALTER TABLE "outbox_consumer_receipts"
    ADD CONSTRAINT "outbox_consumer_receipts_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "outbox_consumer_receipts_organization_id_processed_at_idx"
    ON "outbox_consumer_receipts" ("organization_id", "processed_at");

-- Procurement domain foundation.
-- Forward-only. Introduces the tenant-owned purchase request core: the request itself and
-- its items. Organization remains the tenant boundary, so both tables carry organization_id
-- and prove tenant equality with every parent through a composite foreign key (ADR-002).
--
-- Migration review (ADR-002, "Defense in Depth", point 8):
--   tenant FK                : organization_id -> organizations(id), ON DELETE RESTRICT
--   relationship FKs         : (organization_id, requester_id)   -> users(organization_id, id)
--                              (organization_id, department_id)  -> departments(organization_id, id)
--                              (organization_id, purchase_request_id)
--                                                               -> purchase_requests(organization_id, id)
--   tenant-aware unique      : (organization_id, id) on both tables;
--                              (organization_id, purchase_request_id, position) on items
--   product query index      : (organization_id, requester_id, created_at DESC, id DESC)
--   delete behaviour         : RESTRICT everywhere except request -> items, which CASCADEs
--                              because an item has no life outside its request
--   isolation tests          : apps/api/test/integration/purchase-request-persistence.integration.spec.ts
--                              apps/api/test/integration/purchase-request-http.integration.spec.ts

-- BR-010 in full. Declaring every state now means a later phase adds transitions, not a
-- migration; a state the application refuses to reach is an application rule, not a schema
-- gap.
CREATE TYPE "purchase_request_status" AS ENUM (
    'DRAFT',
    'SUBMITTED',
    'IN_QUOTATION',
    'IN_FINAL_APPROVAL',
    'APPROVED',
    'ORDERED',
    'REJECTED',
    'CANCELLED'
);

CREATE TABLE "purchase_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    -- BR-042: the requester's Department at creation time, not a live lookup.
    "department_id" UUID NOT NULL,
    "status" "purchase_request_status" NOT NULL DEFAULT 'DRAFT',
    "justification" VARCHAR(2000) NOT NULL,
    -- DATE, not TIMESTAMPTZ: a needed-by day is the same day in every timezone.
    "needed_by" DATE NOT NULL,
    -- BR-031/BR-032: integer centavos, always computed by the backend. BIGINT is a storage
    -- width, deliberately not a business ceiling: there is no maximum request value in the
    -- requirements, so the only limit is the largest amount PostgreSQL stores exactly here.
    -- Amounts cross the API as strings rather than JSON numbers, so a total above
    -- Number.MAX_SAFE_INTEGER survives transport intact (BR-031).
    "estimated_total_cents" BIGINT NOT NULL,
    "submitted_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "purchase_requests_justification_check" CHECK (char_length(btrim("justification")) > 0),
    CONSTRAINT "purchase_requests_estimated_total_cents_check"
        CHECK ("estimated_total_cents" >= 0),
    -- A DRAFT has never been submitted, and only a CANCELLED request carries a cancellation
    -- instant. Both are cheap for PostgreSQL to prove and expensive to reconstruct once an
    -- alternate write path has violated them.
    CONSTRAINT "purchase_requests_draft_not_submitted_check"
        CHECK ("status" <> 'DRAFT' OR "submitted_at" IS NULL),
    CONSTRAINT "purchase_requests_cancellation_check"
        CHECK (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)),
    -- Tenant-aware candidate key, so items can carry and prove tenant equality.
    CONSTRAINT "purchase_requests_organization_id_id_key" UNIQUE ("organization_id", "id")
);

CREATE TABLE "purchase_request_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "purchase_request_id" UUID NOT NULL,
    -- Server-assigned, 1-based, so ordering never depends on physical row order.
    "position" INTEGER NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "unit_of_measure" VARCHAR(20) NOT NULL,
    -- Exact decimal. NUMERIC, never a binary float type: a quantity of 0.1 must stay 0.1.
    -- The scale of 3 is a technical representation constraint — the precision the system
    -- keeps and round-trips — and the precision of 20 is a storage width. Neither is a rule
    -- about how much may be requested. The application refuses a value carrying more than 3
    -- decimal places rather than letting NUMERIC quietly round it to the declared scale.
    "quantity" NUMERIC(20, 3) NOT NULL,
    "estimated_unit_price_cents" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_request_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "purchase_request_items_description_check" CHECK (char_length(btrim("description")) > 0),
    CONSTRAINT "purchase_request_items_unit_of_measure_check" CHECK (char_length(btrim("unit_of_measure")) > 0),
    -- BR-012 at the layer that cannot be bypassed: quantity > 0 and estimated unit price
    -- >= 0, so a zero-priced line stays legal and a zero-quantity line never exists. There
    -- is deliberately no upper bound on either: the requirements state none, and the column
    -- types already bound what can be stored.
    CONSTRAINT "purchase_request_items_quantity_check" CHECK ("quantity" > 0),
    CONSTRAINT "purchase_request_items_estimated_unit_price_cents_check"
        CHECK ("estimated_unit_price_cents" >= 0),
    CONSTRAINT "purchase_request_items_position_check" CHECK ("position" > 0),
    CONSTRAINT "purchase_request_items_organization_id_id_key" UNIQUE ("organization_id", "id"),
    CONSTRAINT "purchase_request_items_organization_id_request_id_position_key"
        UNIQUE ("organization_id", "purchase_request_id", "position")
);

ALTER TABLE "purchase_requests"
    ADD CONSTRAINT "purchase_requests_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "purchase_requests"
    ADD CONSTRAINT "purchase_requests_organization_id_requester_id_fkey"
    FOREIGN KEY ("organization_id", "requester_id") REFERENCES "users"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "purchase_requests"
    ADD CONSTRAINT "purchase_requests_organization_id_department_id_fkey"
    FOREIGN KEY ("organization_id", "department_id") REFERENCES "departments"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "purchase_request_items"
    ADD CONSTRAINT "purchase_request_items_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- CASCADE is deliberate and is the only cascade in the schema: an item has no life outside
-- its request (domain glossary), so deleting a draft must take its lines with it. Every
-- other referential action here stays RESTRICT so business history cannot vanish by
-- accident.
ALTER TABLE "purchase_request_items"
    ADD CONSTRAINT "purchase_request_items_organization_id_purchase_request_id_fkey"
    FOREIGN KEY ("organization_id", "purchase_request_id")
    REFERENCES "purchase_requests"("organization_id", "id")
    ON DELETE CASCADE ON UPDATE RESTRICT;

-- Tenant-leading index for the only product query this phase has: "my requests, newest
-- first". id breaks ties so keyset pagination is stable under equal created_at values.
CREATE INDEX "purchase_requests_organization_id_requester_id_created_at_idx"
    ON "purchase_requests" ("organization_id", "requester_id", "created_at" DESC, "id" DESC);

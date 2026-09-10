-- Suppliers, supplier quotes, purchase orders and durable client idempotency.
-- Forward-only. Organization remains the tenant boundary, so every new table carries
-- organization_id and proves tenant equality with each parent through a composite foreign
-- key (ADR-002).
--
-- Migration review (ADR-002, "Defense in Depth", point 8):
--   tenant FK           : organization_id -> organizations(id), ON DELETE RESTRICT (every table)
--   relationship FKs    : supplier_quotes       (organization_id, purchase_request_id)
--                             -> purchase_requests(organization_id, id)
--                         supplier_quotes       (organization_id, supplier_id)
--                             -> suppliers(organization_id, id)
--                         supplier_quotes       (organization_id, registered_by_id)
--                         supplier_quotes       (organization_id, selected_by_id)
--                             -> users(organization_id, id)
--                         supplier_quote_items  (organization_id, supplier_quote_id, purchase_request_id)
--                             -> supplier_quotes(organization_id, id, purchase_request_id)
--                         supplier_quote_items  (organization_id, purchase_request_id, purchase_request_item_id)
--                             -> purchase_request_items(organization_id, purchase_request_id, id)
--                         purchase_orders       (organization_id, supplier_quote_id,
--                                                purchase_request_id, supplier_id)
--                             -> supplier_quotes(organization_id, id, purchase_request_id, supplier_id)
--                         purchase_orders       (organization_id, purchase_request_id)
--                             -> purchase_requests(organization_id, id)
--                         purchase_orders       (organization_id, supplier_id)
--                             -> suppliers(organization_id, id)
--                         purchase_order_items  (organization_id, purchase_order_id)
--                             -> purchase_orders(organization_id, id)
--                         idempotency_records   (organization_id, actor_id) -> users(organization_id, id)
--   tenant-aware unique : (organization_id, id) on every new tenant-owned table;
--                         (organization_id, tax_identifier_normalized) on suppliers (FR-013);
--                         (organization_id, purchase_request_id, supplier_id) PARTIAL on
--                         supplier_quotes WHERE status = 'ACTIVE' (BR-022);
--                         (organization_id, purchase_request_id) PARTIAL on supplier_quotes
--                         WHERE status = 'SELECTED' (BR-024);
--                         (organization_id, number) and (organization_id, purchase_request_id)
--                         and (organization_id, supplier_quote_id) on purchase_orders;
--                         (organization_id, actor_id, operation, idempotency_key_hash) on
--                         idempotency_records (REL-004)
--   product query index : suppliers (organization_id, created_at DESC, id DESC);
--                         supplier_quotes (organization_id, purchase_request_id, total_cents)
--                         for FR-043's side-by-side comparison ordered by total;
--                         purchase_orders (organization_id, issued_at DESC, id DESC)
--   delete behaviour    : RESTRICT everywhere except supplier_quote_items -> supplier_quotes,
--                         which CASCADEs because a quote line has no life outside its quote.
--                         Purchase order lines are RESTRICT: a snapshot is history.
--   isolation tests     : apps/api/test/integration/supplier-quotation-persistence.integration.spec.ts
--                         apps/api/test/integration/purchase-order-persistence.integration.spec.ts
--                         apps/api/test/integration/idempotency-persistence.integration.spec.ts
--                         apps/api/test/integration/supplier-quotation-http.integration.spec.ts

-- ---------------------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------------------

-- FR-010. Fiscal identity is typed rather than sniffed from the string's shape. CNPJ means
-- the 14 digits were kept and the two check digits were verified in application logic; OTHER
-- means the value is stored faithfully and no national validation is claimed.
CREATE TYPE "supplier_tax_identifier_type" AS ENUM ('CNPJ', 'OTHER');

CREATE TYPE "supplier_quote_status" AS ENUM ('ACTIVE', 'WITHDRAWN', 'SELECTED');

CREATE TYPE "purchase_order_status" AS ENUM ('ISSUED', 'CANCELLED');

-- REL-004's four durable client operations, named exactly as the requirement names them.
CREATE TYPE "idempotent_operation" AS ENUM (
    'PURCHASE_REQUEST_SUBMISSION',
    'APPROVAL_DECISION',
    'QUOTE_SELECTION',
    'PURCHASE_ORDER_ISSUANCE'
);

ALTER TYPE "audit_event_type" ADD VALUE 'SUPPLIER_CREATED';
ALTER TYPE "audit_event_type" ADD VALUE 'SUPPLIER_DEACTIVATED';
ALTER TYPE "audit_event_type" ADD VALUE 'SUPPLIER_QUOTE_REGISTERED';
ALTER TYPE "audit_event_type" ADD VALUE 'SUPPLIER_QUOTE_WITHDRAWN';
ALTER TYPE "audit_event_type" ADD VALUE 'SUPPLIER_QUOTE_SELECTED';
ALTER TYPE "audit_event_type" ADD VALUE 'APPROVAL_FLOW_REEVALUATED';
ALTER TYPE "audit_event_type" ADD VALUE 'PURCHASE_ORDER_ISSUED';
ALTER TYPE "audit_event_type" ADD VALUE 'PURCHASE_ORDER_CANCELLED';

ALTER TYPE "audit_aggregate_type" ADD VALUE 'SUPPLIER';
ALTER TYPE "audit_aggregate_type" ADD VALUE 'PURCHASE_ORDER';

ALTER TYPE "outbox_event_type" ADD VALUE 'PURCHASE_REQUEST_QUOTE_SELECTED';
ALTER TYPE "outbox_event_type" ADD VALUE 'PURCHASE_ORDER_ISSUED';

ALTER TYPE "outbox_aggregate_type" ADD VALUE 'PURCHASE_ORDER';

-- ---------------------------------------------------------------------------------------
-- Candidate key the quotation relationships need
-- ---------------------------------------------------------------------------------------

-- BR-021's strongest guarantee. A supplier_quote_items row carries the purchase_request its
-- quote belongs to and reaches its request line through THIS key, so PostgreSQL refuses a
-- quote line that prices an item of a different request — including a different request of
-- the same tenant.
ALTER TABLE "purchase_request_items"
    ADD CONSTRAINT "purchase_request_items_organization_id_request_id_id_key"
    UNIQUE ("organization_id", "purchase_request_id", "id");

-- ---------------------------------------------------------------------------------------
-- suppliers (FR-010 – FR-013)
-- ---------------------------------------------------------------------------------------

CREATE TABLE "suppliers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "legal_name" VARCHAR(200) NOT NULL,
    "trade_name" VARCHAR(200) NOT NULL,
    "tax_identifier_type" "supplier_tax_identifier_type" NOT NULL,
    -- As supplied, trimmed. Kept so a person recognizes what they typed; never the value
    -- uniqueness is decided on.
    "tax_identifier" VARCHAR(40) NOT NULL,
    -- FR-013/MT-006. The comparison form. Uniqueness is per organization and applies
    -- regardless of type, so two spellings of one identifier cannot both be registered.
    "tax_identifier_normalized" VARCHAR(40) NOT NULL,
    "contact_email" VARCHAR(320) NOT NULL,
    "contact_phone" VARCHAR(40) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deactivated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "suppliers_legal_name_check" CHECK (char_length(btrim("legal_name")) > 0),
    CONSTRAINT "suppliers_trade_name_check" CHECK (char_length(btrim("trade_name")) > 0),
    CONSTRAINT "suppliers_contact_email_check" CHECK (char_length(btrim("contact_email")) > 0),
    CONSTRAINT "suppliers_contact_phone_check" CHECK (char_length(btrim("contact_phone")) > 0),
    CONSTRAINT "suppliers_tax_identifier_check" CHECK (char_length(btrim("tax_identifier")) > 0),
    -- The normalized form is the comparison form, so its shape is a database invariant and
    -- not only an application habit: uppercase alphanumerics, and exactly 14 digits when the
    -- identifier is claimed to be a CNPJ.
    CONSTRAINT "suppliers_tax_identifier_normalized_shape_check"
        CHECK ("tax_identifier_normalized" ~ '^[0-9A-Z]+$'),
    CONSTRAINT "suppliers_cnpj_normalized_check"
        CHECK ("tax_identifier_type" <> 'CNPJ'
               OR "tax_identifier_normalized" ~ '^[0-9]{14}$'),
    -- FR-012. Deactivation state and its instant agree in both directions, so an alternate
    -- write path cannot leave an "inactive" supplier with no record of when.
    CONSTRAINT "suppliers_deactivation_check"
        CHECK ("is_active" = ("deactivated_at" IS NULL)),
    CONSTRAINT "suppliers_organization_id_id_key" UNIQUE ("organization_id", "id"),
    CONSTRAINT "suppliers_organization_id_tax_identifier_normalized_key"
        UNIQUE ("organization_id", "tax_identifier_normalized")
);

ALTER TABLE "suppliers"
    ADD CONSTRAINT "suppliers_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "suppliers_organization_id_created_at_idx"
    ON "suppliers" ("organization_id", "created_at" DESC, "id" DESC);

-- ---------------------------------------------------------------------------------------
-- supplier_quotes (FR-040 – FR-046, BR-020 – BR-025)
-- ---------------------------------------------------------------------------------------

CREATE TABLE "supplier_quotes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "purchase_request_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "status" "supplier_quote_status" NOT NULL DEFAULT 'ACTIVE',
    "freight_cents" BIGINT NOT NULL,
    "discount_cents" BIGINT NOT NULL,
    -- Sum of the already-rounded line totals (BR-033). Stored so the identity below can be
    -- proven by PostgreSQL rather than recomputed by whoever reads the row.
    "items_total_cents" BIGINT NOT NULL,
    "total_cents" BIGINT NOT NULL,
    -- BR-021. How many lines this quote must have. The deferred coverage trigger compares it
    -- with both the quote's own lines and the request's items.
    "item_count" INTEGER NOT NULL,
    -- BR-023. Calendar date, inclusive: a quote is selectable ON its validity date.
    "valid_until" DATE NOT NULL,
    "delivery_lead_time_days" INTEGER NOT NULL,
    "registered_by_id" UUID NOT NULL,
    -- FR-044. Tenant-scoped auditable text. It never reaches a broker payload.
    "selection_rationale" VARCHAR(2000),
    "selected_by_id" UUID,
    "selected_at" TIMESTAMPTZ(3),
    "withdrawn_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "supplier_quotes_pkey" PRIMARY KEY ("id"),
    -- BR-032. No amount here is client input, and none of them may be negative. The total
    -- identity is restated so a row whose total disagrees with its own parts cannot exist,
    -- whatever wrote it.
    CONSTRAINT "supplier_quotes_freight_cents_check" CHECK ("freight_cents" >= 0),
    CONSTRAINT "supplier_quotes_discount_cents_check" CHECK ("discount_cents" >= 0),
    CONSTRAINT "supplier_quotes_items_total_cents_check" CHECK ("items_total_cents" >= 0),
    CONSTRAINT "supplier_quotes_total_cents_check" CHECK ("total_cents" >= 0),
    CONSTRAINT "supplier_quotes_total_identity_check"
        CHECK ("total_cents" = "items_total_cents" + "freight_cents" - "discount_cents"),
    CONSTRAINT "supplier_quotes_item_count_check" CHECK ("item_count" > 0),
    CONSTRAINT "supplier_quotes_delivery_lead_time_days_check"
        CHECK ("delivery_lead_time_days" >= 0),
    -- BR-024/FR-044. A selected quote carries who selected it, when, and why; an unselected
    -- one carries none of the three. Written as two directions so a half-written selection is
    -- rejected in every state.
    CONSTRAINT "supplier_quotes_selection_check"
        CHECK (
            (
                "status" = 'SELECTED'
                AND "selected_by_id" IS NOT NULL
                AND "selected_at" IS NOT NULL
                AND "selection_rationale" IS NOT NULL
                AND char_length(btrim("selection_rationale")) >= 10
            )
            OR (
                "status" IN ('ACTIVE', 'WITHDRAWN')
                AND "selected_by_id" IS NULL
                AND "selected_at" IS NULL
                AND "selection_rationale" IS NULL
            )
        ),
    -- FR-046. Withdrawal state and its instant agree in both directions.
    CONSTRAINT "supplier_quotes_withdrawal_check"
        CHECK (("status" = 'WITHDRAWN') = ("withdrawn_at" IS NOT NULL)),
    CONSTRAINT "supplier_quotes_organization_id_id_key" UNIQUE ("organization_id", "id"),
    -- Lets a quote line prove, in PostgreSQL, that it belongs to the same request as its quote.
    CONSTRAINT "supplier_quotes_organization_id_id_request_id_key"
        UNIQUE ("organization_id", "id", "purchase_request_id"),
    -- Lets a purchase order prove, in PostgreSQL, that the supplier it names is the supplier
    -- of the quote it was derived from (FR-051). Application convention is not sufficient.
    CONSTRAINT "supplier_quotes_organization_id_id_request_id_supplier_id_key"
        UNIQUE ("organization_id", "id", "purchase_request_id", "supplier_id")
);

CREATE TABLE "supplier_quote_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "supplier_quote_id" UUID NOT NULL,
    -- Denormalized from the quote and proven equal to it by the composite foreign key below,
    -- which is what lets the request line be constrained to the same request.
    "purchase_request_id" UUID NOT NULL,
    "purchase_request_item_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    -- Copied from the request line at registration. Never client input: a buyer prices what
    -- was asked for, they do not restate it.
    "quantity" NUMERIC(20, 3) NOT NULL,
    "unit_price_cents" BIGINT NOT NULL,
    -- BR-033: half-up, at the centavo, applied once at the line.
    "line_total_cents" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "supplier_quote_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "supplier_quote_items_quantity_check" CHECK ("quantity" > 0),
    CONSTRAINT "supplier_quote_items_unit_price_cents_check" CHECK ("unit_price_cents" >= 0),
    CONSTRAINT "supplier_quote_items_line_total_cents_check" CHECK ("line_total_cents" >= 0),
    CONSTRAINT "supplier_quote_items_position_check" CHECK ("position" > 0),
    CONSTRAINT "supplier_quote_items_organization_id_id_key" UNIQUE ("organization_id", "id"),
    -- BR-021's "no duplicate": one quote prices each request line at most once.
    CONSTRAINT "supplier_quote_items_organization_id_quote_id_request_item_key"
        UNIQUE ("organization_id", "supplier_quote_id", "purchase_request_item_id"),
    CONSTRAINT "supplier_quote_items_organization_id_quote_id_position_key"
        UNIQUE ("organization_id", "supplier_quote_id", "position")
);

ALTER TABLE "supplier_quotes"
    ADD CONSTRAINT "supplier_quotes_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "supplier_quotes"
    ADD CONSTRAINT "supplier_quotes_organization_id_purchase_request_id_fkey"
    FOREIGN KEY ("organization_id", "purchase_request_id")
    REFERENCES "purchase_requests"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "supplier_quotes"
    ADD CONSTRAINT "supplier_quotes_organization_id_supplier_id_fkey"
    FOREIGN KEY ("organization_id", "supplier_id")
    REFERENCES "suppliers"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "supplier_quotes"
    ADD CONSTRAINT "supplier_quotes_organization_id_registered_by_id_fkey"
    FOREIGN KEY ("organization_id", "registered_by_id")
    REFERENCES "users"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "supplier_quotes"
    ADD CONSTRAINT "supplier_quotes_organization_id_selected_by_id_fkey"
    FOREIGN KEY ("organization_id", "selected_by_id")
    REFERENCES "users"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Three columns: the line's request must be its quote's request, and PostgreSQL enforces it.
-- CASCADE because a quote line has no life outside its quote.
ALTER TABLE "supplier_quote_items"
    ADD CONSTRAINT "supplier_quote_items_organization_id_quote_id_request_id_fkey"
    FOREIGN KEY ("organization_id", "supplier_quote_id", "purchase_request_id")
    REFERENCES "supplier_quotes"("organization_id", "id", "purchase_request_id")
    ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "supplier_quote_items"
    ADD CONSTRAINT "supplier_quote_items_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "supplier_quote_items"
    ADD CONSTRAINT "supplier_quote_items_organization_id_purchase_request_id_fkey"
    FOREIGN KEY ("organization_id", "purchase_request_id")
    REFERENCES "purchase_requests"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- BR-021's "no foreign request item". The line reaches its PurchaseRequestItem through the
-- (organization, request, item) candidate key, so a quote of request A cannot price a line of
-- request B even inside one tenant.
ALTER TABLE "supplier_quote_items"
    ADD CONSTRAINT "supplier_quote_items_organization_id_request_id_item_id_fkey"
    FOREIGN KEY ("organization_id", "purchase_request_id", "purchase_request_item_id")
    REFERENCES "purchase_request_items"("organization_id", "purchase_request_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- BR-022. At most one ACTIVE quote per supplier per request. Registering a replacement
-- requires withdrawing the previous one, and this is what makes that a database invariant
-- rather than a habit of the write path.
CREATE UNIQUE INDEX "supplier_quotes_one_active_per_supplier_key"
    ON "supplier_quotes" ("organization_id", "purchase_request_id", "supplier_id")
    WHERE "status" = 'ACTIVE';

-- BR-024. Exactly one selected quote per request. Two buyers selecting different quotes
-- concurrently therefore produce one winner and one refused transaction, not two winners.
CREATE UNIQUE INDEX "supplier_quotes_one_selected_per_request_key"
    ON "supplier_quotes" ("organization_id", "purchase_request_id")
    WHERE "status" = 'SELECTED';

-- FR-043. Side by side, ordered by total.
CREATE INDEX "supplier_quotes_organization_id_request_id_total_idx"
    ON "supplier_quotes" ("organization_id", "purchase_request_id", "total_cents");

-- BR-021 as a COMMIT-time invariant.
--
-- A partial quote is refused, and so is a quote that prices a line twice or prices a line of
-- another request — but those two are already unrepresentable through the unique constraint
-- and the composite foreign key above. What no row-level constraint can express is the
-- *count*: "this quote has exactly as many lines as its request has items", which is only
-- decidable once every line of the insert has been written. So it is a DEFERRABLE INITIALLY
-- DEFERRED constraint trigger, evaluated at COMMIT, where the answer is final.
CREATE FUNCTION "supplier_quotes_assert_item_coverage"() RETURNS TRIGGER AS $$
DECLARE
    target_quote_id     UUID;
    quote_organization  UUID;
    quote_request_id    UUID;
    declared_item_count INTEGER;
    actual_item_count   INTEGER;
    request_item_count  INTEGER;
BEGIN
    IF TG_TABLE_NAME = 'supplier_quotes' THEN
        target_quote_id     := NEW."id";
        quote_organization  := NEW."organization_id";
        quote_request_id    := NEW."purchase_request_id";
        declared_item_count := NEW."item_count";
    ELSE
        IF TG_OP = 'DELETE' THEN
            target_quote_id    := OLD."supplier_quote_id";
            quote_organization := OLD."organization_id";
        ELSE
            target_quote_id    := NEW."supplier_quote_id";
            quote_organization := NEW."organization_id";
        END IF;

        SELECT q."purchase_request_id", q."item_count"
          INTO quote_request_id, declared_item_count
          FROM "supplier_quotes" q
         WHERE q."organization_id" = quote_organization
           AND q."id" = target_quote_id;

        -- The quote itself was removed in this transaction; its lines went with it through
        -- ON DELETE CASCADE and there is no coverage left to prove.
        IF NOT FOUND THEN
            RETURN NULL;
        END IF;
    END IF;

    SELECT count(*) INTO actual_item_count
      FROM "supplier_quote_items" i
     WHERE i."organization_id" = quote_organization
       AND i."supplier_quote_id" = target_quote_id;

    SELECT count(*) INTO request_item_count
      FROM "purchase_request_items" r
     WHERE r."organization_id" = quote_organization
       AND r."purchase_request_id" = quote_request_id;

    IF declared_item_count <> request_item_count THEN
        RAISE EXCEPTION
            'supplier quote must price every item of its purchase request (declared %, request has %)',
            declared_item_count, request_item_count
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF actual_item_count <> declared_item_count THEN
        RAISE EXCEPTION
            'supplier quote line count % does not match its declared item count %',
            actual_item_count, declared_item_count
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "supplier_quotes_item_coverage_trigger"
    AFTER INSERT OR UPDATE ON "supplier_quotes"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "supplier_quotes_assert_item_coverage"();

CREATE CONSTRAINT TRIGGER "supplier_quote_items_coverage_trigger"
    AFTER INSERT OR UPDATE OR DELETE ON "supplier_quote_items"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "supplier_quotes_assert_item_coverage"();

-- ---------------------------------------------------------------------------------------
-- purchase_orders (FR-050 – FR-054)
-- ---------------------------------------------------------------------------------------

CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "purchase_request_id" UUID NOT NULL,
    "supplier_quote_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    -- FR-053. PO-000001, unique within the organization.
    "number" VARCHAR(20) NOT NULL,
    "sequence_value" BIGINT NOT NULL,
    "status" "purchase_order_status" NOT NULL DEFAULT 'ISSUED',
    -- FR-051's snapshot. Trade name, contact email and contact phone are deliberately absent:
    -- an order records the legal identity it was issued against, not a contact book (SEC-009).
    "supplier_legal_name" VARCHAR(200) NOT NULL,
    "supplier_tax_identifier" VARCHAR(40) NOT NULL,
    "supplier_tax_identifier_type" "supplier_tax_identifier_type" NOT NULL,
    "freight_cents" BIGINT NOT NULL,
    "discount_cents" BIGINT NOT NULL,
    "items_total_cents" BIGINT NOT NULL,
    "total_cents" BIGINT NOT NULL,
    "delivery_lead_time_days" INTEGER NOT NULL,
    "issued_by_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "cancelled_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancellation_reason" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "purchase_orders_number_format_check" CHECK ("number" ~ '^PO-[0-9]{6,}$'),
    CONSTRAINT "purchase_orders_sequence_value_check" CHECK ("sequence_value" >= 1),
    CONSTRAINT "purchase_orders_freight_cents_check" CHECK ("freight_cents" >= 0),
    CONSTRAINT "purchase_orders_discount_cents_check" CHECK ("discount_cents" >= 0),
    CONSTRAINT "purchase_orders_items_total_cents_check" CHECK ("items_total_cents" >= 0),
    CONSTRAINT "purchase_orders_total_cents_check" CHECK ("total_cents" >= 0),
    CONSTRAINT "purchase_orders_total_identity_check"
        CHECK ("total_cents" = "items_total_cents" + "freight_cents" - "discount_cents"),
    CONSTRAINT "purchase_orders_delivery_lead_time_days_check"
        CHECK ("delivery_lead_time_days" >= 0),
    CONSTRAINT "purchase_orders_supplier_legal_name_check"
        CHECK (char_length(btrim("supplier_legal_name")) > 0),
    CONSTRAINT "purchase_orders_supplier_tax_identifier_check"
        CHECK (char_length(btrim("supplier_tax_identifier")) > 0),
    -- FR-054. A cancelled order carries who cancelled it, when and why; an issued one carries
    -- none of the three. Cancellation is terminal, so there is no third state to admit.
    CONSTRAINT "purchase_orders_cancellation_check"
        CHECK (
            (
                "status" = 'CANCELLED'
                AND "cancelled_by_id" IS NOT NULL
                AND "cancelled_at" IS NOT NULL
                AND "cancellation_reason" IS NOT NULL
                AND char_length(btrim("cancellation_reason")) >= 10
            )
            OR (
                "status" = 'ISSUED'
                AND "cancelled_by_id" IS NULL
                AND "cancelled_at" IS NULL
                AND "cancellation_reason" IS NULL
            )
        ),
    CONSTRAINT "purchase_orders_organization_id_id_key" UNIQUE ("organization_id", "id"),
    CONSTRAINT "purchase_orders_organization_id_number_key"
        UNIQUE ("organization_id", "number"),
    -- FR-050. Exactly one purchase order per request, and one per selected quote.
    CONSTRAINT "purchase_orders_organization_id_purchase_request_id_key"
        UNIQUE ("organization_id", "purchase_request_id"),
    CONSTRAINT "purchase_orders_organization_id_supplier_quote_id_key"
        UNIQUE ("organization_id", "supplier_quote_id")
);

CREATE TABLE "purchase_order_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "unit_of_measure" VARCHAR(20) NOT NULL,
    "quantity" NUMERIC(20, 3) NOT NULL,
    "unit_price_cents" BIGINT NOT NULL,
    "line_total_cents" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "purchase_order_items_description_check"
        CHECK (char_length(btrim("description")) > 0),
    CONSTRAINT "purchase_order_items_unit_of_measure_check"
        CHECK (char_length(btrim("unit_of_measure")) > 0),
    CONSTRAINT "purchase_order_items_quantity_check" CHECK ("quantity" > 0),
    CONSTRAINT "purchase_order_items_unit_price_cents_check" CHECK ("unit_price_cents" >= 0),
    CONSTRAINT "purchase_order_items_line_total_cents_check" CHECK ("line_total_cents" >= 0),
    CONSTRAINT "purchase_order_items_position_check" CHECK ("position" > 0),
    CONSTRAINT "purchase_order_items_organization_id_id_key" UNIQUE ("organization_id", "id"),
    CONSTRAINT "purchase_order_items_organization_id_order_id_position_key"
        UNIQUE ("organization_id", "purchase_order_id", "position")
);

ALTER TABLE "purchase_orders"
    ADD CONSTRAINT "purchase_orders_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "purchase_orders"
    ADD CONSTRAINT "purchase_orders_organization_id_purchase_request_id_fkey"
    FOREIGN KEY ("organization_id", "purchase_request_id")
    REFERENCES "purchase_requests"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- FR-051, and the reason this is four columns rather than one. A purchase order's supplier
-- must be the supplier of the quote it was derived from; an application check alone can be
-- raced or bypassed, and this cannot.
ALTER TABLE "purchase_orders"
    ADD CONSTRAINT "purchase_orders_organization_id_quote_request_supplier_fkey"
    FOREIGN KEY ("organization_id", "supplier_quote_id", "purchase_request_id", "supplier_id")
    REFERENCES "supplier_quotes"("organization_id", "id", "purchase_request_id", "supplier_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "purchase_orders"
    ADD CONSTRAINT "purchase_orders_organization_id_supplier_id_fkey"
    FOREIGN KEY ("organization_id", "supplier_id")
    REFERENCES "suppliers"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "purchase_orders"
    ADD CONSTRAINT "purchase_orders_organization_id_issued_by_id_fkey"
    FOREIGN KEY ("organization_id", "issued_by_id") REFERENCES "users"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "purchase_orders"
    ADD CONSTRAINT "purchase_orders_organization_id_cancelled_by_id_fkey"
    FOREIGN KEY ("organization_id", "cancelled_by_id") REFERENCES "users"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "purchase_order_items"
    ADD CONSTRAINT "purchase_order_items_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- RESTRICT, unlike request items and quote items: a purchase order is history, and history
-- does not get taken along by a delete somewhere else.
ALTER TABLE "purchase_order_items"
    ADD CONSTRAINT "purchase_order_items_organization_id_purchase_order_id_fkey"
    FOREIGN KEY ("organization_id", "purchase_order_id")
    REFERENCES "purchase_orders"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "purchase_orders_organization_id_issued_at_idx"
    ON "purchase_orders" ("organization_id", "issued_at" DESC, "id" DESC);

-- FR-053. One counter per tenant: PO-000001 is the first order of every organization, and no
-- tenant can infer another's volume from its numbering.
CREATE TABLE "purchase_order_number_sequences" (
    "organization_id" UUID NOT NULL,
    -- The value the NEXT allocation hands out. Starts at 1 and is never reused.
    "next_value" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_order_number_sequences_pkey" PRIMARY KEY ("organization_id"),
    CONSTRAINT "purchase_order_number_sequences_next_value_check" CHECK ("next_value" >= 1)
);

ALTER TABLE "purchase_order_number_sequences"
    ADD CONSTRAINT "purchase_order_number_sequences_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------------------
-- idempotency_records (REL-004)
-- ---------------------------------------------------------------------------------------

CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    -- Records are actor-bound: two users presenting the same key are two operations, and one
    -- of them must never replay the other's answer.
    "actor_id" UUID NOT NULL,
    "operation" "idempotent_operation" NOT NULL,
    -- The key itself is never stored. Only its SHA-256, so a database read cannot reconstruct
    -- a token a client may reuse elsewhere.
    "idempotency_key_hash" BYTEA NOT NULL,
    -- SHA-256 over the NORMALIZED SEMANTIC request: the route's resource identifiers and the
    -- validated body values that change the outcome. Reusing a key for a different request is
    -- therefore a detectable conflict rather than a wrong replay.
    "request_fingerprint" BYTEA NOT NULL,
    -- A bounded scalar outcome, sufficient to replay the semantic result. Never a request
    -- body, an Authorization header, a cookie, a token, a password, a free-text reason, a
    -- fiscal identifier, a name, an email address or a phone number.
    "outcome" JSONB,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "idempotency_records_key_hash_check"
        CHECK (octet_length("idempotency_key_hash") = 32),
    CONSTRAINT "idempotency_records_request_fingerprint_check"
        CHECK (octet_length("request_fingerprint") = 32),
    CONSTRAINT "idempotency_records_outcome_object_check"
        CHECK ("outcome" IS NULL OR jsonb_typeof("outcome") = 'object'),
    CONSTRAINT "idempotency_records_completion_check"
        CHECK (("outcome" IS NULL) = ("completed_at" IS NULL)),
    -- REL-004's uniqueness boundary, in full: organization, actor, operation and key digest.
    -- A key is therefore never shared across users or tenants.
    CONSTRAINT "idempotency_records_organization_actor_operation_key_hash_key"
        UNIQUE ("organization_id", "actor_id", "operation", "idempotency_key_hash")
);

ALTER TABLE "idempotency_records"
    ADD CONSTRAINT "idempotency_records_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "idempotency_records"
    ADD CONSTRAINT "idempotency_records_organization_id_actor_id_fkey"
    FOREIGN KEY ("organization_id", "actor_id") REFERENCES "users"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "idempotency_records_organization_id_created_at_idx"
    ON "idempotency_records" ("organization_id", "created_at");

-- The reservation is inserted at the start of the business transaction, so a concurrent call
-- presenting the same key blocks on this unique index and loses before doing any work. Its
-- outcome is written at the end of the SAME transaction, which is why a rollback leaves no
-- record at all.
--
-- This trigger is what makes "a committed record is always replayable" an invariant rather
-- than a sequencing assumption: at COMMIT, a reservation that never completed is refused.
CREATE FUNCTION "idempotency_records_assert_completed"() RETURNS TRIGGER AS $$
DECLARE
    settled_at TIMESTAMPTZ(3);
BEGIN
    -- Re-read rather than trust NEW. A deferred constraint trigger fires at COMMIT with the row
    -- as it looked when the statement that queued the event ran, and the reservation is
    -- deliberately written before its outcome — so NEW is always the incomplete version. What
    -- has to hold at COMMIT is a property of the row as it will actually be committed.
    SELECT r."completed_at" INTO settled_at
      FROM "idempotency_records" r
     WHERE r."id" = NEW."id";

    -- The reservation was rolled back or removed within this transaction; there is nothing
    -- left to be incomplete.
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF settled_at IS NULL THEN
        RAISE EXCEPTION
            'idempotency record % was reserved but never completed', NEW."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "idempotency_records_completed_trigger"
    AFTER INSERT OR UPDATE ON "idempotency_records"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "idempotency_records_assert_completed"();

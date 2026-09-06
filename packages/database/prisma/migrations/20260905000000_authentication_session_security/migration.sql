-- Authentication and session security foundation.
-- Forward-only. Adds optional password credentials to persisted identities and the
-- server-side refresh session store. Organization remains the tenant boundary: every
-- session row carries organization_id and proves tenant equality with its User through a
-- composite foreign key.

-- Credentials are optional by construction. A User created before any credential-management
-- flow exists keeps a NULL password_hash and can never authenticate. There is deliberately
-- no DEFAULT, no backfill and no seed credential: a bootstrap password would be a shared
-- secret nobody rotates.
ALTER TABLE "users" ADD COLUMN "password_hash" VARCHAR(255);

-- Rejects plaintext, reversible encodings and non-Argon2id digests at the layer that cannot
-- be argued with. The application never writes anything else; this makes an alternate write
-- path fail loudly instead of silently weakening SEC-002.
ALTER TABLE "users"
    ADD CONSTRAINT "users_password_hash_check"
    CHECK ("password_hash" IS NULL OR "password_hash" LIKE '$argon2id$%');

CREATE TYPE "auth_session_revocation_reason" AS ENUM (
    'ROTATED',
    'LOGOUT',
    'REUSE_DETECTED',
    'PRINCIPAL_INACTIVE'
);

CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    -- SHA-256 digest of the opaque refresh token. The token itself is never persisted, so
    -- a database read cannot reconstruct a usable credential.
    "token_hash" BYTEA NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revocation_reason" "auth_session_revocation_reason",

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "auth_sessions_token_hash_length_check" CHECK (octet_length("token_hash") = 32),
    CONSTRAINT "auth_sessions_lifetime_check" CHECK ("expires_at" > "issued_at"),
    CONSTRAINT "auth_sessions_revocation_check"
        CHECK (("revoked_at" IS NULL) = ("revocation_reason" IS NULL)),
    -- Tenant-aware candidate key, so a future tenant-owned child can prove tenant equality.
    CONSTRAINT "auth_sessions_organization_id_id_key" UNIQUE ("organization_id", "id"),
    -- Global, deliberately not tenant-scoped: the digest is the lookup key used before any
    -- identity is known, and it is what makes the rotation UPDATE touch at most one row.
    CONSTRAINT "auth_sessions_token_hash_key" UNIQUE ("token_hash")
);

ALTER TABLE "auth_sessions"
    ADD CONSTRAINT "auth_sessions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "auth_sessions"
    ADD CONSTRAINT "auth_sessions_organization_id_user_id_fkey"
    FOREIGN KEY ("organization_id", "user_id") REFERENCES "users"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Tenant-leading index for "sessions of this user in this organization".
CREATE INDEX "auth_sessions_organization_id_user_id_issued_at_idx"
    ON "auth_sessions" ("organization_id", "user_id", "issued_at" DESC);

-- Family revocation on detected reuse touches every row of one family.
CREATE INDEX "auth_sessions_family_id_idx" ON "auth_sessions" ("family_id");

-- Partial index for a future session-cleanup worker, which only ever scans sessions that
-- are still active but past their absolute lifetime. Not expressible in schema.prisma.
CREATE INDEX "auth_sessions_active_expires_at_idx"
    ON "auth_sessions" ("expires_at") WHERE "revoked_at" IS NULL;

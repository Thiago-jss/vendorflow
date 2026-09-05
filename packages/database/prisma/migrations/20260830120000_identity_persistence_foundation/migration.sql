-- Identity and organizational persistence foundation.
-- Organization is the tenant boundary; every owned table carries organization_id.

CREATE TYPE "role" AS ENUM ('EMPLOYEE', 'MANAGER', 'BUYER', 'FINANCE', 'ADMIN');

CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organizations_name_check" CHECK (char_length(btrim("name")) > 0)
);

CREATE TABLE "branches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "branches_name_check" CHECK (char_length(btrim("name")) > 0),
    CONSTRAINT "branches_organization_id_id_key" UNIQUE ("organization_id", "id"),
    CONSTRAINT "branches_organization_id_name_key" UNIQUE ("organization_id", "name")
);

CREATE TABLE "departments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "departments_name_check" CHECK (char_length(btrim("name")) > 0),
    CONSTRAINT "departments_organization_id_id_key" UNIQUE ("organization_id", "id"),
    CONSTRAINT "departments_organization_id_branch_id_id_key" UNIQUE ("organization_id", "branch_id", "id"),
    CONSTRAINT "departments_organization_id_branch_id_name_key" UNIQUE ("organization_id", "branch_id", "name")
);

CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "users_name_check" CHECK (char_length(btrim("name")) > 0),
    CONSTRAINT "users_email_normalized_check" CHECK ("email" = lower(btrim("email")) AND char_length("email") > 0),
    CONSTRAINT "users_organization_id_id_key" UNIQUE ("organization_id", "id"),
    CONSTRAINT "users_email_key" UNIQUE ("email")
);

CREATE TABLE "user_roles" (
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "role" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("organization_id", "user_id", "role")
);

ALTER TABLE "branches"
    ADD CONSTRAINT "branches_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "departments"
    ADD CONSTRAINT "departments_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "departments"
    ADD CONSTRAINT "departments_organization_id_branch_id_fkey"
    FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "users"
    ADD CONSTRAINT "users_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "users"
    ADD CONSTRAINT "users_organization_id_branch_id_fkey"
    FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "users"
    ADD CONSTRAINT "users_organization_id_branch_id_department_id_fkey"
    FOREIGN KEY ("organization_id", "branch_id", "department_id")
    REFERENCES "departments"("organization_id", "branch_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "user_roles"
    ADD CONSTRAINT "user_roles_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "user_roles"
    ADD CONSTRAINT "user_roles_organization_id_user_id_fkey"
    FOREIGN KEY ("organization_id", "user_id") REFERENCES "users"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The bootstrap table deliberately survived the historical migration. With real domain
-- tables now present it has no runtime responsibility, so both fresh and upgraded databases
-- remove it by applying this forward migration.
DROP TABLE "platform_metadata";

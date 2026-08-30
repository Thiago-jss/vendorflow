-- Bootstrap persistence only. Domain tables are introduced by their owning modules.
CREATE TABLE "platform_metadata" (
    "key" VARCHAR(100) NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_metadata_pkey" PRIMARY KEY ("key")
);

import { Module } from "@nestjs/common";
import { DatabaseModule } from "@vendorflow/database";
import { TransactionModule } from "../persistence/transaction.module";
import { IDEMPOTENCY_RECORD_REPOSITORY } from "./application/contracts/idempotency-record.repository";
import { ExecuteIdempotently } from "./application/use-cases/execute-idempotently";
import { PrismaIdempotencyRecordRepository } from "./infrastructure/persistence/prisma-idempotency-record.repository";

/**
 * REL-004 lives in `platform` for the same reason the outbox and the transaction boundary do
 * (ADR-001): it is a mechanism every durable operation needs, and a mechanism each module
 * implements for itself is a mechanism each module implements differently.
 *
 * What is exported is one thing — a way to run an operation exactly once for a given key.
 * There is no way to read, list, expire or delete a record from a business module: those are
 * either operator concerns or a retention capability this phase deliberately does not build.
 */
@Module({
  imports: [DatabaseModule, TransactionModule],
  providers: [
    PrismaIdempotencyRecordRepository,
    {
      provide: IDEMPOTENCY_RECORD_REPOSITORY,
      useExisting: PrismaIdempotencyRecordRepository,
    },
    ExecuteIdempotently,
  ],
  exports: [ExecuteIdempotently],
})
export class IdempotencyModule {}

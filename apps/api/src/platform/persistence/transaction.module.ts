import { Module } from "@nestjs/common";
import { DatabaseModule } from "@vendorflow/database";
import { PrismaTransactionRunner } from "./prisma-transaction-runner";
import { TRANSACTION_RUNNER } from "./transaction-scope";

/**
 * ADR-001 rule 4: one database, one transaction boundary. The runner lives in `platform`
 * because the transaction boundary is cross-cutting — a rule every module must remember is a
 * rule one module will forget.
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    PrismaTransactionRunner,
    { provide: TRANSACTION_RUNNER, useExisting: PrismaTransactionRunner },
  ],
  exports: [TRANSACTION_RUNNER],
})
export class TransactionModule {}

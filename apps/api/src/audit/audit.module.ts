import { Module } from "@nestjs/common";
import { DatabaseModule } from "@vendorflow/database";
import { TransactionModule } from "../platform/persistence/transaction.module";
import { AUDIT_EVENT_REPOSITORY } from "./application/contracts/audit-event.repository";
import { RecordAuditEvent } from "./application/use-cases/record-audit-event";
import { PrismaAuditEventRepository } from "./infrastructure/persistence/prisma-audit-event.repository";

/**
 * Owns AuditEvent, as ADR-001 partitions the system.
 *
 * Only the write path exists. FR-061's administrator query surface is a separate capability
 * with its own authorization story, and building it before an administrator surface exists
 * would mean guessing at both. What this module exports is one direction: modules emit audit
 * facts, and nothing — including this module — offers a way to read, alter or delete them
 * (ADR-001 rule 7, AUD-003).
 */
@Module({
  imports: [DatabaseModule, TransactionModule],
  providers: [
    PrismaAuditEventRepository,
    {
      provide: AUDIT_EVENT_REPOSITORY,
      useExisting: PrismaAuditEventRepository,
    },
    RecordAuditEvent,
  ],
  exports: [RecordAuditEvent],
})
export class AuditModule {}

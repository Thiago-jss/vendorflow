import { Module } from "@nestjs/common";
import { DatabaseModule } from "@vendorflow/database";
import { TransactionModule } from "../persistence/transaction.module";
import { OUTBOX_MESSAGE_REPOSITORY } from "./application/contracts/outbox-message.repository";
import { RecordOutgoingEvent } from "./application/use-cases/record-outgoing-event";
import { PrismaOutboxMessageRepository } from "./infrastructure/persistence/prisma-outbox-message.repository";

/**
 * ADR-001 assigns the outbox to `platform`, next to transactions and correlation, because it
 * is the same kind of concern: every module needs it, and a mechanism every module has to
 * remember to implement is a mechanism one module will implement differently.
 *
 * What this module exports is one direction — a module may *record* an outgoing fact. It
 * cannot list, republish, cancel or inspect one. Publication belongs to the worker.
 */
@Module({
  imports: [DatabaseModule, TransactionModule],
  providers: [
    PrismaOutboxMessageRepository,
    {
      provide: OUTBOX_MESSAGE_REPOSITORY,
      useExisting: PrismaOutboxMessageRepository,
    },
    RecordOutgoingEvent,
  ],
  exports: [RecordOutgoingEvent],
})
export class OutboxModule {}

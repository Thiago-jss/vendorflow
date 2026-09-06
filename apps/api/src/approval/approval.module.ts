import { Module } from "@nestjs/common";
import { DatabaseModule } from "@vendorflow/database";
import { TransactionModule } from "../platform/persistence/transaction.module";
import { APPROVAL_FLOW_REPOSITORY } from "./application/contracts/approval-flow.repository";
import { DecideActionableApprovalStep } from "./application/use-cases/decide-actionable-approval-step";
import { GetApprovalFlowForRequest } from "./application/use-cases/get-approval-flow-for-request";
import { ListActionableApprovalSteps } from "./application/use-cases/list-actionable-approval-steps";
import { MaterializeApprovalFlow } from "./application/use-cases/materialize-approval-flow";
import { VoidApprovalFlowForRequest } from "./application/use-cases/void-approval-flow-for-request";
import { PrismaApprovalFlowRepository } from "./infrastructure/persistence/prisma-approval-flow.repository";

/**
 * Owns ApprovalFlow, ApprovalStep and the BR-001 policy, as ADR-001 partitions the system.
 *
 * It has no controller. Every operation here is one half of a purchase request transition —
 * a submitted request materializes its flow, an approved step moves the request to
 * IN_QUOTATION, a cancelled request voids what is left — and a transition that spans two
 * modules is orchestrated by the module that owns the aggregate whose lifecycle it is
 * (`procurement`), inside one transaction (ADR-001 rules 2 and 4). What this module publishes
 * is the set of operations that orchestration may perform on the approval ladder, each
 * tenant-scoped by construction; the ladder's tables are reachable no other way.
 *
 * Purchasing and Finance decisioning is deliberately absent. BR-002 evaluates those steps
 * against the selected quote total, and quotation does not exist yet.
 */
@Module({
  imports: [DatabaseModule, TransactionModule],
  providers: [
    PrismaApprovalFlowRepository,
    {
      provide: APPROVAL_FLOW_REPOSITORY,
      useExisting: PrismaApprovalFlowRepository,
    },
    MaterializeApprovalFlow,
    GetApprovalFlowForRequest,
    ListActionableApprovalSteps,
    DecideActionableApprovalStep,
    VoidApprovalFlowForRequest,
  ],
  exports: [
    MaterializeApprovalFlow,
    GetApprovalFlowForRequest,
    ListActionableApprovalSteps,
    DecideActionableApprovalStep,
    VoidApprovalFlowForRequest,
  ],
})
export class ApprovalModule {}

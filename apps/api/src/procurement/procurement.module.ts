import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DatabaseModule } from "@vendorflow/database";
import type { Environment } from "../config/env";
import { ApprovalModule } from "../approval/approval.module";
import { AuditModule } from "../audit/audit.module";
import { IdentityAccessModule } from "../identity-access/identity-access.module";
import { FixedWindowRateLimiter } from "../platform/rate-limiting/fixed-window-rate-limiter";
import { TransactionModule } from "../platform/persistence/transaction.module";
import { TenantContextModule } from "../platform/tenancy/tenant-context.module";
import {
  APPROVAL_IP_RATE_LIMITER,
  APPROVAL_PRINCIPAL_RATE_LIMITER,
  ApprovalRateLimitGuard,
} from "./infrastructure/http/guards/approval-rate-limit.guard";
import { PURCHASE_REQUEST_REPOSITORY } from "./application/contracts/purchase-request.repository";
import { CancelOwnPurchaseRequest } from "./application/use-cases/cancel-own-purchase-request";
import { CreatePurchaseRequestDraft } from "./application/use-cases/create-purchase-request-draft";
import { DecidePurchaseRequestApproval } from "./application/use-cases/decide-purchase-request-approval";
import { DeleteOwnPurchaseRequestDraft } from "./application/use-cases/delete-own-purchase-request-draft";
import { GetOwnPurchaseRequest } from "./application/use-cases/get-own-purchase-request";
import { ListDepartmentApprovalQueue } from "./application/use-cases/list-department-approval-queue";
import { ListOwnPurchaseRequests } from "./application/use-cases/list-own-purchase-requests";
import { SubmitOwnPurchaseRequest } from "./application/use-cases/submit-own-purchase-request";
import { UpdateOwnPurchaseRequestDraft } from "./application/use-cases/update-own-purchase-request-draft";
import { PrismaPurchaseRequestRepository } from "./infrastructure/persistence/prisma-purchase-request.repository";
import { PurchaseRequestsController } from "./infrastructure/http/controllers/purchase-requests.controller";

/**
 * Owns PurchaseRequest, PurchaseRequestItem and the request state machine, as ADR-001
 * partitions the system.
 *
 * It imports three modules and owns none of their tables:
 *
 * - `IdentityAccessModule` for the Department a person belongs to — the requester's at
 *   creation time (BR-042), and a decision maker's own when their responsibility boundary is
 *   evaluated (AUTHZ-004).
 * - `ApprovalModule` for the approval ladder. `approval` owns ApprovalFlow, ApprovalStep and
 *   the BR-001 policy; this module never touches those tables and reaches them only through
 *   the operations that module publishes (ADR-001 rule 2).
 * - `AuditModule` for the append-only trail. Emitting is the only direction available
 *   (ADR-001 rule 7).
 *
 * The orchestration of a transition that spans all three lives here, with the aggregate whose
 * lifecycle it is: a submission is a request transition *and* its flow *and* its audit event,
 * and ADR-001 rule 4 puts all of them in one transaction. `TransactionModule` provides that
 * boundary; the use cases pass one opaque scope to each module's persistence adapter and
 * never see a database client themselves.
 *
 * Quotation and ordering are still not represented, not even as placeholders. Their states
 * exist in the enum because BR-010 defines them; nothing in this module can reach them.
 */
@Module({
  imports: [
    DatabaseModule,
    TenantContextModule,
    TransactionModule,
    IdentityAccessModule,
    ApprovalModule,
    AuditModule,
  ],
  controllers: [PurchaseRequestsController],
  providers: [
    PrismaPurchaseRequestRepository,
    {
      provide: PURCHASE_REQUEST_REPOSITORY,
      useExisting: PrismaPurchaseRequestRepository,
    },
    CreatePurchaseRequestDraft,
    GetOwnPurchaseRequest,
    ListOwnPurchaseRequests,
    UpdateOwnPurchaseRequestDraft,
    SubmitOwnPurchaseRequest,
    CancelOwnPurchaseRequest,
    DeleteOwnPurchaseRequestDraft,
    ListDepartmentApprovalQueue,
    DecidePurchaseRequestApproval,
    ApprovalRateLimitGuard,
    {
      provide: APPROVAL_IP_RATE_LIMITER,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Environment, true>) =>
        new FixedWindowRateLimiter({
          limit: configService.get("APPROVAL_IP_RATE_LIMIT", { infer: true }),
          windowMilliseconds:
            configService.get("APPROVAL_IP_RATE_LIMIT_WINDOW_SECONDS", {
              infer: true,
            }) * 1000,
        }),
    },
    {
      provide: APPROVAL_PRINCIPAL_RATE_LIMITER,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Environment, true>) =>
        new FixedWindowRateLimiter({
          limit: configService.get("APPROVAL_PRINCIPAL_RATE_LIMIT", {
            infer: true,
          }),
          windowMilliseconds:
            configService.get("APPROVAL_PRINCIPAL_RATE_LIMIT_WINDOW_SECONDS", {
              infer: true,
            }) * 1000,
        }),
    },
  ],
})
export class ProcurementModule {}

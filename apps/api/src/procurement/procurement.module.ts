import { Module } from "@nestjs/common";
import { DatabaseModule } from "@vendorflow/database";
import { IdentityAccessModule } from "../identity-access/identity-access.module";
import { TenantContextModule } from "../platform/tenancy/tenant-context.module";
import { PURCHASE_REQUEST_REPOSITORY } from "./application/contracts/purchase-request.repository";
import { CancelOwnPurchaseRequest } from "./application/use-cases/cancel-own-purchase-request";
import { CreatePurchaseRequestDraft } from "./application/use-cases/create-purchase-request-draft";
import { DeleteOwnPurchaseRequestDraft } from "./application/use-cases/delete-own-purchase-request-draft";
import { GetOwnPurchaseRequest } from "./application/use-cases/get-own-purchase-request";
import { ListOwnPurchaseRequests } from "./application/use-cases/list-own-purchase-requests";
import { SubmitOwnPurchaseRequest } from "./application/use-cases/submit-own-purchase-request";
import { UpdateOwnPurchaseRequestDraft } from "./application/use-cases/update-own-purchase-request-draft";
import { PrismaPurchaseRequestRepository } from "./infrastructure/persistence/prisma-purchase-request.repository";
import { PurchaseRequestsController } from "./infrastructure/http/controllers/purchase-requests.controller";

/**
 * Owns PurchaseRequest, PurchaseRequestItem and the requester-driven part of the request
 * state machine, as ADR-001 partitions the system.
 *
 * It imports `IdentityAccessModule` for one thing: the requester's Department at creation
 * time (BR-042). The User table belongs to identity-access, so that read goes through its
 * published use case rather than through a query from here.
 *
 * Approval, quotation and ordering are not represented, not even as placeholders. Their
 * states exist in the enum because BR-010 defines them; nothing in this module can reach
 * them.
 */
@Module({
  imports: [DatabaseModule, TenantContextModule, IdentityAccessModule],
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
  ],
})
export class ProcurementModule {}

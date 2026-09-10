import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DatabaseModule } from "@vendorflow/database";
import { AuditModule } from "../audit/audit.module";
import type { Environment } from "../config/env";
import { IdempotencyModule } from "../platform/idempotency/idempotency.module";
import { OutboxModule } from "../platform/outbox/outbox.module";
import { TransactionModule } from "../platform/persistence/transaction.module";
import { FixedWindowRateLimiter } from "../platform/rate-limiting/fixed-window-rate-limiter";
import { TenantContextModule } from "../platform/tenancy/tenant-context.module";
import { PURCHASE_ORDER_SUMMARY_READER } from "../procurement/application/contracts/purchase-request-supplements";
import { ProcurementModule } from "../procurement/procurement.module";
import { QuotationModule } from "../quotation/quotation.module";
import { SupplierModule } from "../supplier/supplier.module";
import { PURCHASE_ORDER_REPOSITORY } from "./application/contracts/purchase-order.repository";
import { CancelPurchaseOrder } from "./application/use-cases/cancel-purchase-order";
import { GetPurchaseOrder } from "./application/use-cases/get-purchase-order";
import { IssuePurchaseOrder } from "./application/use-cases/issue-purchase-order";
import { ListPurchaseOrders } from "./application/use-cases/list-purchase-orders";
import { PurchaseOrdersController } from "./infrastructure/http/controllers/purchase-orders.controller";
import {
  PURCHASE_ORDER_IP_RATE_LIMITER,
  PURCHASE_ORDER_PRINCIPAL_RATE_LIMITER,
  PurchaseOrderRateLimitGuard,
} from "./infrastructure/http/guards/purchase-order-rate-limit.guard";
import { PrismaPurchaseOrderSummaryReader } from "./infrastructure/persistence/prisma-purchase-order-summary.reader";
import { PrismaPurchaseOrderRepository } from "./infrastructure/persistence/prisma-purchase-order.repository";

/**
 * Owns PurchaseOrder, PurchaseOrderItem and the tenant-owned purchase order numbering, as
 * ADR-001 partitions the system.
 *
 * It reads the request through `procurement`'s published operations, the winning quote through
 * `quotation`'s and the supplier's legal identity through `supplier`'s, so it writes to no
 * table it does not own (ADR-001 rule 2). Nothing imports this module back.
 *
 * **Why `@Global`.** `procurement` declares an inverted port for FR-026's "does this request
 * have an order", because it may not import this module and a mutual import would need
 * `forwardRef` — a way of hiding a wrong dependency direction rather than fixing one. The
 * provider satisfying that port therefore has to be visible to `procurement`'s injector without
 * `procurement` importing anything from here. The one thing exported is that port, and it is a
 * read.
 */
@Global()
@Module({
  imports: [
    DatabaseModule,
    TenantContextModule,
    TransactionModule,
    IdempotencyModule,
    AuditModule,
    OutboxModule,
    ProcurementModule,
    QuotationModule,
    SupplierModule,
  ],
  controllers: [PurchaseOrdersController],
  providers: [
    PrismaPurchaseOrderRepository,
    {
      provide: PURCHASE_ORDER_REPOSITORY,
      useExisting: PrismaPurchaseOrderRepository,
    },
    PrismaPurchaseOrderSummaryReader,
    {
      provide: PURCHASE_ORDER_SUMMARY_READER,
      useExisting: PrismaPurchaseOrderSummaryReader,
    },
    IssuePurchaseOrder,
    ListPurchaseOrders,
    GetPurchaseOrder,
    CancelPurchaseOrder,
    PurchaseOrderRateLimitGuard,
    {
      provide: PURCHASE_ORDER_IP_RATE_LIMITER,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Environment, true>) =>
        new FixedWindowRateLimiter({
          limit: configService.get("PURCHASE_ORDER_IP_RATE_LIMIT", {
            infer: true,
          }),
          windowMilliseconds:
            configService.get("PURCHASE_ORDER_IP_RATE_LIMIT_WINDOW_SECONDS", {
              infer: true,
            }) * 1000,
        }),
    },
    {
      provide: PURCHASE_ORDER_PRINCIPAL_RATE_LIMITER,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Environment, true>) =>
        new FixedWindowRateLimiter({
          limit: configService.get("PURCHASE_ORDER_PRINCIPAL_RATE_LIMIT", {
            infer: true,
          }),
          windowMilliseconds:
            configService.get(
              "PURCHASE_ORDER_PRINCIPAL_RATE_LIMIT_WINDOW_SECONDS",
              { infer: true },
            ) * 1000,
        }),
    },
  ],
  exports: [PURCHASE_ORDER_SUMMARY_READER],
})
export class PurchaseOrderModule {}

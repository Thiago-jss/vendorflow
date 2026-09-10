import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DatabaseModule } from "@vendorflow/database";
import { ApprovalModule } from "../approval/approval.module";
import { AuditModule } from "../audit/audit.module";
import type { Environment } from "../config/env";
import { IdempotencyModule } from "../platform/idempotency/idempotency.module";
import { OutboxModule } from "../platform/outbox/outbox.module";
import { TransactionModule } from "../platform/persistence/transaction.module";
import { FixedWindowRateLimiter } from "../platform/rate-limiting/fixed-window-rate-limiter";
import { TenantContextModule } from "../platform/tenancy/tenant-context.module";
import { SELECTED_QUOTE_SUMMARY_READER } from "../procurement/application/contracts/purchase-request-supplements";
import { ProcurementModule } from "../procurement/procurement.module";
import { SupplierModule } from "../supplier/supplier.module";
import { SUPPLIER_QUOTE_REPOSITORY } from "./application/contracts/supplier-quote.repository";
import { GetSelectedQuoteForOrdering } from "./application/use-cases/get-selected-quote-for-ordering";
import { ListSupplierQuotes } from "./application/use-cases/list-supplier-quotes";
import { RegisterSupplierQuote } from "./application/use-cases/register-supplier-quote";
import { SelectSupplierQuote } from "./application/use-cases/select-supplier-quote";
import { WithdrawSupplierQuote } from "./application/use-cases/withdraw-supplier-quote";
import { SupplierQuotesController } from "./infrastructure/http/controllers/supplier-quotes.controller";
import {
  QUOTE_SELECTION_IP_RATE_LIMITER,
  QUOTE_SELECTION_PRINCIPAL_RATE_LIMITER,
  QuoteSelectionRateLimitGuard,
} from "./infrastructure/http/guards/quote-selection-rate-limit.guard";
import { PrismaSelectedQuoteSummaryReader } from "./infrastructure/persistence/prisma-selected-quote-summary.reader";
import { PrismaSupplierQuoteRepository } from "./infrastructure/persistence/prisma-supplier-quote.repository";

/**
 * Owns SupplierQuote, SupplierQuoteItem, and quote registration, withdrawal, comparison and
 * selection, as ADR-001 partitions the system.
 *
 * It reads and transitions purchase requests only through `procurement`'s published operations
 * and changes approval ladders only through `approval`'s, so it writes to no table it does not
 * own (ADR-001 rules 2 and 3). The dependency runs one way: this module knows about those two,
 * and neither of them knows this module exists.
 *
 * **Why `@Global`.** `procurement` declares an inverted port for FR-026's "which quote won this
 * request", because it may not import this module and a mutual import would need `forwardRef`
 * — which is a way of hiding a wrong dependency direction rather than fixing one. The
 * provider that satisfies the port therefore has to be visible to `procurement`'s injector
 * without `procurement` importing anything from here, and a global provider is exactly that.
 * The two things exported are a narrow read for `purchase-order` and that one port; neither is
 * a way to write a quote.
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
    ApprovalModule,
    ProcurementModule,
    SupplierModule,
  ],
  controllers: [SupplierQuotesController],
  providers: [
    PrismaSupplierQuoteRepository,
    {
      provide: SUPPLIER_QUOTE_REPOSITORY,
      useExisting: PrismaSupplierQuoteRepository,
    },
    PrismaSelectedQuoteSummaryReader,
    {
      provide: SELECTED_QUOTE_SUMMARY_READER,
      useExisting: PrismaSelectedQuoteSummaryReader,
    },
    RegisterSupplierQuote,
    ListSupplierQuotes,
    WithdrawSupplierQuote,
    SelectSupplierQuote,
    GetSelectedQuoteForOrdering,
    QuoteSelectionRateLimitGuard,
    {
      provide: QUOTE_SELECTION_IP_RATE_LIMITER,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Environment, true>) =>
        new FixedWindowRateLimiter({
          limit: configService.get("QUOTE_SELECTION_IP_RATE_LIMIT", {
            infer: true,
          }),
          windowMilliseconds:
            configService.get("QUOTE_SELECTION_IP_RATE_LIMIT_WINDOW_SECONDS", {
              infer: true,
            }) * 1000,
        }),
    },
    {
      provide: QUOTE_SELECTION_PRINCIPAL_RATE_LIMITER,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Environment, true>) =>
        new FixedWindowRateLimiter({
          limit: configService.get("QUOTE_SELECTION_PRINCIPAL_RATE_LIMIT", {
            infer: true,
          }),
          windowMilliseconds:
            configService.get(
              "QUOTE_SELECTION_PRINCIPAL_RATE_LIMIT_WINDOW_SECONDS",
              { infer: true },
            ) * 1000,
        }),
    },
  ],
  exports: [GetSelectedQuoteForOrdering, SELECTED_QUOTE_SUMMARY_READER],
})
export class QuotationModule {}

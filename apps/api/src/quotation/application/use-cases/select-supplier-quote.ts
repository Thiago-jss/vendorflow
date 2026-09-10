import { Inject, Injectable } from "@nestjs/common";
import { ReevaluateApprovalFlow } from "../../../approval/application/use-cases/reevaluate-approval-flow";
import { RecordAuditEvent } from "../../../audit/application/use-cases/record-audit-event";
import type { IdempotencyOutcome } from "../../../platform/idempotency/application/contracts/idempotent-operation";
import { ExecuteIdempotently } from "../../../platform/idempotency/application/use-cases/execute-idempotently";
import { RecordOutgoingEvent } from "../../../platform/outbox/application/use-cases/record-outgoing-event";
import type { TransactionScope } from "../../../platform/persistence/transaction-scope";
import type { TrustedPrincipal } from "../../../platform/tenancy/trusted-principal";
import { ApplyQuoteSelectionTransition } from "../../../procurement/application/use-cases/apply-quote-selection-transition";
import { ProvePurchaseRequestQuotable } from "../../../procurement/application/use-cases/prove-purchase-request-quotable";
import {
  SupplierQuoteConcurrentlyModifiedError,
  SupplierQuoteExpiredError,
  SupplierQuoteNotActionableError,
  SupplierQuoteNotFoundError,
} from "../contracts/quotation.errors";
import {
  SUPPLIER_QUOTE_REPOSITORY,
  type SupplierQuoteRecord,
  type SupplierQuoteRepository,
} from "../contracts/supplier-quote.repository";
import {
  approvalFlowReevaluatedPayload,
  supplierQuoteSelectedPayload,
} from "../support/quote-audit";
import { assertMayRunQuotation } from "../support/quote-authorization";
import { purchaseRequestQuoteSelectedEventPayload } from "../support/quote-events";
import {
  isQuoteStillValid,
  normalizeSelectionRationale,
} from "../support/quote-selection";

export interface SelectSupplierQuoteInput {
  readonly selectionRationale: string;
  /** REL-004. The raw header value, hashed immediately and never stored or logged. */
  readonly idempotencyKey: string | undefined;
}

export interface SelectedSupplierQuoteResult {
  readonly quote: SupplierQuoteRecord;
  /** FR-045. `IN_FINAL_APPROVAL` or `APPROVED`, decided by BR-003 and never by the client. */
  readonly resultingStatus: "IN_FINAL_APPROVAL" | "APPROVED";
  /** The responsibility now waiting, or `null` when the ladder is finished. */
  readonly actionableStepRole: string | null;
}

/**
 * FR-044, FR-045 and BR-003. The single transaction that turns a set of offers into a decision.
 *
 * Five things happen here and they are one fact, not five (REL-001, AUD-004):
 *
 * 1. the quote becomes `SELECTED`;
 * 2. the approval ladder is re-evaluated against the **selected quote total** (BR-002/BR-003);
 * 3. the request transitions out of IN_QUOTATION, to `APPROVED` when nothing remains to
 *    approve and to `IN_FINAL_APPROVAL` otherwise (FR-045);
 * 4. audit events record both the selection and — only when it actually changed something —
 *    the re-evaluation;
 * 5. an outgoing intent is committed for FR-062's next-actor notification.
 *
 * The lock order is the same as everywhere else in this system: **request first**, then the
 * quote, then the ladder, then the derived rows. Two selections racing therefore contend on the
 * request row before they contend on anything else, and neither can observe a state the other
 * is halfway through changing.
 *
 * Three separate concurrency authorities back that up, none of them a pre-check:
 *
 * - the request's row lock, taken by `ProvePurchaseRequestQuotable`, which also proves the
 *   request is still IN_QUOTATION;
 * - the conditional `UPDATE` on the quote, which restates `status = ACTIVE` **and**
 *   `valid_until >= today`, so BR-023 is enforced by the write and not by the read above it;
 * - the partial unique index that permits one `SELECTED` quote per request, which is what
 *   makes "exactly one winner" true even if both of the above were somehow satisfied twice.
 *
 * REL-004 wraps all of it, so a retried selection replays the first one's answer without a
 * second transition, a second audit event or a second outbox row — and the reservation commits
 * in the same transaction, so a rolled-back selection leaves nothing to replay.
 */
@Injectable()
export class SelectSupplierQuote {
  constructor(
    @Inject(SUPPLIER_QUOTE_REPOSITORY)
    private readonly supplierQuotes: SupplierQuoteRepository,
    private readonly provePurchaseRequestQuotable: ProvePurchaseRequestQuotable,
    private readonly applyQuoteSelectionTransition: ApplyQuoteSelectionTransition,
    private readonly reevaluateApprovalFlow: ReevaluateApprovalFlow,
    private readonly recordAuditEvent: RecordAuditEvent,
    private readonly recordOutgoingEvent: RecordOutgoingEvent,
    private readonly executeIdempotently: ExecuteIdempotently,
  ) {}

  async execute(
    principal: TrustedPrincipal,
    purchaseRequestId: string,
    supplierQuoteId: string,
    input: SelectSupplierQuoteInput,
  ): Promise<SelectedSupplierQuoteResult> {
    assertMayRunQuotation(principal, "select");

    const selectionRationale = normalizeSelectionRationale(
      input.selectionRationale,
    );

    return this.executeIdempotently.execute(
      principal,
      {
        operation: "QUOTE_SELECTION",
        idempotencyKey: input.idempotencyKey,
        // Which request, which quote, and why. The rationale is hashed into the fingerprint
        // and stored nowhere in the idempotency record: it changes the outcome, so it must
        // change the fingerprint.
        fingerprintParts: [
          purchaseRequestId,
          supplierQuoteId,
          selectionRationale,
        ],
      },
      {
        run: (scope) =>
          this.select(principal, scope, {
            purchaseRequestId,
            supplierQuoteId,
            selectionRationale,
          }),
        replay: (outcome) =>
          this.readSelection(
            principal,
            purchaseRequestId,
            supplierQuoteId,
            outcome,
          ),
      },
    );
  }

  private async select(
    principal: TrustedPrincipal,
    scope: TransactionScope,
    input: {
      readonly purchaseRequestId: string;
      readonly supplierQuoteId: string;
      readonly selectionRationale: string;
    },
  ): Promise<{
    readonly value: SelectedSupplierQuoteResult;
    readonly outcome: IdempotencyOutcome;
  }> {
    const selectedAt = new Date();
    const criteria = {
      organizationId: principal.organizationId,
      purchaseRequestId: input.purchaseRequestId,
      supplierQuoteId: input.supplierQuoteId,
    };

    const request = await this.provePurchaseRequestQuotable.execute(scope, {
      organizationId: principal.organizationId,
      purchaseRequestId: input.purchaseRequestId,
    });
    const existing = await this.supplierQuotes.findInTransaction(
      scope,
      criteria,
    );

    if (existing === null) {
      throw new SupplierQuoteNotFoundError();
    }

    // Both of these are pre-checks that produce a useful message. The conditional write below
    // restates both conditions, and that is what actually decides.
    if (existing.status !== "ACTIVE") {
      throw new SupplierQuoteNotActionableError(
        existing.status === "SELECTED"
          ? "This quote is already selected"
          : "A withdrawn quote cannot be selected",
      );
    }

    if (!isQuoteStillValid(existing.validUntil, selectedAt)) {
      throw new SupplierQuoteExpiredError();
    }

    const selected = await this.supplierQuotes.select(scope, {
      ...criteria,
      selectedById: principal.userId,
      selectedAt,
      selectionRationale: input.selectionRationale,
      validOnOrAfter: selectedAt,
    });

    if (selected === null) {
      throw new SupplierQuoteConcurrentlyModifiedError();
    }

    // BR-003, against the selected quote total. `approval` owns the ladder and this module
    // never writes to it — it asks, inside the transaction it already holds (ADR-001 rule 3).
    const reevaluated = await this.reevaluateApprovalFlow.execute(scope, {
      organizationId: principal.organizationId,
      purchaseRequestId: input.purchaseRequestId,
      selectedTotalCents: selected.totalCents,
    });

    if (reevaluated === null) {
      // A request in IN_QUOTATION was submitted, and submission materializes a flow. No flow
      // means something is wrong with the aggregate, not that there is nothing to do.
      throw new SupplierQuoteConcurrentlyModifiedError();
    }

    // FR-045. The target is what the ladder says, not what a client asked for. `procurement`
    // owns the edge and refuses anything that is not one of the two it declares.
    const resultingStatus =
      reevaluated.actionableStep === null ? "APPROVED" : "IN_FINAL_APPROVAL";
    const transitioned = await this.applyQuoteSelectionTransition.execute(
      scope,
      {
        organizationId: principal.organizationId,
        purchaseRequestId: input.purchaseRequestId,
        toStatus: resultingStatus,
      },
    );

    await this.recordAuditEvent.execute(scope, principal, {
      eventType: "SUPPLIER_QUOTE_SELECTED",
      aggregateType: "PURCHASE_REQUEST",
      aggregateId: transitioned.id,
      occurredAt: selectedAt,
      payload: supplierQuoteSelectedPayload({
        supplierQuoteId: selected.id,
        supplierId: selected.supplierId,
        totalCents: selected.totalCents,
        estimatedTotalCents: request.estimatedTotalCents,
        selectionRationale: input.selectionRationale,
        resultingStatus: transitioned.status,
      }),
    });

    // BR-003's own fact, and only when the ladder actually moved. "The rule was consulted" is
    // not an audited action; "two steps were voided and Finance was appended" is.
    if (reevaluated.changed) {
      await this.recordAuditEvent.execute(scope, principal, {
        eventType: "APPROVAL_FLOW_REEVALUATED",
        aggregateType: "PURCHASE_REQUEST",
        aggregateId: transitioned.id,
        occurredAt: selectedAt,
        payload: approvalFlowReevaluatedPayload({
          supplierQuoteId: selected.id,
          selectedTotalCents: selected.totalCents,
          voidedStepCount: reevaluated.voidedStepCount,
          repricedStepCount: reevaluated.repricedStepCount,
          appendedStepRoles: reevaluated.appendedStepRoles,
          approvalFlowState: reevaluated.flow.state,
          actionableStepRole: reevaluated.actionableStep?.role ?? null,
        }),
      });
    }

    await this.recordOutgoingEvent.execute(scope, principal, {
      eventType: "PURCHASE_REQUEST_QUOTE_SELECTED",
      aggregateType: "PURCHASE_REQUEST",
      aggregateId: transitioned.id,
      occurredAt: selectedAt,
      // Deliberately without the selection rationale the audit payload above carries, and
      // without the supplier's name or fiscal identifier: a consumer that needs any of them
      // reads PostgreSQL under a tenant-scoped query.
      payload: purchaseRequestQuoteSelectedEventPayload({
        status: transitioned.status,
        supplierQuoteId: selected.id,
        supplierId: selected.supplierId,
        selectedTotalCents: selected.totalCents,
        requesterId: transitioned.requesterId,
        selectedById: principal.userId,
        approvalFlowId: reevaluated.flow.id,
        approvalFlowState: reevaluated.flow.state,
        actionableStepRole: reevaluated.actionableStep?.role ?? null,
        actionableStepId: reevaluated.actionableStep?.id ?? null,
      }),
    });

    return {
      value: {
        quote: selected,
        resultingStatus,
        actionableStepRole: reevaluated.actionableStep?.role ?? null,
      },
      outcome: {
        purchaseRequestId: transitioned.id,
        supplierQuoteId: selected.id,
        status: transitioned.status,
        actionableStepRole: reevaluated.actionableStep?.role ?? null,
      },
    };
  }

  /**
   * REL-004's replay. The remembered outcome says what happened; a tenant-scoped read of the
   * quote fills in the rest. Nothing is recomputed — re-running BR-003 here would report what
   * the rule says *now*, not what the original selection decided — and nothing is written: no
   * second transition, no second audit event, no second outbox row.
   */
  private async readSelection(
    principal: TrustedPrincipal,
    purchaseRequestId: string,
    supplierQuoteId: string,
    outcome: IdempotencyOutcome,
  ): Promise<SelectedSupplierQuoteResult> {
    const quote = await this.supplierQuotes.find({
      organizationId: principal.organizationId,
      purchaseRequestId,
      supplierQuoteId,
    });

    if (quote === null || quote.status !== "SELECTED") {
      // The record says this selection committed, so the quote must be there. If it is not,
      // something outside this application changed it, and replaying a result that no longer
      // describes reality is worse than refusing.
      throw new SupplierQuoteNotFoundError();
    }

    const status = outcome.status;
    const actionableStepRole = outcome.actionableStepRole;

    return {
      quote,
      resultingStatus: status === "APPROVED" ? "APPROVED" : "IN_FINAL_APPROVAL",
      actionableStepRole:
        typeof actionableStepRole === "string" ? actionableStepRole : null,
    };
  }
}

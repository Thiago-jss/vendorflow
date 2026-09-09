import { randomUUID } from "node:crypto";
import { DatabaseService } from "@vendorflow/database";
import type { TransactionScope } from "../../src/platform/persistence/transaction-scope";
import { PrismaTransactionRunner } from "../../src/platform/persistence/prisma-transaction-runner";
import type {
  AppendAuditEventInput,
  AuditEventRecord,
  AuditEventRepository,
} from "../../src/audit/application/contracts/audit-event.repository";
import { RecordAuditEvent } from "../../src/audit/application/use-cases/record-audit-event";
import { RecordOutgoingEvent } from "../../src/platform/outbox/application/use-cases/record-outgoing-event";
import { PrismaOutboxMessageRepository } from "../../src/platform/outbox/infrastructure/persistence/prisma-outbox-message.repository";
import { PrismaAuditEventRepository } from "../../src/audit/infrastructure/persistence/prisma-audit-event.repository";
import { MaterializeApprovalFlow } from "../../src/approval/application/use-cases/materialize-approval-flow";
import { PrismaApprovalFlowRepository } from "../../src/approval/infrastructure/persistence/prisma-approval-flow.repository";
import { PrismaPurchaseRequestRepository } from "../../src/procurement/infrastructure/persistence/prisma-purchase-request.repository";
import { SubmitOwnPurchaseRequest } from "../../src/procurement/application/use-cases/submit-own-purchase-request";
import type { TrustedPrincipal } from "../../src/platform/tenancy/trusted-principal";
import { createTenant, type TenantFixture } from "./identity-fixtures";
import { PostgreSqlIntegrationTestHarness } from "./postgresql-test-harness";

/** R$ 5,000.01: the tier that materializes all three steps (BR-001). */
const THREE_STEP_TOTAL_CENTS = 500_001n;

describe("approval workflow persistence (PostgreSQL)", () => {
  let harness: PostgreSqlIntegrationTestHarness;
  let database: DatabaseService;
  let transactions: PrismaTransactionRunner;
  let purchaseRequests: PrismaPurchaseRequestRepository;
  let approvalFlows: PrismaApprovalFlowRepository;
  let auditEvents: PrismaAuditEventRepository;
  let organizationA: TenantFixture;
  let organizationB: TenantFixture;

  beforeAll(async () => {
    harness = await PostgreSqlIntegrationTestHarness.start();
    database = harness.database;
    transactions = new PrismaTransactionRunner(database);
    purchaseRequests = new PrismaPurchaseRequestRepository(database);
    approvalFlows = new PrismaApprovalFlowRepository(database);
    auditEvents = new PrismaAuditEventRepository();
  }, 180_000);

  beforeEach(async () => {
    await harness.clean();
    organizationA = await createTenant(database, { suffix: "A" });
    organizationB = await createTenant(database, { suffix: "B" });
  }, 60_000);

  afterAll(async () => {
    if (harness !== undefined) {
      await harness.stop();
    }
  });

  function principalOf(tenant: TenantFixture): TrustedPrincipal {
    return {
      userId: tenant.userId,
      organizationId: tenant.organizationId,
      roles: ["EMPLOYEE"],
    };
  }

  async function createDraft(
    tenant: TenantFixture,
    estimatedTotalCents = THREE_STEP_TOTAL_CENTS,
  ): Promise<string> {
    const draft = await purchaseRequests.createDraft({
      organizationId: tenant.organizationId,
      requesterId: tenant.userId,
      departmentId: tenant.departmentId,
      justification: "Replacement laptops for the onboarding cohort",
      neededBy: new Date("2026-11-30T00:00:00.000Z"),
      estimatedTotalCents,
      items: [
        {
          description: "Laptop, 16 GB RAM",
          unitOfMeasure: "UN",
          quantityScaled: 1_000n,
          estimatedUnitPriceCents: estimatedTotalCents,
        },
      ],
    });

    return draft.id;
  }

  /** The real submission path: transition, flow and audit event in one transaction. */
  function submitter(auditRepository: AuditEventRepository) {
    return new SubmitOwnPurchaseRequest(
      purchaseRequests,
      transactions,
      new MaterializeApprovalFlow(approvalFlows),
      new RecordAuditEvent(auditRepository),
      new RecordOutgoingEvent(new PrismaOutboxMessageRepository()),
    );
  }

  async function submit(
    tenant: TenantFixture,
    estimatedTotalCents = THREE_STEP_TOTAL_CENTS,
  ): Promise<string> {
    const draftId = await createDraft(tenant, estimatedTotalCents);
    const view = await submitter(auditEvents).execute(
      principalOf(tenant),
      draftId,
    );

    return view.request.id;
  }

  describe("materialization", () => {
    it("writes a gap-free ladder with exactly one actionable step", async () => {
      const purchaseRequestId = await submit(organizationA);
      const steps = await database.approvalStep.findMany({
        where: { purchaseRequestId },
        orderBy: { sequence: "asc" },
      });

      expect(steps.map((step) => step.sequence)).toEqual([1, 2, 3]);
      expect(steps.map((step) => step.role)).toEqual([
        "MANAGER",
        "PURCHASING",
        "FINANCE",
      ]);
      expect(steps.map((step) => step.state)).toEqual([
        "ACTIONABLE",
        "PENDING",
        "PENDING",
      ]);
      // BIGINT in PostgreSQL, bigint in the domain: the evaluated amount is never a float.
      expect(steps.every((step) => step.evaluatedAmountCents === THREE_STEP_TOTAL_CENTS)).toBe(true);
      expect(new Set(steps.map((step) => step.approvalFlowId)).size).toBe(1);
    });

    it("keeps the flow, its steps and the audit event in one transaction (AUD-004)", async () => {
      const purchaseRequestId = await submit(organizationA);

      await expect(
        database.approvalFlow.count({ where: { purchaseRequestId } }),
      ).resolves.toBe(1);
      await expect(
        database.auditEvent.count({ where: { aggregateId: purchaseRequestId } }),
      ).resolves.toBe(1);
    });

    it("rolls the whole submission back when the audit write fails", async () => {
      const draftId = await createDraft(organizationA);
      const failing: AuditEventRepository = {
        append(): Promise<AuditEventRecord> {
          // Stands in for anything that can fail after the business rows are written: a
          // constraint, a lost connection, a bug. The point is what survives, not the cause.
          return Promise.reject(new Error("audit storage is unavailable"));
        },
      };

      await expect(
        submitter(failing).execute(principalOf(organizationA), draftId),
      ).rejects.toThrow("audit storage is unavailable");

      // Neither half committed: no transition, no flow, no steps, no event.
      const request = await database.purchaseRequest.findUniqueOrThrow({
        where: { id: draftId },
        select: { status: true, submittedAt: true },
      });
      expect(request.status).toBe("DRAFT");
      expect(request.submittedAt).toBeNull();
      await expect(database.approvalFlow.count()).resolves.toBe(0);
      await expect(database.approvalStep.count()).resolves.toBe(0);
      await expect(database.auditEvent.count()).resolves.toBe(0);
    });
  });

  describe("REL-005 concurrent decisions on one step", () => {
    it("lets exactly one of two simultaneous decisions win", async () => {
      const purchaseRequestId = await submit(organizationA);
      const decision = {
        organizationId: organizationA.organizationId,
        purchaseRequestId,
        role: "MANAGER" as const,
        decidedById: organizationA.userId,
      };

      const [first, second] = await Promise.all([
        transactions.run((scope) =>
          approvalFlows.decideActionableStep(scope, {
            ...decision,
            decision: "APPROVED",
            decisionReason: null,
            decidedAt: new Date(),
          }),
        ),
        transactions.run((scope) =>
          approvalFlows.decideActionableStep(scope, {
            ...decision,
            decision: "REJECTED",
            decisionReason: "Simultaneous and contradictory",
            decidedAt: new Date(),
          }),
        ),
      ]);

      expect([first, second].filter((result) => result !== null)).toHaveLength(
        1,
      );
      const steps = await database.approvalStep.findMany({
        where: { purchaseRequestId, sequence: 1 },
      });
      expect(steps).toHaveLength(1);
      expect(["APPROVED", "REJECTED"]).toContain(steps[0]?.state);
    });
  });

  describe("PostgreSQL refuses a cross-tenant relationship regardless of the caller", () => {
    it("rejects a flow attached to another organization's request", async () => {
      const foreign = await createDraft(organizationB);

      await expect(
        database.approvalFlow.create({
          data: {
            organizationId: organizationA.organizationId,
            purchaseRequestId: foreign,
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
    });

    it("rejects a step attached to another organization's flow, even from raw SQL", async () => {
      const purchaseRequestId = await submit(organizationB);
      const flow = await database.approvalFlow.findFirstOrThrow({
        where: { purchaseRequestId },
        select: { id: true },
      });

      // ADR-002 verification item 9. Parameterized throughout; nothing is interpolated.
      await expect(
        database.$executeRaw`
          INSERT INTO "approval_steps"
            ("id", "organization_id", "approval_flow_id", "purchase_request_id", "sequence",
             "role", "state", "evaluated_amount_cents", "updated_at")
          VALUES (${randomUUID()}::uuid, ${organizationA.organizationId}::uuid,
                  ${flow.id}::uuid, ${purchaseRequestId}::uuid, 9, 'MANAGER', 'PENDING', 0, now())
        `,
      ).rejects.toThrow(/foreign key constraint/i);
    });

    it("rejects a step that names a different request than its own flow", async () => {
      const purchaseRequestId = await submit(organizationA);
      const otherRequestId = await createDraft(organizationA);
      const flow = await database.approvalFlow.findFirstOrThrow({
        where: { purchaseRequestId },
        select: { id: true },
      });

      // The composite foreign key carries all three columns, so the flow's request and the
      // step's request cannot disagree.
      await expect(
        database.$executeRaw`
          INSERT INTO "approval_steps"
            ("id", "organization_id", "approval_flow_id", "purchase_request_id", "sequence",
             "role", "state", "evaluated_amount_cents", "updated_at")
          VALUES (${randomUUID()}::uuid, ${organizationA.organizationId}::uuid,
                  ${flow.id}::uuid, ${otherRequestId}::uuid, 9, 'MANAGER', 'PENDING', 0, now())
        `,
      ).rejects.toThrow(/foreign key constraint/i);
    });

    it("rejects a decision attributed to a user of another organization", async () => {
      const purchaseRequestId = await submit(organizationA);
      const step = await database.approvalStep.findFirstOrThrow({
        where: { purchaseRequestId, sequence: 1 },
        select: { id: true },
      });

      await expect(
        database.approvalStep.update({
          where: { id: step.id },
          data: {
            state: "APPROVED",
            decidedById: organizationB.userId,
            decidedAt: new Date(),
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
    });

    it("rejects an audit event whose actor belongs to another organization", async () => {
      await expect(
        database.auditEvent.create({
          data: {
            organizationId: organizationA.organizationId,
            actorId: organizationB.userId,
            eventType: "PURCHASE_REQUEST_SUBMITTED",
            aggregateType: "PURCHASE_REQUEST",
            aggregateId: randomUUID(),
            sequence: 1,
            occurredAt: new Date(),
            payload: {},
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
    });
  });

  describe("PostgreSQL enforces the approval invariants", () => {
    it("refuses a second actionable step in the same flow", async () => {
      const purchaseRequestId = await submit(organizationA);
      const pending = await database.approvalStep.findFirstOrThrow({
        where: { purchaseRequestId, sequence: 2 },
        select: { id: true },
      });

      // FR-035: a flow waits on one step. The partial unique index is what makes that true
      // even for a write path that never asked the application.
      await expect(
        database.approvalStep.update({
          where: { id: pending.id },
          data: { state: "ACTIONABLE" },
        }),
        // Prisma reports the index by its columns; the partial predicate on it is what makes
        // "one actionable step per flow" enforceable at all.
      ).rejects.toThrow(
        /Unique constraint failed on the fields: \(`organization_id`,`approval_flow_id`\)/,
      );
    });

    it("refuses two steps sharing a sequence in one flow", async () => {
      const purchaseRequestId = await submit(organizationA);
      const step = await database.approvalStep.findFirstOrThrow({
        where: { purchaseRequestId, sequence: 2 },
        select: { id: true },
      });

      await expect(
        database.approvalStep.update({
          where: { id: step.id },
          data: { sequence: 1 },
        }),
      ).rejects.toThrow(
        /Unique constraint failed on the fields: \(`organization_id`,`approval_flow_id`,`sequence`\)/,
      );
    });

    it("refuses more than one flow per request", async () => {
      const purchaseRequestId = await submit(organizationA);

      await expect(
        database.approvalFlow.create({
          data: {
            organizationId: organizationA.organizationId,
            purchaseRequestId,
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("refuses a rejection without a reason of at least ten characters", async () => {
      const purchaseRequestId = await submit(organizationA);
      const step = await database.approvalStep.findFirstOrThrow({
        where: { purchaseRequestId, sequence: 1 },
        select: { id: true },
      });

      for (const decisionReason of [null, "  ", "too short"]) {
        await expect(
          database.approvalStep.update({
            where: { id: step.id },
            data: {
              state: "REJECTED",
              decidedById: organizationA.userId,
              decidedAt: new Date(),
              decisionReason,
            },
          }),
          // Two constraints share this ground on purpose: blank text is refused as a reason at
          // all, and a rejection is refused for having none of at least ten characters.
        ).rejects.toThrow(
          /approval_steps_(rejection|decision)_reason_check/,
        );
      }
    });

    it("refuses a decided step with no decider, and an undecided step with a reason", async () => {
      const purchaseRequestId = await submit(organizationA);
      const step = await database.approvalStep.findFirstOrThrow({
        where: { purchaseRequestId, sequence: 1 },
        select: { id: true },
      });

      await expect(
        database.approvalStep.update({
          where: { id: step.id },
          data: { state: "APPROVED" },
        }),
      ).rejects.toThrow(/approval_steps_decision_identity_check/);

      await expect(
        database.approvalStep.update({
          where: { id: step.id },
          data: { decisionReason: "Reasoning about nothing" },
        }),
      ).rejects.toThrow(/approval_steps_undecided_reason_check/);
    });

    it("refuses a half-written decision on an otherwise-undecided step", async () => {
      const purchaseRequestId = await submit(organizationA);
      const actionableStep = await database.approvalStep.findFirstOrThrow({
        where: { purchaseRequestId, sequence: 1 },
        select: { id: true },
      });
      const pendingStep = await database.approvalStep.findFirstOrThrow({
        where: { purchaseRequestId, sequence: 2 },
        select: { id: true },
      });

      // BR-006: an ACTIONABLE or a PENDING step carries neither decision fact. Setting only
      // one of the two — the exact half-write an alternate write path or a buggy migration
      // could otherwise leave behind — must be refused on both, whatever state each is in.
      for (const step of [actionableStep, pendingStep]) {
        await expect(
          database.approvalStep.update({
            where: { id: step.id },
            data: { decidedById: organizationA.userId },
          }),
        ).rejects.toThrow(/approval_steps_decision_identity_check/);

        await expect(
          database.approvalStep.update({
            where: { id: step.id },
            data: { decidedAt: new Date() },
          }),
        ).rejects.toThrow(/approval_steps_decision_identity_check/);
      }

      // Untouched: every rejected write rolled back rather than leaving a partial row.
      const steps = await database.approvalStep.findMany({
        where: { purchaseRequestId },
        orderBy: { sequence: "asc" },
      });
      for (const step of steps) {
        expect(
          step.decidedById === null && step.decidedAt === null,
        ).toBe(true);
      }
    });

    it("refuses a VOIDED step carrying a decision, and accepts one that carries none", async () => {
      const purchaseRequestId = await submit(organizationA);
      const step = await database.approvalStep.findFirstOrThrow({
        where: { purchaseRequestId, sequence: 3 },
        select: { id: true },
      });

      await expect(
        database.approvalStep.update({
          where: { id: step.id },
          data: {
            state: "VOIDED",
            decidedById: organizationA.userId,
            decidedAt: new Date(),
          },
        }),
      ).rejects.toThrow(/approval_steps_decision_identity_check/);

      await expect(
        database.approvalStep.update({
          where: { id: step.id },
          data: { state: "VOIDED" },
        }),
      ).resolves.toMatchObject({ state: "VOIDED", decidedById: null });
    });

    it("refuses a negative evaluated amount and a non-positive sequence", async () => {
      const purchaseRequestId = await submit(organizationA);
      const step = await database.approvalStep.findFirstOrThrow({
        where: { purchaseRequestId, sequence: 3 },
        select: { id: true },
      });

      await expect(
        database.approvalStep.update({
          where: { id: step.id },
          data: { evaluatedAmountCents: -1n },
        }),
      ).rejects.toThrow(/approval_steps_evaluated_amount_cents_check/);

      await expect(
        database.approvalStep.update({
          where: { id: step.id },
          data: { sequence: 0 },
        }),
      ).rejects.toThrow(/approval_steps_sequence_check/);
    });
  });

  describe("AUD-003 the audit trail is append-only", () => {
    it("refuses an update and a delete, whatever issued it", async () => {
      const purchaseRequestId = await submit(organizationA);
      const event = await database.auditEvent.findFirstOrThrow({
        where: { aggregateId: purchaseRequestId },
        select: { id: true },
      });

      await expect(
        database.auditEvent.update({
          where: { id: event.id },
          data: { payload: { tampered: true } },
        }),
      ).rejects.toThrow(/append-only/);

      await expect(
        database.auditEvent.delete({ where: { id: event.id } }),
      ).rejects.toThrow(/append-only/);

      await expect(
        database.auditEvent.count({ where: { aggregateId: purchaseRequestId } }),
      ).resolves.toBe(1);
    });

    it("numbers events per aggregate and refuses a duplicate position (AUD-005)", async () => {
      const purchaseRequestId = await submit(organizationA);
      const otherRequestId = await submit(organizationA, 100_000n);

      // Each aggregate has its own sequence, both starting at 1.
      const events = await database.auditEvent.findMany({
        where: { organizationId: organizationA.organizationId },
        select: { aggregateId: true, sequence: true },
      });
      expect(
        events.filter((event) => event.aggregateId === purchaseRequestId),
      ).toEqual([{ aggregateId: purchaseRequestId, sequence: 1 }]);
      expect(
        events.filter((event) => event.aggregateId === otherRequestId),
      ).toEqual([{ aggregateId: otherRequestId, sequence: 1 }]);

      await expect(
        database.auditEvent.create({
          data: {
            organizationId: organizationA.organizationId,
            actorId: organizationA.userId,
            eventType: "PURCHASE_REQUEST_CANCELLED",
            aggregateType: "PURCHASE_REQUEST",
            aggregateId: purchaseRequestId,
            sequence: 1,
            occurredAt: new Date(),
            payload: {},
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("appends inside the caller's transaction and nowhere else", async () => {
      const purchaseRequestId = await submit(organizationA);
      const appended: AppendAuditEventInput = {
        organizationId: organizationA.organizationId,
        actorId: organizationA.userId,
        eventType: "PURCHASE_REQUEST_CANCELLED",
        aggregateType: "PURCHASE_REQUEST",
        aggregateId: purchaseRequestId,
        occurredAt: new Date(),
        payload: { status: "CANCELLED" },
      };

      await expect(
        transactions.run(async (scope: TransactionScope) => {
          await auditEvents.append(scope, appended);
          throw new Error("the business change failed");
        }),
      ).rejects.toThrow("the business change failed");

      // The event went with the transaction that failed: an audit event without its business
      // change is exactly as wrong as the reverse (AUD-004).
      await expect(
        database.auditEvent.count({ where: { aggregateId: purchaseRequestId } }),
      ).resolves.toBe(1);

      const second = await transactions.run((scope) =>
        auditEvents.append(scope, appended),
      );
      expect(second.sequence).toBe(2);
    });
  });
});

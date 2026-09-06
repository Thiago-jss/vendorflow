import { randomUUID } from "node:crypto";
import { DatabaseService } from "@vendorflow/database";
import {
  ApiIntegrationTestHarness,
  type HttpTestResponse,
} from "./api-test-harness";
import {
  createDepartment,
  createTenant,
  createUser,
  type TenantFixture,
  type UserFixture,
} from "./identity-fixtures";
import { PostgreSqlIntegrationTestHarness } from "./postgresql-test-harness";

/**
 * BR-001 boundaries expressed as something a requester can actually send. One item priced at
 * the target amount, quantity 1, so the estimated total *is* the tier boundary and the ladder
 * the submission materializes is the only thing under test.
 */
const TIER_ONE_CENTS = "100000";
const TIER_TWO_CENTS = "100001";
const TIER_THREE_CENTS = "500001";

interface DraftBody {
  readonly justification: string;
  readonly neededBy: string;
  readonly items: readonly {
    readonly description: string;
    readonly unitOfMeasure: string;
    readonly quantity: string;
    readonly estimatedUnitPriceCents: string;
  }[];
}

function draftBody(estimatedUnitPriceCents = TIER_ONE_CENTS): DraftBody {
  return {
    justification: "Replacement laptops for the onboarding cohort",
    neededBy: "2026-11-30",
    items: [
      {
        description: "Laptop, 16 GB RAM",
        unitOfMeasure: "UN",
        quantity: "1",
        estimatedUnitPriceCents,
      },
    ],
  };
}

interface ApprovalStepBody {
  readonly id: string;
  readonly sequence: number;
  readonly role: string;
  readonly state: string;
  readonly evaluatedAmountCents: string;
  readonly decidedById: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
}

interface ApprovalBody {
  readonly id: string;
  readonly state: string;
  readonly pendingStep: ApprovalStepBody | null;
  readonly steps: readonly ApprovalStepBody[];
}

interface RequestBody {
  readonly id: string;
  readonly status: string;
  readonly approval: ApprovalBody | null;
}

describe("approval workflow HTTP surface (PostgreSQL)", () => {
  let postgres: PostgreSqlIntegrationTestHarness;
  let api: ApiIntegrationTestHarness;
  let database: DatabaseService;

  /** Organization A, "Operations" department. Raises requests; holds no MANAGER. */
  let requester: TenantFixture;
  /** Organization A, "Operations". The manager responsible for the requester's department. */
  let manager: UserFixture;
  /** Organization A, "Facilities". Same tenant, wrong boundary (AUTHZ-004). */
  let otherDepartmentManager: UserFixture;
  /** Organization A, "Operations", MANAGER *and* the requester of their own request. */
  let requestingManager: UserFixture;
  let buyer: UserFixture;
  let finance: UserFixture;
  let administrator: UserFixture;
  let plainEmployee: UserFixture;
  /** Organization B. A perfectly good manager, of the wrong tenant. */
  let foreignManager: TenantFixture;

  let requesterToken: string;
  let managerToken: string;
  let otherDepartmentManagerToken: string;
  let requestingManagerToken: string;
  let buyerToken: string;
  let financeToken: string;
  let administratorToken: string;
  let plainEmployeeToken: string;
  let foreignManagerToken: string;

  beforeAll(async () => {
    postgres = await PostgreSqlIntegrationTestHarness.start();
    database = postgres.database;
    api = await ApiIntegrationTestHarness.start();
  }, 180_000);

  beforeEach(async () => {
    await postgres.clean();

    requester = await createTenant(database, {
      suffix: "A",
      roles: ["EMPLOYEE"],
    });
    const facilitiesId = await createDepartment(
      database,
      requester,
      "Facilities",
    );
    const inOperations = {
      organizationId: requester.organizationId,
      branchId: requester.branchId,
      departmentId: requester.departmentId,
    };

    manager = await createUser(database, {
      ...inOperations,
      suffix: "ManagerOps",
      roles: ["MANAGER"],
    });
    otherDepartmentManager = await createUser(database, {
      ...inOperations,
      departmentId: facilitiesId,
      suffix: "ManagerFacilities",
      roles: ["MANAGER"],
    });
    requestingManager = await createUser(database, {
      ...inOperations,
      suffix: "RequestingManager",
      roles: ["EMPLOYEE", "MANAGER"],
    });
    buyer = await createUser(database, {
      ...inOperations,
      suffix: "Buyer",
      roles: ["BUYER"],
    });
    finance = await createUser(database, {
      ...inOperations,
      suffix: "Finance",
      roles: ["FINANCE"],
    });
    administrator = await createUser(database, {
      ...inOperations,
      suffix: "Admin",
      roles: ["ADMIN"],
    });
    plainEmployee = await createUser(database, {
      ...inOperations,
      suffix: "Employee",
      roles: ["EMPLOYEE"],
    });
    foreignManager = await createTenant(database, {
      suffix: "B",
      roles: ["EMPLOYEE", "MANAGER"],
    });

    requesterToken = await login(requester);
    managerToken = await login(manager);
    otherDepartmentManagerToken = await login(otherDepartmentManager);
    requestingManagerToken = await login(requestingManager);
    buyerToken = await login(buyer);
    financeToken = await login(finance);
    administratorToken = await login(administrator);
    plainEmployeeToken = await login(plainEmployee);
    foreignManagerToken = await login(foreignManager);
  }, 120_000);

  afterAll(async () => {
    if (api !== undefined) {
      await api.stop();
    }

    if (postgres !== undefined) {
      await postgres.stop();
    }
  });

  async function login(account: {
    readonly email: string;
    readonly password: string;
  }): Promise<string> {
    const response = await api.post("/auth/login", {
      body: { email: account.email, password: account.password },
    });

    return (response.body as { readonly accessToken: string }).accessToken;
  }

  async function submit(
    accessToken: string,
    unitPriceCents = TIER_ONE_CENTS,
  ): Promise<RequestBody> {
    const created = await api.post("/purchase-requests", {
      accessToken,
      body: draftBody(unitPriceCents),
    });
    expect(created.status).toBe(201);

    const { id } = created.body as { readonly id: string };
    const submitted = await api.post(`/purchase-requests/${id}/submit`, {
      accessToken,
    });
    expect(submitted.status).toBe(200);

    return submitted.body as RequestBody;
  }

  function decide(
    accessToken: string,
    purchaseRequestId: string,
    body: unknown,
  ): Promise<HttpTestResponse> {
    return api.post(
      `/purchase-requests/${purchaseRequestId}/approval-decision`,
      { accessToken, body },
    );
  }

  function auditEvents(aggregateId: string) {
    return database.auditEvent.findMany({
      where: { aggregateId },
      orderBy: { sequence: "asc" },
    });
  }

  describe("authentication", () => {
    it("refuses both new routes without an access token (default deny)", async () => {
      const id = randomUUID();

      for (const response of await Promise.all([
        api.get("/purchase-requests/awaiting-my-approval"),
        api.post(`/purchase-requests/${id}/approval-decision`, {
          body: { decision: "APPROVED" },
        }),
      ])) {
        expect(response.status).toBe(401);
      }
    });
  });

  describe("FR-024 materialization at submission", () => {
    it("creates the BR-001 ladder for the first tier: one actionable Manager step", async () => {
      const submitted = await submit(requesterToken, TIER_ONE_CENTS);

      expect(submitted.status).toBe("SUBMITTED");
      expect(submitted.approval?.state).toBe("ACTIVE");
      expect(submitted.approval?.steps).toEqual([
        expect.objectContaining({
          sequence: 1,
          role: "MANAGER",
          state: "ACTIONABLE",
          evaluatedAmountCents: TIER_ONE_CENTS,
          decidedById: null,
          decidedAt: null,
          decisionReason: null,
        }),
      ]);
      expect(submitted.approval?.pendingStep?.sequence).toBe(1);
    });

    it("creates Manager then Purchasing above R$ 1,000.00, only the first actionable", async () => {
      const submitted = await submit(requesterToken, TIER_TWO_CENTS);

      expect(
        submitted.approval?.steps.map((step) => [step.sequence, step.role, step.state]),
      ).toEqual([
        [1, "MANAGER", "ACTIONABLE"],
        [2, "PURCHASING", "PENDING"],
      ]);
    });

    it("creates Manager, Purchasing and Finance above R$ 5,000.00", async () => {
      const submitted = await submit(requesterToken, TIER_THREE_CENTS);

      expect(
        submitted.approval?.steps.map((step) => [step.sequence, step.role, step.state]),
      ).toEqual([
        [1, "MANAGER", "ACTIONABLE"],
        [2, "PURCHASING", "PENDING"],
        [3, "FINANCE", "PENDING"],
      ]);
      // Every step records the amount it was evaluated against, in exact centavos (FR-036).
      for (const step of submitted.approval?.steps ?? []) {
        expect(step.evaluatedAmountCents).toBe(TIER_THREE_CENTS);
      }
    });

    it("writes the submission audit event in the same transaction", async () => {
      const submitted = await submit(requesterToken, TIER_TWO_CENTS);
      const events = await auditEvents(submitted.id);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        organizationId: requester.organizationId,
        actorId: requester.userId,
        eventType: "PURCHASE_REQUEST_SUBMITTED",
        aggregateType: "PURCHASE_REQUEST",
        aggregateId: submitted.id,
        sequence: 1,
      });
      expect(events[0]?.payload).toEqual({
        status: "SUBMITTED",
        // A digit string, never a JSON number: this record is the authoritative one.
        estimatedTotalCents: TIER_TWO_CENTS,
        approvalFlowId: submitted.approval?.id,
        approvalStepCount: 2,
      });
    });

    it("leaves a DRAFT without a flow, rather than with an empty one", async () => {
      const created = await api.post("/purchase-requests", {
        accessToken: requesterToken,
        body: draftBody(),
      });

      expect((created.body as RequestBody).approval).toBeNull();
      await expect(database.approvalFlow.count()).resolves.toBe(0);
      await expect(database.auditEvent.count()).resolves.toBe(0);
    });
  });

  describe("FR-026 requester detail", () => {
    it("exposes the pending step and the ordered history to the requester", async () => {
      const submitted = await submit(requesterToken, TIER_THREE_CENTS);
      const read = await api.get(`/purchase-requests/${submitted.id}`, {
        accessToken: requesterToken,
      });

      expect(read.status).toBe(200);
      const body = read.body as RequestBody;
      expect(body.approval?.pendingStep).toMatchObject({
        sequence: 1,
        role: "MANAGER",
        state: "ACTIONABLE",
      });
      expect(body.approval?.steps.map((step) => step.sequence)).toEqual([
        1, 2, 3,
      ]);
    });

    it("shows the decision, its actor, reason, amount and timestamp once decided", async () => {
      const submitted = await submit(requesterToken, TIER_ONE_CENTS);
      const approved = await decide(managerToken, submitted.id, {
        decision: "APPROVED",
        reason: "Budget confirmed with finance",
      });
      expect(approved.status).toBe(200);

      const read = await api.get(`/purchase-requests/${submitted.id}`, {
        accessToken: requesterToken,
      });
      const body = read.body as RequestBody;

      expect(body.status).toBe("IN_QUOTATION");
      expect(body.approval?.state).toBe("COMPLETED");
      expect(body.approval?.pendingStep).toBeNull();
      expect(body.approval?.steps[0]).toMatchObject({
        state: "APPROVED",
        decidedById: manager.userId,
        decidedAt: expect.any(String),
        decisionReason: "Budget confirmed with finance",
        evaluatedAmountCents: TIER_ONE_CENTS,
      });
    });

    it("still refuses the detail route to anyone but the requester (MT-004)", async () => {
      const submitted = await submit(requesterToken);

      for (const token of [
        managerToken,
        otherDepartmentManagerToken,
        foreignManagerToken,
      ]) {
        const response = await api.get(`/purchase-requests/${submitted.id}`, {
          accessToken: token,
        });

        expect(response.status).toBe(404);
        expect(response.body).toEqual({
          statusCode: 404,
          message: "Not Found",
        });
      }
    });
  });

  describe("FR-030 manager queue", () => {
    it("contains the department's SUBMITTED requests, with the step awaiting the caller", async () => {
      const submitted = await submit(requesterToken, TIER_TWO_CENTS);
      const response = await api.get(
        "/purchase-requests/awaiting-my-approval",
        { accessToken: managerToken },
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        items: [
          {
            request: expect.objectContaining({
              id: submitted.id,
              status: "SUBMITTED",
              estimatedTotalCents: TIER_TWO_CENTS,
            }),
            pendingStep: expect.objectContaining({
              sequence: 1,
              role: "MANAGER",
              state: "ACTIONABLE",
            }),
          },
        ],
        nextCursor: null,
      });
    });

    it("excludes drafts, decided requests and cancelled ones", async () => {
      await api.post("/purchase-requests", {
        accessToken: requesterToken,
        body: draftBody(),
      });
      const decided = await submit(requesterToken);
      await decide(managerToken, decided.id, { decision: "APPROVED" });
      const cancelled = await submit(requesterToken);
      await api.post(`/purchase-requests/${cancelled.id}/cancel`, {
        accessToken: requesterToken,
      });
      const waiting = await submit(requesterToken);

      const response = await api.get(
        "/purchase-requests/awaiting-my-approval",
        { accessToken: managerToken },
      );
      const body = response.body as {
        readonly items: readonly { readonly request: { readonly id: string } }[];
      };

      expect(body.items.map((item) => item.request.id)).toEqual([waiting.id]);
    });

    it("never shows another department's request to a manager of this tenant", async () => {
      const submitted = await submit(requesterToken);
      const response = await api.get(
        "/purchase-requests/awaiting-my-approval",
        { accessToken: otherDepartmentManagerToken },
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ items: [], nextCursor: null });
      // And the request is genuinely there for the manager who is responsible for it.
      const own = await api.get("/purchase-requests/awaiting-my-approval", {
        accessToken: managerToken,
      });
      expect(
        (own.body as { readonly items: readonly unknown[] }).items,
      ).toHaveLength(1);
      expect(submitted.status).toBe("SUBMITTED");
    });

    it("never shows another tenant's request", async () => {
      await submit(requesterToken);

      const response = await api.get(
        "/purchase-requests/awaiting-my-approval",
        { accessToken: foreignManagerToken },
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ items: [], nextCursor: null });
    });

    it("omits the caller's own request, which BR-005 forbids them to decide", async () => {
      const own = await submit(requestingManagerToken);
      const colleagues = await submit(requesterToken);

      const response = await api.get(
        "/purchase-requests/awaiting-my-approval",
        { accessToken: requestingManagerToken },
      );
      const body = response.body as {
        readonly items: readonly { readonly request: { readonly id: string } }[];
      };

      expect(body.items.map((item) => item.request.id)).toEqual([
        colleagues.id,
      ]);
      expect(body.items.map((item) => item.request.id)).not.toContain(own.id);
    });

    it("refuses a principal that holds no MANAGER role, whatever else it holds", async () => {
      await submit(requesterToken);

      for (const token of [
        plainEmployeeToken,
        buyerToken,
        financeToken,
        // AUTHZ-007: an administrator is not an approver.
        administratorToken,
      ]) {
        const response = await api.get(
          "/purchase-requests/awaiting-my-approval",
          { accessToken: token },
        );

        expect(response.status).toBe(403);
        // The same bare capability refusal every route in this module gives: it names no
        // resource, no role and no reason, so it confirms nothing about what exists.
        expect(response.body).toEqual({
          statusCode: 403,
          message: "Not allowed to perform this action",
        });
      }
    });

    it("bounds the page size and rejects an unusable cursor (NFR-004)", async () => {
      await submit(requesterToken);

      for (const query of ["?limit=101", "?all=true", "?cursor=not-a-cursor"]) {
        const response = await api.get(
          `/purchase-requests/awaiting-my-approval${query}`,
          { accessToken: managerToken },
        );

        expect(response.status).toBe(400);
      }
    });
  });

  describe("FR-031 authorization of a decision", () => {
    it("refuses a principal holding no MANAGER role and writes nothing", async () => {
      const submitted = await submit(requesterToken);

      for (const token of [
        plainEmployeeToken,
        buyerToken,
        financeToken,
        administratorToken,
      ]) {
        const response = await decide(token, submitted.id, {
          decision: "APPROVED",
        });

        expect(response.status).toBe(403);
        // Names neither the resource nor the role that would have granted it.
        expect(response.body).toEqual({
          statusCode: 403,
          message: "Not allowed to perform this action",
        });
      }

      await expectUntouched(submitted.id);
    });

    it("refuses a manager of another department exactly as it refuses an unknown id", async () => {
      const submitted = await submit(requesterToken);

      for (const target of [submitted.id, randomUUID()]) {
        const response = await decide(otherDepartmentManagerToken, target, {
          decision: "APPROVED",
        });

        expect(response.status).toBe(404);
        expect(response.body).toEqual({
          statusCode: 404,
          message: "Not Found",
        });
      }

      await expectUntouched(submitted.id);
    });

    it("refuses a manager of another tenant, disclosing no existence", async () => {
      const submitted = await submit(requesterToken);

      for (const target of [submitted.id, randomUUID()]) {
        const response = await decide(foreignManagerToken, target, {
          decision: "APPROVED",
        });

        expect(response.status).toBe(404);
        expect(response.body).toEqual({
          statusCode: 404,
          message: "Not Found",
        });
      }

      await expectUntouched(submitted.id);
    });

    it("refuses self-approval and persists no decision, transition or audit event (BR-005)", async () => {
      const submitted = await submit(requestingManagerToken);

      for (const decision of ["APPROVED", "REJECTED"] as const) {
        const response = await decide(requestingManagerToken, submitted.id, {
          decision,
          reason: "I am quite sure about this one",
        });

        expect(response.status).toBe(403);
        expect(response.body).toEqual({
          statusCode: 403,
          message:
            "A requester may not decide the approval of their own purchase request",
        });
      }

      await expectUntouched(submitted.id);
    });

    it("refuses a body that tries to supply server-owned authority (SEC-004)", async () => {
      const submitted = await submit(requesterToken);

      for (const field of [
        { approvalStepId: randomUUID() },
        { organizationId: foreignManager.organizationId },
        { decidedById: manager.userId },
        { status: "APPROVED" },
        { evaluatedAmountCents: "1" },
        { sequence: 2 },
        { role: "FINANCE" },
        { roles: ["MANAGER"] },
      ]) {
        const response = await decide(managerToken, submitted.id, {
          decision: "APPROVED",
          ...field,
        });

        expect(response.status).toBe(400);
      }

      await expectUntouched(submitted.id);
    });

    it("refuses an unknown decision and a non-UUID identifier", async () => {
      const submitted = await submit(requesterToken);

      for (const body of [
        { decision: "MAYBE" },
        { decision: "approved" },
        { decision: null },
        {},
      ]) {
        expect((await decide(managerToken, submitted.id, body)).status).toBe(
          400,
        );
      }

      expect(
        (await decide(managerToken, "not-a-uuid", { decision: "APPROVED" }))
          .status,
      ).toBe(400);
      await expectUntouched(submitted.id);
    });
  });

  describe("FR-032 the decision itself", () => {
    it("moves exactly SUBMITTED to IN_QUOTATION on approval", async () => {
      const submitted = await submit(requesterToken, TIER_TWO_CENTS);
      const response = await decide(managerToken, submitted.id, {
        decision: "APPROVED",
      });

      expect(response.status).toBe(200);
      const body = response.body as RequestBody;
      expect(body.status).toBe("IN_QUOTATION");
      expect(body.approval?.state).toBe("ACTIVE");
      expect(
        body.approval?.steps.map((step) => [step.sequence, step.state]),
      ).toEqual([
        [1, "APPROVED"],
        // BR-002: the Purchasing step is evaluated against the selected quote total, so it
        // stays PENDING rather than being promoted here.
        [2, "PENDING"],
      ]);
      expect(body.approval?.pendingStep).toBeNull();
      expect(body.approval?.steps[0]?.decisionReason).toBeNull();
    });

    it("completes the flow when the Manager step was the only one (first tier)", async () => {
      const submitted = await submit(requesterToken, TIER_ONE_CENTS);
      const response = await decide(managerToken, submitted.id, {
        decision: "APPROVED",
      });

      expect((response.body as RequestBody).approval?.state).toBe("COMPLETED");
    });

    it("moves exactly SUBMITTED to REJECTED and stores the reason", async () => {
      const submitted = await submit(requesterToken, TIER_THREE_CENTS);
      const response = await decide(managerToken, submitted.id, {
        decision: "REJECTED",
        reason: "  Not budgeted for this quarter  ",
      });

      expect(response.status).toBe(200);
      const body = response.body as RequestBody;
      expect(body.status).toBe("REJECTED");
      expect(body.approval?.state).toBe("REJECTED");
      expect(body.approval?.steps[0]).toMatchObject({
        state: "REJECTED",
        decisionReason: "Not budgeted for this quarter",
        decidedById: manager.userId,
      });
      // The steps that will now never be decided are voided, not deleted (AUD-003).
      expect(
        body.approval?.steps.slice(1).map((step) => step.state),
      ).toEqual(["VOIDED", "VOIDED"]);
    });

    it("refuses a rejection with fewer than ten non-whitespace characters", async () => {
      const submitted = await submit(requesterToken);

      for (const reason of [undefined, "", "   ", "too short", "         "]) {
        const response = await decide(managerToken, submitted.id, {
          decision: "REJECTED",
          ...(reason === undefined ? {} : { reason }),
        });

        expect(response.status).toBe(422);
        expect(response.body).toEqual({
          statusCode: 422,
          message: "A rejection requires a reason of at least 10 characters",
        });
      }

      await expectUntouched(submitted.id);
    });

    it("refuses a blank approval reason rather than dropping it", async () => {
      const submitted = await submit(requesterToken);
      const response = await decide(managerToken, submitted.id, {
        decision: "APPROVED",
        reason: "   ",
      });

      expect(response.status).toBe(422);
      await expectUntouched(submitted.id);
    });

    it("is final: a second decision is refused, and the first one stands (BR-006)", async () => {
      const submitted = await submit(requesterToken, TIER_THREE_CENTS);
      expect(
        (await decide(managerToken, submitted.id, { decision: "APPROVED" }))
          .status,
      ).toBe(200);

      for (const body of [
        { decision: "APPROVED" },
        { decision: "REJECTED", reason: "Changed my mind entirely" },
      ]) {
        const again = await decide(managerToken, submitted.id, body);
        expect(again.status).toBe(409);
      }

      const step = await database.approvalStep.findFirstOrThrow({
        where: { purchaseRequestId: submitted.id, sequence: 1 },
      });
      expect(step.state).toBe("APPROVED");
      expect(step.decisionReason).toBeNull();

      const request = await database.purchaseRequest.findUniqueOrThrow({
        where: { id: submitted.id },
        select: { status: true },
      });
      expect(request.status).toBe("IN_QUOTATION");

      // Exactly one decision event, whatever was attempted afterwards.
      const events = await auditEvents(submitted.id);
      expect(events.map((event) => event.eventType)).toEqual([
        "PURCHASE_REQUEST_SUBMITTED",
        "APPROVAL_STEP_APPROVED",
      ]);
    });

    it("cannot reach a Purchasing or Finance step through the manager route", async () => {
      const submitted = await submit(requesterToken, TIER_THREE_CENTS);
      expect(
        (await decide(managerToken, submitted.id, { decision: "APPROVED" }))
          .status,
      ).toBe(200);

      // The request is in IN_QUOTATION with a PENDING Purchasing step. Neither a buyer nor a
      // manager can act on it: there is no actionable step of any decidable responsibility.
      expect(
        (await decide(buyerToken, submitted.id, { decision: "APPROVED" }))
          .status,
      ).toBe(403);
      expect(
        (await decide(managerToken, submitted.id, { decision: "APPROVED" }))
          .status,
      ).toBe(409);

      const steps = await database.approvalStep.findMany({
        where: { purchaseRequestId: submitted.id },
        orderBy: { sequence: "asc" },
      });
      expect(steps.map((step) => step.state)).toEqual([
        "APPROVED",
        "PENDING",
        "PENDING",
      ]);
    });

    it("writes exactly one decision audit event, carrying the decision facts", async () => {
      const submitted = await submit(requesterToken, TIER_THREE_CENTS);
      const rejected = await decide(managerToken, submitted.id, {
        decision: "REJECTED",
        reason: "Not budgeted for this quarter",
      });
      const step = (rejected.body as RequestBody).approval?.steps[0];
      const events = await auditEvents(submitted.id);

      expect(events.map((event) => [event.eventType, event.sequence])).toEqual([
        ["PURCHASE_REQUEST_SUBMITTED", 1],
        ["APPROVAL_STEP_REJECTED", 2],
      ]);
      expect(events[1]).toMatchObject({ actorId: manager.userId });
      expect(events[1]?.payload).toEqual({
        decision: "REJECTED",
        decisionReason: "Not budgeted for this quarter",
        evaluatedAmountCents: TIER_THREE_CENTS,
        approvalStepId: step?.id,
        approvalStepSequence: 1,
        approvalStepRole: "MANAGER",
        approvalFlowId: (rejected.body as RequestBody).approval?.id,
        approvalFlowState: "REJECTED",
        resultingStatus: "REJECTED",
      });
    });
  });

  describe("REL-005 concurrent decisions", () => {
    it("records one decision, one transition, one audit event and one conflict", async () => {
      const submitted = await submit(requesterToken, TIER_TWO_CENTS);

      const [first, second] = await Promise.all([
        decide(managerToken, submitted.id, { decision: "APPROVED" }),
        decide(managerToken, submitted.id, {
          decision: "REJECTED",
          reason: "Simultaneous and contradictory",
        }),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);

      const steps = await database.approvalStep.findMany({
        where: { purchaseRequestId: submitted.id, sequence: 1 },
      });
      expect(steps).toHaveLength(1);
      expect(["APPROVED", "REJECTED"]).toContain(steps[0]?.state);

      const request = await database.purchaseRequest.findUniqueOrThrow({
        where: { id: submitted.id },
        select: { status: true },
      });
      // The surviving transition is the one that matches the surviving decision.
      expect(request.status).toBe(
        steps[0]?.state === "APPROVED" ? "IN_QUOTATION" : "REJECTED",
      );

      const events = await auditEvents(submitted.id);
      expect(events.map((event) => event.eventType)).toEqual([
        "PURCHASE_REQUEST_SUBMITTED",
        steps[0]?.state === "APPROVED"
          ? "APPROVAL_STEP_APPROVED"
          : "APPROVAL_STEP_REJECTED",
      ]);
      expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    });
  });

  describe("FR-025 cancellation", () => {
    it("voids the unfinished flow and its steps while keeping the history", async () => {
      const submitted = await submit(requesterToken, TIER_THREE_CENTS);
      const cancelled = await api.post(
        `/purchase-requests/${submitted.id}/cancel`,
        { accessToken: requesterToken },
      );

      expect(cancelled.status).toBe(200);
      const body = cancelled.body as RequestBody;
      expect(body.status).toBe("CANCELLED");
      expect(body.approval?.state).toBe("VOIDED");
      expect(body.approval?.pendingStep).toBeNull();
      expect(body.approval?.steps.map((step) => step.state)).toEqual([
        "VOIDED",
        "VOIDED",
        "VOIDED",
      ]);
      // Nothing was deleted: the ladder that was required is still readable.
      await expect(
        database.approvalStep.count({
          where: { purchaseRequestId: submitted.id },
        }),
      ).resolves.toBe(3);

      const events = await auditEvents(submitted.id);
      expect(events.map((event) => event.eventType)).toEqual([
        "PURCHASE_REQUEST_SUBMITTED",
        "PURCHASE_REQUEST_CANCELLED",
      ]);
      expect(events[1]?.payload).toEqual({
        status: "CANCELLED",
        previousStatus: "SUBMITTED",
        voidedApprovalStepCount: 3,
      });
    });

    it("stops the request appearing in a queue and stops it being decided", async () => {
      const submitted = await submit(requesterToken);
      await api.post(`/purchase-requests/${submitted.id}/cancel`, {
        accessToken: requesterToken,
      });

      const queue = await api.get("/purchase-requests/awaiting-my-approval", {
        accessToken: managerToken,
      });
      expect(queue.body).toEqual({ items: [], nextCursor: null });

      const decision = await decide(managerToken, submitted.id, {
        decision: "APPROVED",
      });
      expect(decision.status).toBe(409);
    });

    it("still works after an approval put the request in IN_QUOTATION (BR-013)", async () => {
      const submitted = await submit(requesterToken, TIER_THREE_CENTS);
      expect(
        (await decide(managerToken, submitted.id, { decision: "APPROVED" }))
          .status,
      ).toBe(200);

      const cancelled = await api.post(
        `/purchase-requests/${submitted.id}/cancel`,
        { accessToken: requesterToken },
      );
      expect(cancelled.status).toBe(200);

      const body = cancelled.body as RequestBody;
      expect(body.status).toBe("CANCELLED");
      expect(body.approval?.state).toBe("VOIDED");
      // The decision that was made stays exactly as it was made.
      expect(body.approval?.steps.map((step) => step.state)).toEqual([
        "APPROVED",
        "VOIDED",
        "VOIDED",
      ]);
    });

    it("leaves a completed flow alone, because cancelling un-approves nothing", async () => {
      const submitted = await submit(requesterToken, TIER_ONE_CENTS);
      await decide(managerToken, submitted.id, { decision: "APPROVED" });
      const cancelled = await api.post(
        `/purchase-requests/${submitted.id}/cancel`,
        { accessToken: requesterToken },
      );

      const body = cancelled.body as RequestBody;
      expect(body.status).toBe("CANCELLED");
      expect(body.approval?.state).toBe("COMPLETED");
      expect(body.approval?.steps.map((step) => step.state)).toEqual([
        "APPROVED",
      ]);
    });

    it("keeps cancellation requester-owned and indistinguishable across tenants", async () => {
      const submitted = await submit(requesterToken);

      for (const token of [managerToken, foreignManagerToken]) {
        const response = await api.post(
          `/purchase-requests/${submitted.id}/cancel`,
          { accessToken: token },
        );

        expect(response.status).toBe(404);
        expect(response.body).toEqual({
          statusCode: 404,
          message: "Not Found",
        });
      }

      await expectUntouched(submitted.id);
    });

    it("refuses a rejected request, which is terminal (BR-004)", async () => {
      const submitted = await submit(requesterToken);
      await decide(managerToken, submitted.id, {
        decision: "REJECTED",
        reason: "Not budgeted for this quarter",
      });

      const cancelled = await api.post(
        `/purchase-requests/${submitted.id}/cancel`,
        { accessToken: requesterToken },
      );
      expect(cancelled.status).toBe(409);
    });
  });

  /**
   * Nothing moved: the request is still SUBMITTED, its Manager step is still the one waiting,
   * and the only audit event is the submission that created it.
   */
  async function expectUntouched(purchaseRequestId: string): Promise<void> {
    const request = await database.purchaseRequest.findUniqueOrThrow({
      where: { id: purchaseRequestId },
      select: { status: true },
    });
    expect(request.status).toBe("SUBMITTED");

    const steps = await database.approvalStep.findMany({
      where: { purchaseRequestId },
      orderBy: { sequence: "asc" },
    });
    expect(steps[0]).toMatchObject({
      state: "ACTIONABLE",
      decidedById: null,
      decidedAt: null,
      decisionReason: null,
    });

    const events = await auditEvents(purchaseRequestId);
    expect(events.map((event) => event.eventType)).toEqual([
      "PURCHASE_REQUEST_SUBMITTED",
    ]);
  }
});

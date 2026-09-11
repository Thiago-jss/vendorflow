import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/session/api-error";
import type { AuthenticatedRequestInput } from "@/session/browser-session";
import { createSessionDouble } from "@/session/session-double";
import { decideApproval, listApprovalQueue } from "./api";

const REQUEST_A = "1f8b7c62-5a4e-4f39-9a2b-0c6d1e5a7b31";

function recordingSession() {
  const calls: AuthenticatedRequestInput[] = [];
  const session = createSessionDouble({
    request: vi.fn(async (input: AuthenticatedRequestInput) => {
      calls.push(input);

      return {} as never;
    })
  });

  return { calls, session };
}

describe("approval transport", () => {
  it("asks for the queue without inventing a scope", async () => {
    const { calls, session } = recordingSession();

    await listApprovalQueue(session);

    expect(calls[0]?.path).toBe("/purchase-requests/awaiting-my-approval");
    expect(calls[0]?.method).toBeUndefined();
    expect(calls[0]?.body).toBeUndefined();
  });

  it("forwards the opaque cursor verbatim", async () => {
    const { calls, session } = recordingSession();

    await listApprovalQueue(session, { cursor: "opaque cursor/1", limit: 20 });

    expect(calls[0]?.path).toBe(
      "/purchase-requests/awaiting-my-approval?limit=20&cursor=opaque+cursor%2F1"
    );
  });

  it("sends only the two fields the decision contract declares", async () => {
    const { calls, session } = recordingSession();

    await decideApproval(session, REQUEST_A, { decision: "APPROVED" }, "key-1");

    expect(calls[0]).toEqual({
      path: `/purchase-requests/${REQUEST_A}/approval-decision`,
      method: "POST",
      body: { decision: "APPROVED" },
      idempotencyKey: "key-1"
    });
  });

  it("keeps a reason when there is one", async () => {
    const { calls, session } = recordingSession();

    await decideApproval(
      session,
      REQUEST_A,
      { decision: "REJECTED", reason: "Fora do orçamento" },
      "key-1"
    );

    expect(calls[0]?.body).toEqual({
      decision: "REJECTED",
      reason: "Fora do orçamento"
    });
  });

  it("refuses an identifier that is not the route's uuid, before anything leaves", async () => {
    const { calls, session } = recordingSession();

    await expect(
      decideApproval(session, "awaiting-my-approval", { decision: "APPROVED" }, "key-1")
    ).rejects.toBeInstanceOf(ApiRequestError);
    await expect(
      decideApproval(session, `${REQUEST_A}/../submit`, { decision: "APPROVED" }, "key-1")
    ).rejects.toBeInstanceOf(ApiRequestError);
    expect(calls).toHaveLength(0);
  });
});

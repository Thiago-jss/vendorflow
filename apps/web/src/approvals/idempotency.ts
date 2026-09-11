import type { ApprovalDecision } from "./contracts";

/**
 * What "the same approval decision" means to the browser.
 *
 * The key lifecycle itself is not re-implemented here: the inbox uses the same
 * `createIdempotencyKeyStore` the submission flow uses, so there is one place that knows when
 * a key is minted, kept across a retry and discarded. Only the *intent* is specific to a
 * decision, and this is it.
 *
 * Four things make a decision a different one, and any of them changing must mint a new key:
 *
 * - the request being decided;
 * - the rung of the ladder it is waiting on — a queue that moved on while the dialog was open
 *   is a decision about something the manager never looked at;
 * - approving versus rejecting;
 * - the reason, because the server records it and a changed reason is a changed outcome.
 *
 * The step identifier is deliberately absent from the *server's* fingerprint — it changes the
 * instant a decision commits, so including it there would make every legitimate replay look
 * like a new request. Including it here is the opposite concern and does not conflict: the
 * key is opaque to the server, and the browser is deciding when to stop reusing one.
 */
export interface ApprovalDecisionIntent {
  readonly purchaseRequestId: string;
  readonly approvalStepId: string;
  readonly decision: ApprovalDecision;
  /** Exactly the reason that will be sent; empty when none is sent. */
  readonly reason: string;
}

export function approvalDecisionFingerprint(
  intent: ApprovalDecisionIntent
): string {
  // JSON rather than a joined string: the reason is free text, and a separator typed inside
  // it must not be able to spell a different intent.
  return JSON.stringify([
    "approval-decision",
    intent.purchaseRequestId,
    intent.approvalStepId,
    intent.decision,
    intent.reason
  ]);
}

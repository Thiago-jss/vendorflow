/**
 * BR-001. The approval ladder, fixed in code.
 *
 * § 12.1 of the requirements records the position deliberately: the policy is code, not
 * tenant-owned configuration, "with the evaluation isolated so it can become data-driven
 * without touching the workflow". This file is that isolation — it is a pure function of an
 * amount, it imports nothing, and no part of the workflow knows how it reaches its answer.
 *
 * The thresholds are exact integer centavos, and the comparisons are `bigint` comparisons.
 * There is no `Number`, no division and no float anywhere in this file: R$ 1,000.00 is
 * `100_000n` centavos, and "one centavo over the boundary" has to be a value the type can
 * actually distinguish.
 */
export const approvalStepRoles = ["MANAGER", "PURCHASING", "FINANCE"] as const;

export type ApprovalStepRole = (typeof approvalStepRoles)[number];

/** R$ 1,000.00. The first tier's upper bound, inclusive (BR-001, assumption A-1). */
export const FIRST_TIER_MAXIMUM_CENTS = 100_000n;

/** R$ 5,000.00. The second tier's upper bound, inclusive. */
export const SECOND_TIER_MAXIMUM_CENTS = 500_000n;

/**
 * The steps BR-001 requires for an amount, in the order FR-035 executes them. The sequence is
 * 1-based and gap-free by construction: it is the position in this list, not a value anyone
 * chooses.
 */
export interface RequiredApprovalStep {
  readonly sequence: number;
  readonly role: ApprovalStepRole;
}

export function requiredApprovalStepRoles(
  amountCents: bigint,
): readonly ApprovalStepRole[] {
  if (amountCents <= FIRST_TIER_MAXIMUM_CENTS) {
    return ["MANAGER"];
  }

  if (amountCents <= SECOND_TIER_MAXIMUM_CENTS) {
    return ["MANAGER", "PURCHASING"];
  }

  return ["MANAGER", "PURCHASING", "FINANCE"];
}

export function requiredApprovalSteps(
  amountCents: bigint,
): readonly RequiredApprovalStep[] {
  return requiredApprovalStepRoles(amountCents).map((role, index) => ({
    sequence: index + 1,
    role,
  }));
}

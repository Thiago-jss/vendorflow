declare const transactionScopeBrand: unique symbol;

/**
 * An opaque handle to one in-flight PostgreSQL transaction.
 *
 * ADR-001 rule 4 requires a business change, the approval step it decides and its audit event
 * to commit together, and ADR-002 requires cross-module transactions to pass *the same*
 * client and the same trusted tenant scope. That means a use case has to hand something to
 * three different modules' persistence adapters — and application code may not import Prisma
 * (ADR-002, "Data Access Rules").
 *
 * This type is that something. It carries no members: only a persistence adapter can turn it
 * back into a database client, through `transactionClient` in the Prisma runner. Application
 * code can pass it along and can do nothing else with it, which is exactly the amount of
 * authority it should have.
 */
export interface TransactionScope {
  readonly [transactionScopeBrand]: true;
}

export const TRANSACTION_RUNNER = Symbol("TRANSACTION_RUNNER");

/**
 * Runs one operation inside a single database transaction. Throwing from the operation rolls
 * the whole transaction back — which is how a domain refusal discovered mid-transaction (a
 * lost compare-and-swap, for instance) leaves neither a business change nor an audit event
 * behind (REL-001, AUD-004).
 */
export interface TransactionRunner {
  run<T>(operation: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

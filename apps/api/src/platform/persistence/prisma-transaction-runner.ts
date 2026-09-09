import { Injectable } from "@nestjs/common";
import { DatabaseService, Prisma } from "@vendorflow/database";
import type {
  TransactionRunner,
  TransactionScope,
} from "./transaction-scope";

/**
 * Long enough for the widest transaction this phase runs — a conditional step decision, a
 * conditional request transition, a flow update and an audit append — and short enough that a
 * stuck transaction does not hold the request's row lock indefinitely. It matches the timeout
 * the procurement draft replacement already uses.
 */
const TRANSACTION_TIMEOUT_MS = 10_000;

@Injectable()
export class PrismaTransactionRunner implements TransactionRunner {
  constructor(private readonly database: DatabaseService) {}

  run<T>(operation: (scope: TransactionScope) => Promise<T>): Promise<T> {
    return this.database.$transaction(
      (transaction) => operation(toTransactionScope(transaction)),
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }
}

/**
 * The only two functions that know what a `TransactionScope` is. They are the seam between
 * the application-level contract and Prisma, and they live here — in infrastructure — rather
 * than next to the contract, so no application file has a reason to import Prisma.
 */
function toTransactionScope(
  transaction: Prisma.TransactionClient,
): TransactionScope {
  return transaction as unknown as TransactionScope;
}

/** Persistence adapters only. Calling this from a use case would defeat the point. */
export function transactionClient(
  scope: TransactionScope,
): Prisma.TransactionClient {
  return scope as unknown as Prisma.TransactionClient;
}

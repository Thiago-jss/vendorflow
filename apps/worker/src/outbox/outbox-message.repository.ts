import { Injectable } from "@nestjs/common";
import { DatabaseService, Prisma } from "@vendorflow/database";

export interface ClaimedOutboxMessage {
  readonly id: string;
  readonly organizationId: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
  readonly payload: Record<string, unknown>;
  readonly attemptCount: number;
}

interface ClaimedRow {
  readonly id: string;
  readonly organization_id: string;
  readonly event_type: string;
  readonly schema_version: number;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly correlation_id: string;
  readonly occurred_at: Date;
  readonly payload: Prisma.JsonValue;
  readonly attempt_count: number;
}

/** Bounded so a broker error message can never carry a payload or a credential into storage. */
const MAX_LAST_ERROR_LENGTH = 500;

/**
 * The relay's side of the outbox. It is a **trusted system-operation boundary**, not a
 * tenant-scoped product repository, and it is named and located so that is impossible to
 * misread: the claim scan deliberately spans every organization, because publishing is
 * infrastructure work that has no principal and no tenant of its own (ADR-002).
 *
 * The tenant is still carried end to end — every claimed row hands its `organization_id` to
 * the envelope, and the consumer validates it back against the persisted row before touching
 * tenant data. What this class must never grow is a method that reads or writes *business*
 * data across tenants.
 *
 * Every statement is a parameterized tagged template. There is no string-built SQL here
 * (SEC-005).
 */
@Injectable()
export class OutboxMessageRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Claims a batch in one statement, which is one implicit transaction, which commits before
   * the caller goes anywhere near the broker. That ordering is the invariant: no RabbitMQ I/O
   * ever happens inside an open PostgreSQL transaction.
   *
   * `FOR UPDATE SKIP LOCKED` settles contention *at the moment of claiming* — two relays never
   * select the same row, the second simply skips it. The lease settles the other problem,
   * which `SKIP LOCKED` cannot: a relay that dies after claiming. Holding the selecting
   * transaction open across the publication would solve that too, and would mean keeping a
   * PostgreSQL transaction open for the duration of a network round trip to a broker that may
   * be unreachable. The lease costs two columns and does not.
   */
  async claimPublishableBatch(input: {
    readonly leaseOwner: string;
    readonly leaseSeconds: number;
    readonly batchSize: number;
  }): Promise<readonly ClaimedOutboxMessage[]> {
    const rows = await this.database.$queryRaw<ClaimedRow[]>`
      UPDATE "outbox_messages" AS m
      SET "status" = 'PUBLISHING'::"outbox_message_status",
          "leased_by" = ${input.leaseOwner},
          "lease_expires_at" = now() + ${input.leaseSeconds}::int * interval '1 second',
          "attempt_count" = m."attempt_count" + 1,
          "updated_at" = now()
      FROM (
        SELECT "id"
        FROM "outbox_messages"
        WHERE ("status" = 'PENDING' AND "next_attempt_at" <= now())
           OR ("status" = 'PUBLISHING' AND "lease_expires_at" < now())
        ORDER BY "next_attempt_at", "created_at", "id"
        FOR UPDATE SKIP LOCKED
        LIMIT ${input.batchSize}
      ) AS claimable
      WHERE m."id" = claimable."id"
        AND m."status" IN ('PENDING', 'PUBLISHING')
      RETURNING m."id",
                m."organization_id",
                m."event_type"::text AS "event_type",
                m."schema_version",
                m."aggregate_type"::text AS "aggregate_type",
                m."aggregate_id",
                m."correlation_id",
                m."occurred_at",
                m."payload",
                m."attempt_count"
    `;

    return rows.map(toClaimedMessage);
  }

  /**
   * The second short transaction. The predicate proves the lease still belongs to this claim,
   * so a relay whose lease expired while it was publishing cannot overwrite the state of the
   * relay that took over. `false` means exactly that happened, and the caller says so instead
   * of pretending it published.
   */
  async markPublished(input: {
    readonly id: string;
    readonly leaseOwner: string;
  }): Promise<boolean> {
    const updated = await this.database.$executeRaw`
      UPDATE "outbox_messages"
      SET "status" = 'PUBLISHED'::"outbox_message_status",
          "published_at" = now(),
          "leased_by" = NULL,
          "lease_expires_at" = NULL,
          "last_error" = NULL,
          "updated_at" = now()
      WHERE "id" = ${input.id}::uuid
        AND "status" = 'PUBLISHING'
        AND "leased_by" = ${input.leaseOwner}
    `;

    return updated === 1;
  }

  /**
   * Releases the lease and decides, in the same statement, whether this row gets another try.
   * `attempt_count` was already incremented when the row was claimed, so the comparison is
   * against attempts actually made.
   *
   * A FAILED row keeps its `next_attempt_at` in the past and is still not claimable, because
   * the claim predicate matches on status. It is durable, inspectable and never republished by
   * accident — an operator decides (REL-006).
   */
  async releaseAfterFailure(input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly nextAttemptAt: Date;
    readonly lastError: string;
    readonly maxAttempts: number;
  }): Promise<"PENDING" | "FAILED" | "LEASE_LOST"> {
    const rows = await this.database.$queryRaw<{ status: string }[]>`
      UPDATE "outbox_messages"
      SET "status" = CASE
            WHEN "attempt_count" >= ${input.maxAttempts}
              THEN 'FAILED'::"outbox_message_status"
              ELSE 'PENDING'::"outbox_message_status"
          END,
          "next_attempt_at" = CASE
            WHEN "attempt_count" >= ${input.maxAttempts}
              THEN "next_attempt_at"
              ELSE ${input.nextAttemptAt}
          END,
          "leased_by" = NULL,
          "lease_expires_at" = NULL,
          "last_error" = ${truncateDiagnostic(input.lastError)},
          "updated_at" = now()
      WHERE "id" = ${input.id}::uuid
        AND "status" = 'PUBLISHING'
        AND "leased_by" = ${input.leaseOwner}
      RETURNING "status"::text AS "status"
    `;

    const status = rows[0]?.status;

    if (status === "PENDING" || status === "FAILED") {
      return status;
    }

    return "LEASE_LOST";
  }

  /**
   * For a row that can never be published however many times it is tried — an event type this
   * worker does not know, a payload that cannot be serialized. Retrying it would burn the
   * ladder to reach the same conclusion eight times.
   */
  async failPermanently(input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly lastError: string;
  }): Promise<boolean> {
    const updated = await this.database.$executeRaw`
      UPDATE "outbox_messages"
      SET "status" = 'FAILED'::"outbox_message_status",
          "leased_by" = NULL,
          "lease_expires_at" = NULL,
          "last_error" = ${truncateDiagnostic(input.lastError)},
          "updated_at" = now()
      WHERE "id" = ${input.id}::uuid
        AND "status" = 'PUBLISHING'
        AND "leased_by" = ${input.leaseOwner}
    `;

    return updated === 1;
  }
}

function truncateDiagnostic(value: string): string {
  return value.length <= MAX_LAST_ERROR_LENGTH
    ? value
    : `${value.slice(0, MAX_LAST_ERROR_LENGTH - 1)}…`;
}

function toClaimedMessage(row: ClaimedRow): ClaimedOutboxMessage {
  return {
    id: row.id,
    organizationId: row.organization_id,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at,
    payload:
      typeof row.payload === "object" &&
      row.payload !== null &&
      !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {},
    attemptCount: row.attempt_count,
  };
}

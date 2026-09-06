import { Injectable } from "@nestjs/common";
import { DatabaseService, Prisma } from "@vendorflow/database";
import type { AuthenticatedPrincipalRecord } from "../../../application/contracts/identity-access.repository";
import type {
  AuthSessionRepository,
  AuthSessionRotationResult,
  CreateAuthSessionInput,
  RejectedAuthSessionRotation,
  RotateAuthSessionInput,
} from "../../../application/contracts/auth-session.repository";
import { toPrincipalRole } from "./principal-role";

/**
 * Long enough that a transaction which waits on the presented session's row lock — the
 * expected shape of a concurrent refresh — finishes rather than aborting, and short enough
 * that a stuck transaction does not hold a lock indefinitely.
 */
const ROTATION_TRANSACTION_TIMEOUT_MS = 10_000;

interface RotatedSessionRow {
  readonly organizationId: string;
  readonly userId: string;
  readonly familyId: string;
  readonly expiresAt: Date;
}

@Injectable()
export class PrismaAuthSessionRepository implements AuthSessionRepository {
  constructor(private readonly database: DatabaseService) {}

  async createSession(input: CreateAuthSessionInput): Promise<void> {
    await this.database.authSession.create({
      data: {
        id: input.sessionId,
        organizationId: input.organizationId,
        userId: input.userId,
        familyId: input.familyId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      },
    });
  }

  async rotateSession(
    input: RotateAuthSessionInput,
  ): Promise<AuthSessionRotationResult> {
    return this.database.$transaction(
      async (transaction) => {
        // ── The compare-and-swap ───────────────────────────────────────────────────────
        // One statement decides who owns this refresh. Under READ COMMITTED a second
        // transaction updating the same row blocks on its row lock and, once the first
        // commits, re-evaluates this WHERE clause against the new row version: `revoked_at`
        // is no longer NULL, so the predicate fails and the statement returns no rows.
        // Reading the session and then writing it would instead let both transactions
        // observe it as active and each create a successor.
        //
        // Raw SQL because Prisma cannot express UPDATE ... RETURNING, and this must stay a
        // single statement. Parameters are bound by Prisma's tagged template, never
        // interpolated. The usual ADR-002 requirement of an explicit organization_id
        // predicate cannot apply here: the token digest is the only thing known before the
        // tenant is derived, and `organization_id` comes back in RETURNING to scope every
        // later statement in this transaction.
        const rotated = await transaction.$queryRaw<RotatedSessionRow[]>`
          UPDATE "auth_sessions"
          SET "revoked_at" = now(),
              "revocation_reason" = 'ROTATED'::"auth_session_revocation_reason"
          WHERE "token_hash" = ${input.presentedTokenHash}
            AND "revoked_at" IS NULL
            AND "expires_at" > now()
          RETURNING "organization_id" AS "organizationId",
                    "user_id" AS "userId",
                    "family_id" AS "familyId",
                    "expires_at" AS "expiresAt"
        `;

        const session = rotated[0];

        if (session === undefined) {
          return this.rejectRotation(transaction, input.presentedTokenHash);
        }

        const principal = await this.findActivePrincipal(transaction, session);

        if (principal === null) {
          // The credential was valid but the identity behind it is gone. Revoking the
          // family here is what makes deactivation stick: without it the other sessions of
          // this login would keep working until their own absolute expiry.
          await transaction.authSession.updateMany({
            where: {
              organizationId: session.organizationId,
              familyId: session.familyId,
              OR: [
                { revokedAt: null },
                { tokenHash: input.presentedTokenHash },
              ],
            },
            data: {
              revokedAt: new Date(),
              revocationReason: "PRINCIPAL_INACTIVE",
            },
          });

          return {
            outcome: "REJECTED",
            reuseDetected: false,
            organizationId: session.organizationId,
            familyId: session.familyId,
          };
        }

        // Same transaction as the compare-and-swap: a crash between the two leaves the
        // presented session usable rather than a family with no successor.
        await transaction.authSession.create({
          data: {
            id: input.successorSessionId,
            organizationId: session.organizationId,
            userId: session.userId,
            familyId: session.familyId,
            tokenHash: input.successorTokenHash,
            // Inherited, not recomputed. Rotation must not turn a 30-day absolute lifetime
            // into an unbounded one renewed every fifteen minutes.
            expiresAt: session.expiresAt,
          },
        });

        return {
          outcome: "ROTATED",
          principal,
          sessionId: input.successorSessionId,
          familyId: session.familyId,
          expiresAt: session.expiresAt,
        };
      },
      {
        // READ COMMITTED is sufficient and intentional: the conditional UPDATE above is
        // already serialized by PostgreSQL's row lock, so a stricter level would only add
        // serialization failures to retry, without removing a race.
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: ROTATION_TRANSACTION_TIMEOUT_MS,
        maxWait: ROTATION_TRANSACTION_TIMEOUT_MS,
      },
    );
  }

  async revokePresentedSession(input: {
    readonly presentedTokenHash: Uint8Array;
  }): Promise<void> {
    // Not organization-scoped, for the same reason the rotation CAS is not: the digest is
    // the only authority available, and it is globally unique. The row it matches carries
    // its own tenant, which is never taken from the request.
    await this.database.authSession.updateMany({
      where: {
        tokenHash: input.presentedTokenHash,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
        revocationReason: "LOGOUT",
      },
    });
  }

  /**
   * The conditional update matched nothing. Establish why — but only far enough to decide
   * whether this was a replay of an already-rotated token. Every outcome is reported to the
   * caller as the same rejection; the distinction exists to revoke a compromised family,
   * not to give the client a better error.
   */
  private async rejectRotation(
    transaction: Prisma.TransactionClient,
    presentedTokenHash: Uint8Array,
  ): Promise<RejectedAuthSessionRotation> {
    const existing = await transaction.authSession.findUnique({
      where: { tokenHash: presentedTokenHash },
      select: {
        organizationId: true,
        familyId: true,
        revocationReason: true,
      },
    });

    if (existing === null) {
      return {
        outcome: "REJECTED",
        reuseDetected: false,
        organizationId: null,
        familyId: null,
      };
    }

    // Expired, logged out, already revoked for reuse, or revoked because the principal
    // became inactive. None of those is evidence of a stolen token.
    if (existing.revocationReason !== "ROTATED") {
      return {
        outcome: "REJECTED",
        reuseDetected: false,
        organizationId: existing.organizationId,
        familyId: existing.familyId,
      };
    }

    // A token that was already exchanged has been presented again. Either it leaked, or a
    // client raced itself. The two are indistinguishable from here, and the safe reading is
    // the hostile one: revoke everything still live in this family, including the successor
    // that rotation just issued.
    await transaction.authSession.updateMany({
      where: {
        organizationId: existing.organizationId,
        familyId: existing.familyId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
        revocationReason: "REUSE_DETECTED",
      },
    });

    return {
      outcome: "REJECTED",
      reuseDetected: true,
      organizationId: existing.organizationId,
      familyId: existing.familyId,
    };
  }

  /**
   * Tenant-scoped by the compound selector, because the organization here is derived from
   * the session row PostgreSQL already proved belongs to this user, not from a client.
   */
  private async findActivePrincipal(
    transaction: Prisma.TransactionClient,
    session: RotatedSessionRow,
  ): Promise<AuthenticatedPrincipalRecord | null> {
    // ── The principal lock ─────────────────────────────────────────────────────────────
    // `FOR UPDATE` is what orders this decision against `UPDATE "users" SET "is_active"`.
    // An unlocked read is not enough: under READ COMMITTED a deactivation committing
    // between that read and the successor INSERT below would go unobserved, and rotation
    // would answer an already-revoked identity with a fresh access token and a live
    // successor session. Taking the row lock makes the two mutually exclusive — either the
    // deactivation commits first and this statement waits, then re-reads the committed row
    // as inactive, or it waits behind this transaction and finds the successor already
    // there to revoke.
    //
    // Raw SQL because Prisma has no row-lock clause. Both identifiers are bound by the
    // tagged template and both come from the session row the compare-and-swap returned —
    // never from HTTP input or a JWT claim — so ADR-002's tenant predicate holds on a
    // value PostgreSQL itself proved.
    const locked = await transaction.$queryRaw<
      Array<{ readonly isActive: boolean }>
    >`
      SELECT "is_active" AS "isActive"
      FROM "users"
      WHERE "organization_id" = ${session.organizationId}::uuid
        AND "id" = ${session.userId}::uuid
      FOR UPDATE
    `;

    // Absent and inactive are one outcome on purpose: both mean no principal.
    if (locked[0]?.isActive !== true) {
      return null;
    }

    // Read only after the lock is held, so the roles that go into the access token belong
    // to the same committed row version the activity check just accepted.
    const roles = await transaction.userRole.findMany({
      where: {
        organizationId: session.organizationId,
        userId: session.userId,
      },
      orderBy: { role: "asc" },
      select: { role: true },
    });

    return {
      userId: session.userId,
      organizationId: session.organizationId,
      roles: roles.map(({ role }) => toPrincipalRole(role)),
    };
  }
}

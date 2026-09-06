# Authentication and Session Security

**Status:** Implemented foundation
**Last updated:** 2026-09-05
**Scope:** Password login, access tokens, refresh sessions, logout, principal binding, and
the first protected endpoint

This document makes SEC-001, SEC-002, SEC-003, SEC-006, SEC-007 and MT-003 concrete. It does
not introduce registration, password reset, credential management, MFA, OAuth/SSO,
logout-all-sessions, or any authorization policy beyond authenticating the principal.

## What this slice authenticates

```text
POST /auth/login    email + password  →  access token (JSON) + refresh session (cookie)
POST /auth/refresh  refresh cookie    →  new access token + rotated refresh cookie
POST /auth/logout   refresh cookie    →  204, session revoked, cookie cleared
GET  /me/organization  access token   →  persisted organization, branch, department, roles
GET  /health, /health/ready           →  public
```

Authentication is **default-deny**. A global `AccessTokenAuthGuard` protects every route;
only a handler carrying `@Public()` is exempt. Protecting a new route requires no action,
while exposing one requires an explicit decision that shows up in review.

## The persisted principal is the authority

`TrustedPrincipal` is what every application use case treats as truth, so the question of
where it comes from is the central security decision of this slice.

The access token is a signed JWT carrying identity, organization, effective roles and the
session identifier, which is what SEC-001 asks for. Those claims are **signed metadata, not
authorization authority**. On every protected request the guard:

1. parses exactly one compact-serialization Bearer token;
2. verifies it with an explicit `HS256` allowlist, the configured issuer and audience, the
   `JWT` type, and zero clock tolerance;
3. validates the claim set against a strict schema, rejecting unknown claims;
4. loads the **active** persisted user by `sub`;
5. rejects if persisted `organizationId` differs from the signed `org` claim;
6. builds `TrustedPrincipal` from the persisted user and the **persisted** roles;
7. calls `bindTrustedPrincipal` once.

Steps 4–6 are the point. Building the principal from claims would mean a deactivated user
(FR-004) or a revoked role (FR-006) kept working until the token expired. Instead both take
effect on the **next request**, which the integration suite proves against real PostgreSQL
using an unexpired token issued before the change.

The lookup in step 4 selects by primary key alone and then _compares_ the organization. That
is deliberate and is documented at the port: scoping the query by the claimed organization
would make a mismatch look like a missing user, turning a security event into a miss. It is
an authentication-only exception to the ADR-002 rule that every tenant-owned read carries an
`organizationId` from an already-trusted principal, and the same exception covers resolving
a User by normalized email at login (MT-006). No domain read may copy it.

Cost is two index lookups per request — `users_pkey`, then the `user_roles` primary key on
its `(organization_id, user_id)` prefix — with a bounded result of at most five roles. That
is a small fraction of the NFR-002 budget, and no measurement supports trading correctness
for it.

An active user holding **no** roles authenticates successfully and is bound with an empty
role set. That is a 403 question for authorization to answer under default-deny, not a 401
question about credentials.

## Passwords

Argon2id through the native `argon2` package, at the current OWASP baseline of 19 MiB
memory, two passes and one lane. Memory is raised before time cost because memory is what
actually costs a GPU attacker.

`users.password_hash` is **nullable, with no default and no backfill**. A User created
before any credential-management flow exists simply has no password and can never
authenticate. A bootstrap password would be a shared secret nobody rotates, so there is
none. A database `CHECK` additionally requires `NULL` or a value starting `$argon2id$`, so
an alternate write path storing plaintext or a weaker digest fails at the layer that cannot
be argued with.

Login answers **identically** for an unknown address, a deactivated user, a user with no
password hash, and a wrong password: `401 {"statusCode":401,"message":"Invalid credentials"}`
with no cookie. Equality is asserted byte-for-byte in the integration suite, not merely by
status code.

Timing is equalized too. Whenever there is no stored hash to verify, login verifies a
**decoy** — a hash of ephemeral random material generated once per process, that no password
can match and that is never persisted. Without it, `password_hash IS NULL` would return in
about a millisecond while a wrong password takes tens of milliseconds, and that difference
is an account-enumeration oracle.

## Tokens and sessions

|                | Access token         | Refresh token                      |
| -------------- | -------------------- | ---------------------------------- |
| Form           | Signed JWT (HS256)   | Opaque, 32 random bytes, base64url |
| Lifetime       | 15 minutes           | 30 days, **absolute**              |
| Transport      | JSON response body   | `HttpOnly` cookie only             |
| Client storage | Frontend memory only | Browser cookie jar                 |
| Server storage | None                 | SHA-256 digest only                |
| Revocable      | No (expires)         | Yes, immediately                   |

The refresh token never appears in a response body, a log, or an error. Persistence holds
only its SHA-256 digest, so reading the table cannot reconstruct a usable credential.

SHA-256 rather than Argon2id for the refresh token, deliberately: the token is 256 bits of
CSPRNG output, so there is no small search space for a memory-hard function to protect, and
the digest must be deterministic because it is the lookup key. A per-row salt would make
finding the session impossible. Argon2id remains exclusive to passwords, which are
low-entropy by nature.

The access token carries `sid`, the session identifier. Nothing reads it in this slice. It
is issued now so that session-bound checks — logout-all-sessions in particular — can be
added later without changing the token format or invalidating tokens in circulation.

## Refresh rotation is a compare-and-swap

Every refresh consumes its session and issues a successor. The security-critical transition
is a **single conditional UPDATE**, not read-then-write:

```sql
UPDATE "auth_sessions"
SET "revoked_at" = now(),
    "revocation_reason" = 'ROTATED'
WHERE "token_hash" = $1
  AND "revoked_at" IS NULL
  AND "expires_at" > now()
RETURNING "organization_id", "user_id", "family_id", "expires_at"
```

Under `READ COMMITTED`, a second transaction updating the same row blocks on its row lock;
when the first commits, the second re-evaluates this `WHERE` against the new row version,
finds `revoked_at` no longer `NULL`, and returns **zero rows**. Only the transaction that
gets a row may create the successor, and it does so in the same transaction — so a crash
between the two leaves the presented session usable rather than a family with no successor.

`READ COMMITTED` is sufficient and intentional. PostgreSQL's row lock already serializes the
decision; `SERIALIZABLE` would add serialization failures to retry without removing a race,
and a distributed lock would add an availability dependency for a guarantee the database
already provides.

The transaction then verifies the user is **still active** before committing a successor. A
deactivated principal gets no fresh access token; the family is revoked with
`PRINCIPAL_INACTIVE`.

That check takes a **row lock on the User**, in the same transaction, before it decides:

```sql
SELECT "is_active"
FROM "users"
WHERE "organization_id" = $1 AND "id" = $2
FOR UPDATE
```

An unlocked read would not be enough. Under `READ COMMITTED` a deactivation committing
between the read and the successor `INSERT` goes unobserved, and rotation hands out a fresh
access token and a live successor behind an identity that is already gone. The access-token
guard would refuse that token on the next protected request, because it reloads persistence
— but the token was still issued and the successor still exists, which is not the guarantee
this document makes. `FOR UPDATE` conflicts with the `FOR NO KEY UPDATE` lock an ordinary
`UPDATE "users" SET "is_active" = false` takes, so the two orderings become mutually
exclusive: either the deactivation commits first and this statement waits, then re-reads the
committed row as inactive, or it waits behind rotation and finds the successor already there
to revoke. Both identifiers are taken from the session row the compare-and-swap returned,
never from HTTP input or a JWT claim.

Raw SQL appears here and only here, because Prisma can express neither `UPDATE ... RETURNING`
nor a row-lock clause, and the conditional update must stay one statement. Parameters are
bound through Prisma's tagged template. ADR-002's requirement that raw SQL carry an explicit
`organization_id` predicate cannot apply to the compare-and-swap: the token digest is the
only thing known before the tenant is derived. The tenant comes back in `RETURNING` and
scopes every later statement in the transaction, the User lock included.

### Reuse detection

If the conditional update loses, the transaction inspects the presented digest only far
enough to decide whether this was a **replay of an already-rotated token**. If it was, every
still-active session in that family is revoked with `REUSE_DETECTED`.

Detection is strict: there is no leeway window. A client that fires two refreshes
concurrently therefore loses its session, exactly as a client whose token was stolen would.
The trade is accepted because the two are indistinguishable from the server and the safe
reading is the hostile one. **The web client must serialize refreshes** — a single in-flight
refresh promise that other requests await — or users will see spurious logouts. That
obligation belongs to the frontend slice and is recorded here because it is not visible from
the API alone.

All refresh failures — missing, unknown, expired, rotated, logged out, revoked, reused, or
belonging to an inactive principal — return `401 {"statusCode":401,"message":"Invalid session"}`
and clear the cookie.

### Session table

```text
auth_sessions
  id, organization_id, user_id, family_id,
  token_hash, issued_at, expires_at, revoked_at, revocation_reason
```

- `UNIQUE (token_hash)` is global, not tenant-scoped: it is the lookup key used before any
  identity is known, and it is what makes the rotation UPDATE touch at most one row.
- `CHECK (octet_length(token_hash) = 32)` refuses anything that is not a SHA-256 digest.
- `CHECK (expires_at > issued_at)` and `CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL))`
  keep the lifecycle representable only in valid states.
- `UNIQUE (organization_id, id)` is the tenant-aware candidate key required of every
  tenant-owned parent by ADR-002.
- `FOREIGN KEY (organization_id, user_id) REFERENCES users (organization_id, id)` makes a
  cross-tenant session impossible in the database, not merely unlikely in the application.
- Indexes: `(organization_id, user_id, issued_at DESC)` tenant-leading; `(family_id)` for
  family revocation; a partial index on `expires_at WHERE revoked_at IS NULL` for a future
  cleanup worker.

There is **no** `replaced_by_session_id` and no stored copy of the successor's token. The
family identifier already links a rotation chain, and reuse detection needs only to know
that a row was already rotated. A stored replacement digest would put a second
credential-derived value in the row for no additional capability.

## Cookie and CSRF design

The refresh cookie is `vf_refresh`, `HttpOnly`, `SameSite=Strict`, `Path=/auth`, host-only
(no `Domain` attribute), `Secure` when `NODE_ENV=production`, with `Max-Age` equal to the
**remaining** absolute session lifetime so the browser drops it exactly when the server-side
session stops being usable.

No `__Host-` prefix: that prefix requires `Path=/`, which would send the refresh token to
every endpoint of the API. Scoping the cookie to the three routes that consume it is the
more valuable control, and the guarantees the prefix would enforce — host-only and Secure —
are set explicitly instead.

`SameSite=Strict` is the primary CSRF defence and works because production web and API share
one registrable domain. An **Origin allowlist guard** is the independent second layer on the
three cookie-bearing POST routes. It runs before any credential is read, and a missing or
non-allowlisted `Origin` is `403`.

**CORS is not the CSRF control.** A browser applies CORS to the _response_, after the
request has already reached the server and performed its side effect. An attacker who never
reads the reply is unaffected by it.

## Abuse limits

| Dimension                              | Limit      | Storage                        |
| -------------------------------------- | ---------- | ------------------------------ |
| Source address, per limited auth route | 10 / 60 s  | `@nestjs/throttler`, in memory |
| Failed logins, per account             | 5 / 15 min | in-process map                 |

Both dimensions answer with one identical `429 {"statusCode":429,"message":"Too many requests"}`,
built from a single exception class so the two cannot drift apart. If they differed, the
lockout response would confirm which addresses exist.

The account limiter counts failures for **unknown addresses too**, for the same reason:
counting only real accounts would make the lockout itself an enumeration oracle. Its keys
are SHA-256 digests of the normalized address, so the map never holds a list of the
product's account addresses even in a heap dump. A successful login clears only that
account's counter.

The address limit is keyed per route rather than across the auth surface. Password guessing
happens on login and is capped there on its own, while a burst of refreshes from a
multi-tab client cannot exhaust the budget a user needs to sign in.

It applies to `POST /auth/login` and `POST /auth/refresh` **only**. `POST /auth/logout` is
deliberately outside it: logout carries no guessable secret, only ever revokes, and the worst
a flood achieves is revoking sessions whose tokens the caller already holds. Limiting it
would let anyone who exhausts the address budget — trivially, from the same NAT or proxy as
the victim — keep the victim's sign-out returning `429` while the cookie survives. Logout
stays idempotent, always clears `vf_refresh`, and always answers `204`. The Origin allowlist
guard still covers all three routes, and because Nest runs controller guards before handler
guards it still refuses a cross-site attempt before any budget is spent.

> **Limitation, stated plainly.** Both limiters are **process-local**. They are correct for
> exactly one API instance and are lost on restart. A second instance multiplies the
> effective allowance by the number of instances, silently weakening SEC-006. **Replacing
> both with a Redis-backed counter is a prerequisite for horizontal API scaling**, not an
> optimization. Redis is deliberately not introduced here: it is provisioned but has no
> runtime responsibility, and adding a boot dependency for a single-instance deployment
> would contradict ADR-002's stance on unused infrastructure.

`app.set("trust proxy")` is **not** enabled. No proxy topology is configured, and trusting
forwarding headers would let a client choose the source address the limiter sees, turning
the address limit into no limit at all. Enabling it is a deliberate decision to make
alongside a real proxy configuration.

## Logging

Pino redacts `req.headers.authorization`, `req.headers.cookie`, the whole `req.body`, and
`res.headers['set-cookie']`. The body is redacted wholesale rather than field by field
because an authentication body is credentials end to end, and a field list silently misses
the next field added.

Security-significant events are logged with **identifiers only**:
`ACCESS_TOKEN_ORGANIZATION_MISMATCH` (a correctly signed token disagreeing with persistence,
which means compromised signing material or broken issuance), `REFRESH_TOKEN_REUSE_DETECTED`,
and `PASSWORD_HASH_BELOW_CURRENT_PARAMETERS`. No password, digest, token, cookie value,
address or name is ever written. `AuditEvent` persistence is not in this slice, so these are
logs, not audit records.

A persistence outage is **not** converted into a 401. The guard maps only its own
authentication error to `Unauthorized` and lets anything else surface as a sanitized 500:
availability is not an identity signal.

## Rejected alternatives

**Refresh token as a JWT.** Self-contained refresh tokens cannot be revoked before expiry
without a server-side denylist, which is the session table with extra steps and worse
failure modes. SEC-003 requires server-side revocation.

**Access token in a cookie.** It would need CSRF protection on every endpoint rather than on
three, and it would make the access token durable on disk. Memory-only in the frontend
bounds the blast radius of XSS to the current page lifetime.

**`jose` v6.** ESM-only, and this API compiles to CommonJS under Nest. Pinned to `5.10.0`,
which ships both module formats. Revisit when the API moves to ESM.

**Asymmetric access tokens (EdDSA/RS256).** Worth adopting when a second service must verify
tokens it did not issue. Today the only verifier is the issuer, so a symmetric key is one
fewer key-distribution problem. The algorithm allowlist is explicit, so the change is
contained; note the token has no `kid`, so rotating the key invalidates tokens in
circulation for at most one access-token lifetime.

**Sliding refresh expiry.** Rejected: a session that renews its 30-day lifetime on every
15-minute refresh is an unbounded session wearing a lifetime. Successors inherit the
predecessor's `expires_at`.

**A separate `auth` module.** Rejected per ADR-001: it would split the identity model from
the thing that authenticates against it. `identity-access` owns both.

## Verification

Unit tests cover the Argon2id adapter (PHC shape, salting, decoy cost, rehash detection,
unparseable digests), the JWT adapter (issue/verify, malformed, wrong key, `alg: none`,
expiry with no leeway, wrong issuer/audience, strict claim validation), the guard (persisted
roles over claim roles, organization mismatch, inactive and missing users, Bearer parsing
including a duplicated header, outage passthrough), the Origin guard, the cookie
attributes including the production `Secure` flag, the account limiter, and both use cases.

PostgreSQL/Testcontainers tests prove what only a real database can: `password_hash`
nullability and the absence of any generated credential, the `CHECK` constraint rejecting
plaintext and non-Argon2id digests, cross-tenant session rejection, duplicate digest
rejection, the lifecycle checks, and the rotation semantics — one successor per rotation,
inherited expiry, exactly one winner among concurrent refreshes with no second successor
persisted, family revocation on replay, and no successor for an inactive principal. Two
tests drive independent connections and synchronize on PostgreSQL's own lock reporting
rather than on a sleep: one shows the second `UPDATE` blocking on the session row lock and
then matching nothing, which is the premise the whole design rests on; the other holds an
uncommitted deactivation and shows rotation blocking on the User row, then rejecting with no
successor once that deactivation commits.

HTTP tests run the real application — same modules, guards, pipes, filter and cookie parser
as `main.ts` — and assert the cookie attributes, byte-identical credential failures,
Origin rejection before credential work, logout idempotence, and that deactivation and role
revocation take effect on the next request with an unexpired token.

## Known gaps

1. **No session cleanup.** `auth_sessions` grows without bound. The partial index is in
   place for the worker that will delete expired rows; the worker is not in this slice.
2. **No logout-all-sessions.** Logout revokes only the presented session.
3. **No credential-management flow.** Users without a password hash cannot be given one
   through the API yet. `needsRehash` is reported as a log signal because there is no write
   path to act on it.
4. **Route existence is observable.** An unmatched path answers 404 while a protected one
   answers 401, because Nest runs guards only for matched handlers. No tenant data, identity
   or session state is disclosed.
5. **No audit records.** Security events are logs. `AUD-001` coverage arrives with the audit
   module.

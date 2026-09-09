# VendorFlow

VendorFlow is an open-source B2B procurement platform. This repository currently provides
the production-oriented technical bootstrap and the identity/organization persistence
foundation; procurement workflows are intentionally not implemented yet. Product and
architecture decisions live in [`docs/`](docs/).

## Prerequisites

- Node.js 22 or newer
- pnpm 10 or newer
- Docker with Docker Compose

## Local development

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Create local configuration (the example contains development-only placeholders):

   ```bash
   cp .env.example .env
   ```

3. Start PostgreSQL, Redis, and RabbitMQ:

   ```bash
   docker compose up -d
   ```

4. Generate Prisma Client and apply the committed migration:

   ```bash
   pnpm db:generate
   pnpm db:deploy
   ```

5. Start all application processes:

   ```bash
   pnpm dev
   ```

The web app is available at `http://localhost:3000`; the API liveness endpoint is
`http://localhost:3001/health` and the worker's is `http://localhost:3002/health`; RabbitMQ
management is `http://localhost:15672` (`vendorflow` / `vendorflow`).

The two readiness endpoints deliberately differ. API readiness at `/health/ready` verifies
PostgreSQL only, so purchase decisions keep committing while the side-effect path is degraded
(REL-007). Worker readiness at `/health/ready` verifies PostgreSQL **and** a usable RabbitMQ
connection, because draining the outbox needs both (REL-008). A broker outage never stops the
worker process and never blocks an API write.

The API requires `DATABASE_URL` and `CORS_ORIGINS`. The worker requires `DATABASE_URL` and
`RABBITMQ_URL`: it owns the outbox relay and the delivery consumer, so PostgreSQL is no longer
optional for it. Redis remains available in Docker Compose for future ephemeral concerns, but
no application requires `REDIS_URL` to boot. Do not put secrets in `NEXT_PUBLIC_*` values.

Prisma infrastructure, the authoritative schema, and the single migration history live in
`packages/database`. API and worker code must use that package rather than importing one
another's infrastructure.

## Commands

```bash
pnpm dev          # run web, API, and worker
pnpm lint         # lint all workspaces
pnpm typecheck    # strict TypeScript checks
pnpm test         # all tests, including PostgreSQL/RabbitMQ integration tests
pnpm test:integration # PostgreSQL/RabbitMQ Testcontainers integration tests only
pnpm build        # build all workspaces
pnpm db:generate  # generate Prisma Client
pnpm db:migrate   # create a local development migration
pnpm db:deploy    # apply committed migrations
pnpm db:validate  # validate the authoritative Prisma schema
```

Docker Compose runs infrastructure only. Application processes run locally to keep the
development feedback loop fast. Redis has no runtime responsibility.

RabbitMQ now carries committed outgoing facts. A business transition writes its state change,
its audit event and its intent to emit in one PostgreSQL transaction; the worker publishes that
committed intent with publisher confirms, and an idempotent consumer records a durable receipt.
Delivery is at-least-once, retries use a real 10s/60s/300s ladder, and exhausted failures are
parked — publisher-side as `FAILED` outbox rows, consumer-side in a dead-letter queue. PostgreSQL
remains authoritative; RabbitMQ is transport and holds no authority over tenant, identity or
business state. The reasoning is in
[`docs/adr/ADR-003-reliable-side-effects.md`](docs/adr/ADR-003-reliable-side-effects.md) and the
implementation in
[`docs/architecture/reliable-side-effects.md`](docs/architecture/reliable-side-effects.md).

Docker must be available when running the integration tests. The API tests start their own
isolated PostgreSQL container and the worker tests start PostgreSQL **and** RabbitMQ; both apply
the committed Prisma migration history and neither reuses or cleans the development database.
The implemented identity model and tenant-key design are described in
[`docs/architecture/identity-persistence.md`](docs/architecture/identity-persistence.md).

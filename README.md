# VendorFlow

VendorFlow is an open-source B2B procurement platform. This repository currently provides
the production-oriented technical bootstrap; procurement workflows are intentionally not
implemented yet. Product and architecture decisions live in [`docs/`](docs/).

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
`http://localhost:3001/health`; RabbitMQ management is `http://localhost:15672`
(`vendorflow` / `vendorflow`). API readiness at `/health/ready` verifies PostgreSQL.

The API and worker validate their mandatory environment configuration at startup. Required
values are `DATABASE_URL`, `REDIS_URL`, and (for the worker) `RABBITMQ_URL`; the API also
requires `CORS_ORIGINS`. Do not put secrets in `NEXT_PUBLIC_*` values.

## Commands

```bash
pnpm dev          # run web, API, and worker
pnpm lint         # lint all workspaces
pnpm typecheck    # strict TypeScript checks
pnpm test         # API/worker Jest and web Vitest tests
pnpm build        # build all workspaces
pnpm db:generate  # generate Prisma Client
pnpm db:migrate   # create a local development migration
pnpm db:deploy    # apply committed migrations
```

Docker Compose runs infrastructure only. Application processes run locally to keep the
development feedback loop fast. Redis and RabbitMQ are configured foundations only: no cache
behavior, consumers, outbox, retries, or dead-letter queues exist yet.

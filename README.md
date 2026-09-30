# Paint Retail SaaS

Multi-store, multi-brand paint dealer platform for India. Product plans live in the
[roadmap repo](https://github.com/kamaljeet121/paint-retail-saas-roadmap).

## The first rule: every line of code is tested

- **Unit tests** (`src/**/*.test.ts`) cover logic in isolation: no network, no database.
- **Integration tests** (`src/**/*.int.test.ts`) run against a real PostgreSQL 17 in Docker
  (Testcontainers). No database mocks.
- Coverage across both suites must stay at **100%** for statements, branches, functions and
  lines. The run fails otherwise, locally and in CI.
- New code and its tests land in the same commit.

## Prerequisites

| Tool    | Version               | Notes                                                                        |
| ------- | --------------------- | ---------------------------------------------------------------------------- |
| Node.js | 24 LTS (see `.nvmrc`) | `nvm use`                                                                    |
| pnpm    | via Corepack          | `corepack enable`                                                            |
| Docker  | any recent engine     | On macOS we use [Colima](https://github.com/abiosoft/colima): `colima start` |

**Colima only:** Testcontainers needs to know where Colima's Docker socket is.

```sh
echo "docker.host=unix://$HOME/.colima/default/docker.sock" > ~/.testcontainers.properties
echo 'export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock' >> ~/.zshrc
```

## Getting started

```sh
nvm use
corepack enable
pnpm install
pnpm verify
```

## Commands

| Command                                        | What it does                                |
| ---------------------------------------------- | ------------------------------------------- |
| `pnpm test:unit`                               | Unit tests only (fast, no Docker)           |
| `pnpm test:integration`                        | Integration tests against a real PostgreSQL |
| `pnpm test:coverage`                           | Both suites, failing below 100% coverage    |
| `pnpm test:watch`                              | Re-run tests on save                        |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | Code quality                                |
| `pnpm verify`                                  | Everything CI runs, in the same order       |

## Run the API locally

```sh
docker compose up -d                        # local PostgreSQL 17 on port 55432
cp apps/api/.env.example apps/api/.env
pnpm --filter @paint/api build
pnpm --filter @paint/api start              # http://localhost:3000
curl localhost:3000/health/ready            # {"status":"ok","checks":{"database":"up"}}
```

`GET /health` answers while the process runs (liveness). `GET /health/ready` also checks
PostgreSQL and answers 503 when it is unreachable (readiness).

## Database

- Tables are defined in `packages/db/src/schema.ts`. After changing it, generate a migration with
  `pnpm --filter @paint/db db:generate` and commit the new file in `packages/db/migrations/`.
- Hand-written SQL (roles, grants, data fixes): `pnpm --filter @paint/db db:custom --name <what>`.
- **Tenant isolation:** every tenant query runs inside `withTenant(db, organizationId, work)`.
  PostgreSQL row-level security then limits it to that organisation's rows. Every table must
  enable row-level security with a policy; an integration test fails the build otherwise.

## Layout

```
apps/api              HTTP API (NestJS on Fastify), built with Vite into dist/server
packages/db           PostgreSQL schema, migrations, tenant isolation (Drizzle)
packages/shared       code shared by all apps (money in paise, …)
packages/testing      test helpers (throwaway PostgreSQL for integration tests)
```

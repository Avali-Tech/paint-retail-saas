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

## API

Every route requires `Authorization: Bearer <token>` unless marked public.

| Method | Path                       | Access           | What it does                                                                                                                        |
| ------ | -------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`, `/health/ready` | public           | Liveness and readiness (checks PostgreSQL)                                                                                          |
| POST   | `/auth/signup`             | public           | New business + owner; returns a session token                                                                                       |
| POST   | `/auth/login`              | public           | Mobile/email + password. 409 lists businesses if the person belongs to several; resend with `organizationId`                        |
| POST   | `/auth/otp/request`        | public           | Texts a 6-digit code (30 s between codes, 5 per hour)                                                                               |
| POST   | `/auth/otp/verify`         | public           | Code (5 tries, 5 minutes) → session token                                                                                           |
| GET    | `/auth/me`                 | signed in        | User, business, role, permissions, store access                                                                                     |
| POST   | `/auth/logout`             | signed in        | Ends this device's session                                                                                                          |
| GET    | `/stores`                  | `stores:read`    | Stores the member can access                                                                                                        |
| GET    | `/stores/:id`              | `stores:read`    | One store (404 if not accessible)                                                                                                   |
| POST   | `/stores`                  | `stores:manage`  | Create a store or godown                                                                                                            |
| GET    | `/roles`                   | `members:read`   | Roles with their permissions                                                                                                        |
| GET    | `/members`, `/members/:id` | `members:read`   | Team members the caller can see (people in their stores)                                                                            |
| POST   | `/members`                 | `members:manage` | Add a person (links an existing account) with a role and stores                                                                     |
| PATCH  | `/members/:id`             | `members:manage` | Change role, stores or active status (deactivating signs them out)                                                                  |
| GET    | `/parties`                 | `parties:read`   | Customers, contractors, painters, suppliers…: search `q` (name, phone fragment, GSTIN), `role`, `includeInactive`, `limit`/`offset` |
| GET    | `/parties/:id`             | `parties:read`   | One party with roles and customer details                                                                                           |
| POST   | `/parties`                 | `parties:manage` | Create; 409 with `existingPartyId` for a duplicate mobile or GSTIN                                                                  |
| PATCH  | `/parties/:id`             | `parties:manage` | Update; `null` clears a field; replacing roles adds/removes customer details                                                        |

**Access model:** `User → Role → Permissions`, plus store access (`all stores` or a list). Permission
keys and the standard roles live in `packages/shared/src/permissions.ts`. Routes declare
`@RequirePermissions(...)`; store-level checks happen in services with `can(auth, permission, storeId)`.

**No one can hand out more than they hold:** not permissions they lack, not stores they can't
access, not all-store access unless they have it, and not ownership unless they are an owner. Nobody
can change their own access, which also keeps at least one active owner. Rules live in
`apps/api/src/members/access-rules.ts`.

**Parties** (roadmap §3.5–3.7): one record per person or business with any number of roles.
GSTINs are checked with the GSTN check character; the PAN is filled from the GSTIN. Parties with a
home store are visible to that store's staff; parties without one (suppliers, architects) are
business-wide.

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

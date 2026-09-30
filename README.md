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

## Layout

```
apps/                 deployable apps (api, web) — coming next
packages/shared       code shared by all apps (money in paise, …)
packages/testing      test helpers (throwaway PostgreSQL for integration tests)
```

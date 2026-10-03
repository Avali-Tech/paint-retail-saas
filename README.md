# Paint Retail SaaS

Multi-store, multi-brand paint dealer platform for India. Product plans live in the
[roadmap repo](https://github.com/Avali-Tech/paint-retail-saas-roadmap).

## The first rule: every line of code is tested

- **Unit tests** (`src/**/*.test.ts`) cover logic in isolation: no network, no database.
- **Integration tests** (`src/**/*.int.test.ts`) run against a real PostgreSQL 17 in Docker
  (Testcontainers), with real S3-compatible storage (SeaweedFS) and real ClamAV for documents.
  No database mocks.
- Coverage across both suites must stay at **100%** for statements, branches, functions and
  lines. The run fails otherwise, locally and in CI.
- New code and its tests land in the same commit.

## Prerequisites

| Tool    | Version               | Notes                                                                                                                 |
| ------- | --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Node.js | 24 LTS (see `.nvmrc`) | `nvm use`                                                                                                             |
| pnpm    | via Corepack          | `corepack enable`                                                                                                     |
| Docker  | any recent engine     | On macOS we use [Colima](https://github.com/abiosoft/colima): `colima start`; give it 4 GB+ (ClamAV needs about 1 GB) |

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
| `pnpm test:docker`                             | Builds and runs the API and ops images      |

## Run the API locally

```sh
docker compose up -d                        # PostgreSQL (55432), S3 (58333), ClamAV (53310), Mailpit (58025)
cp apps/api/.env.example apps/api/.env
pnpm --filter @paint/api build
pnpm --filter @paint/api start              # http://localhost:3000
curl localhost:3000/health/ready            # {"status":"ok","checks":{"database":"up"}}
```

`GET /health` answers while the process runs (liveness). `GET /health/ready` also checks
PostgreSQL and answers 503 when it is unreachable (readiness).

## Run the web app locally

The web app (`apps/web`, React + Vite, installable as a PWA) calls the API at `/api/...` on its own
origin; Vite forwards that to the API, so the API needs no CORS. Production puts the same rule in the
CDN or load balancer (or set `VITE_API_BASE_URL` at build time).

```sh
pnpm --filter @paint/api start              # API on http://localhost:3000 (see above)
pnpm --filter @paint/web dev                # http://localhost:5173, /api proxied to :3000
API_URL=http://localhost:4000 pnpm --filter @paint/web dev   # a different API
pnpm --filter @paint/web build && pnpm --filter @paint/web preview   # production build + service worker
```

With `SMS_PROVIDER=log` in `apps/api/.env`, sign-in codes for **Mobile code** sign-in appear in the
API's console.

**Two-factor sign-in.** Owners and organization admins (when their business requires it, the
default) add an authenticator app at their next sign-in: a QR code plus the setup key, then ten
recovery codes to copy or download, shown once. Later sign-ins ask for a code from the app or a
recovery code. **Account security** (`/settings/security`, everyone) turns it on or off and renews
recovery codes; owners and admins set the business rule there, and owners reset a member's
two-factor sign-in (there is no team screen yet). The e2e tests act as the authenticator app with
`apps/web/e2e/totp.ts`.

**Theming (white-label).** Every colour, radius, spacing step, shadow and the font is a CSS custom
property derived at runtime from a business's branding (`appName`, `primary`, `accent`, `mode`,
`radius`, `density`, `font`) by `deriveTheme()` in `@paint/shared`, which also enforces WCAG AA
contrast. Components (`packages/ui`) and screens use only these tokens; `theme-guard.test.ts` fails
the build if a colour literal appears in their sources. Try it at **Settings → Appearance**
(`/settings/appearance`, owners and admins). Saving stores it for the whole business
(`PUT /organization/branding`) and shows the readability adjustments the server made; every
member's app loads it when they sign in, and keeps the last one on the device for a branded,
offline-ready first paint.

**Screens.** Customers (`/parties`: search, role filter, add and edit with the GSTIN checked as you
type and the duplicate warning), the customer 360 (`/parties/:id`: contact, credit, loyalty points
and history, activities, leads, opportunities, projects, contracts, documents), credit requests
(`/credit-requests`), credit rules (`/settings/credit`) and the loyalty programme
(`/settings/loyalty`). Actions show only to roles that may use them. Each screen is its own chunk
(`React.lazy`), loaded when first opened. Features keep their routes (`src/<feature>/routes.tsx`),
navigation entries (`src/<feature>/nav.ts`) and messages (`src/i18n/en-<feature>.ts`) in their own
files.

| Command                              | What it does                                                         |
| ------------------------------------ | -------------------------------------------------------------------- |
| `pnpm exec vitest run --project web` | Component tests for `apps/web` and `packages/ui` (jsdom, no network) |
| `pnpm test:e2e`                      | Builds API + web, then Playwright against a real API and PostgreSQL  |
| `pnpm --filter @paint/web test:e2e`  | Playwright only (after building both)                                |

End-to-end tests (`apps/web/e2e`) start a throwaway PostgreSQL with Testcontainers, the built API
(migrating on start, `SMS_PROVIDER=log` so the OTP test reads codes from its log) and `vite preview`,
then drive Chromium on desktop and phone (Pixel 5) viewports, including axe WCAG AA checks. First run:
`pnpm --filter @paint/web exec playwright install chromium`. They run in CI as their own job, not in
`pnpm verify`.

## API

Every route requires `Authorization: Bearer <token>` unless marked public.

| Method             | Path                                                                                             | Access                                                             | What it does                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET                | `/health`, `/health/ready`                                                                       | public                                                             | Liveness and readiness (checks PostgreSQL)                                                                                                                                                                                         |
| POST               | `/auth/signup`                                                                                   | public                                                             | New business + owner; returns a session token                                                                                                                                                                                      |
| POST               | `/auth/login`                                                                                    | public                                                             | Mobile/email + password. 409 lists businesses if the person belongs to several; resend with `organizationId`                                                                                                                       |
| POST               | `/auth/otp/request`                                                                              | public                                                             | Texts a 6-digit code (30 s between codes, 5 per hour)                                                                                                                                                                              |
| POST               | `/auth/otp/verify`                                                                               | public                                                             | Code (5 tries, 5 minutes) → session token. Someone in several businesses gets 409 with the list and sends the same code again with `organizationId` (each 409 counts as a try)                                                     |
| POST               | `/auth/2fa/setup`, `/auth/2fa/verify`                                                            | public, with the `pendingToken` from sign-in                       | Two-factor step: add an authenticator app (QR `otpauthUri`) when required, then a 6-digit code or a recovery code → session (plus 10 recovery codes when the app was just added). 5 tries, 5 minutes                               |
| GET · POST         | `/auth/2fa`, `/auth/2fa/enrol`, `/confirm`, `/recovery-codes`, `/disable`                        | signed in (not support sessions)                                   | Own two-factor status; add an app, confirm it, renew recovery codes or turn it off with a current code (not when the business requires it)                                                                                         |
| POST               | `/members/:id/two-factor/reset`                                                                  | owners (`organization:manage`)                                     | Removes a member's app and recovery codes and signs them out; audited                                                                                                                                                              |
| GET · PUT          | `/organization/security`                                                                         | `organization:manage`                                              | Whether owners and organization admins must use two-factor sign-in (default yes); audited                                                                                                                                          |
| GET                | `/auth/me`                                                                                       | signed in                                                          | User, business, role, permissions, store access                                                                                                                                                                                    |
| POST               | `/auth/logout`                                                                                   | signed in                                                          | Ends this device's session                                                                                                                                                                                                         |
| GET                | `/stores`                                                                                        | `stores:read`                                                      | Stores the member can access                                                                                                                                                                                                       |
| GET                | `/stores/:id`                                                                                    | `stores:read`                                                      | One store (404 if not accessible)                                                                                                                                                                                                  |
| POST               | `/stores`                                                                                        | `stores:manage`                                                    | Create a store or godown                                                                                                                                                                                                           |
| GET                | `/roles`                                                                                         | `members:read`                                                     | Roles with their permissions                                                                                                                                                                                                       |
| GET                | `/members`, `/members/:id`                                                                       | `members:read`                                                     | Team members the caller can see (people in their stores)                                                                                                                                                                           |
| POST               | `/members`                                                                                       | `members:manage`                                                   | Add a person (links an existing account) with a role and stores                                                                                                                                                                    |
| PATCH              | `/members/:id`                                                                                   | `members:manage`                                                   | Change role, stores or active status (deactivating signs them out)                                                                                                                                                                 |
| GET                | `/parties`                                                                                       | `parties:read`                                                     | Customers, contractors, painters, suppliers…: search `q` (name, phone fragment, GSTIN), `role`, `includeInactive`, `limit`/`offset`                                                                                                |
| GET                | `/parties/:id`                                                                                   | `parties:read`                                                     | One party with roles and customer details                                                                                                                                                                                          |
| POST               | `/parties`                                                                                       | `parties:manage`                                                   | Create; 409 with `existingPartyId` for a duplicate mobile or GSTIN                                                                                                                                                                 |
| PATCH              | `/parties/:id`                                                                                   | `parties:manage`                                                   | Update; `null` clears a field; replacing roles adds/removes customer details                                                                                                                                                       |
| GET/POST/PATCH     | `/brands`, `/brands/:id`                                                                         | read: `catalog:read`, write: `catalog:manage`                      | Brands (unique ignoring case)                                                                                                                                                                                                      |
| GET/POST/PATCH     | `/categories`, `/categories/:id`                                                                 | same                                                               | Categories with one level of subcategories                                                                                                                                                                                         |
| GET                | `/products`                                                                                      | `catalog:read`                                                     | Product families with variants: search `q` (name, brand, SKU, barcode), `brandId`, `categoryId` (includes subcategories), `type`, paging                                                                                           |
| GET                | `/products/lookup?code=`                                                                         | `catalog:read`                                                     | Variant by scanned barcode or typed SKU (counter)                                                                                                                                                                                  |
| GET/POST/PATCH     | `/products`, `/products/:id`                                                                     | same                                                               | Product family: brand, category, type, HSN, GST rate, variants                                                                                                                                                                     |
| POST               | `/products/:id/variants`                                                                         | `catalog:manage`                                                   | Add a pack size                                                                                                                                                                                                                    |
| PATCH              | `/variants/:id`                                                                                  | `catalog:manage`                                                   | SKU, MRP, selling price (never above MRP), barcodes, status                                                                                                                                                                        |
| POST               | `/stock/movements`                                                                               | `inventory:manage`                                                 | Opening stock (once per store and product), adjustments and write-offs (with a reason), several products at once, all or nothing                                                                                                   |
| GET                | `/stock`                                                                                         | `inventory:read`                                                   | Stock by store: on hand, reserved, available, average cost, value; filters and paging                                                                                                                                              |
| GET                | `/stock/availability?variantId=`                                                                 | `inventory:read`                                                   | One product across the member's stores                                                                                                                                                                                             |
| GET                | `/stock/ledger`                                                                                  | `inventory:read`                                                   | Movement history, newest first, with who made each change                                                                                                                                                                          |
| POST               | `/transfers`                                                                                     | `inventory:manage` (receiving store)                               | Request stock from another store; numbered TR-000001… without gaps                                                                                                                                                                 |
| GET                | `/transfers`, `/transfers/:id`                                                                   | `inventory:read`                                                   | Transfers touching the member's stores; filter by `status`, `direction` (incoming/outgoing), `storeId`                                                                                                                             |
| POST               | `/transfers/:id/approve` · `/reject`                                                             | `inventory:manage` (sending store)                                 | Approve (optionally less) or reject with a reason                                                                                                                                                                                  |
| POST               | `/transfers/:id/dispatch`                                                                        | `inventory:manage` (sending store)                                 | Stock leaves the sender at its average cost                                                                                                                                                                                        |
| POST               | `/transfers/:id/receive`                                                                         | `inventory:manage` (receiving store)                               | Record good, damaged (written off) and short quantities                                                                                                                                                                            |
| POST               | `/transfers/:id/cancel`                                                                          | `inventory:manage` (receiving store)                               | Withdraw before dispatch                                                                                                                                                                                                           |
| GET                | `/transfers/:id/challan`                                                                         | `inventory:read`                                                   | Delivery challan data; flags when different GSTINs need a tax invoice                                                                                                                                                              |
| POST               | `/stock-counts`                                                                                  | `inventory:manage`                                                 | Start a count (whole store, a brand, or a category with subcategories); records the books                                                                                                                                          |
| POST               | `/stock-counts/:id/counts`                                                                       | `inventory:manage`                                                 | Batches of counts by barcode, SKU or id; a scan adds 1, `set` replaces; unlisted products are added                                                                                                                                |
| POST               | `/stock-counts/:id/submit` · `/reopen` · `/approve` · `/cancel`                                  | `inventory:manage`                                                 | Submit (optionally uncounted as zero), recount, approve with variance reasons (corrections posted), cancel                                                                                                                         |
| GET                | `/stock-counts`, `/stock-counts/:id`                                                             | `inventory:read`                                                   | Counts with variances in quantity and value, and accuracy %                                                                                                                                                                        |
| GET                | `/stock-counts/accuracy`                                                                         | `inventory:read`                                                   | Each store's accuracy at its last approved count                                                                                                                                                                                   |
| PUT                | `/reorder-rules`                                                                                 | `inventory:manage`                                                 | Set min / reorder level / max per store and product, many at once                                                                                                                                                                  |
| GET · DELETE       | `/reorder-rules`, `/reorder-rules/:storeId/:variantId`                                           | read / manage                                                      | List (search, paging) and remove rules                                                                                                                                                                                             |
| GET                | `/stock/low`                                                                                     | `inventory:read`                                                   | At or below reorder level: out of stock, below minimum, reorder; suggested quantity up to max                                                                                                                                      |
| GET                | `/stock/slow-movers?days=90`                                                                     | `inventory:read`                                                   | In stock with no sale or transfer out for N days, by money tied up                                                                                                                                                                 |
| GET                | `/suppliers`, `/suppliers/:id`                                                                   | `purchasing:read`                                                  | Parties with the supplier role: terms, lead time, products with their last cost                                                                                                                                                    |
| PUT                | `/suppliers/:id/profile`                                                                         | `purchasing:manage`                                                | Payment terms (days of credit) and lead time                                                                                                                                                                                       |
| PUT · DELETE       | `/suppliers/:id/products`, `/suppliers/:id/products/:variantId`                                  | `purchasing:manage`                                                | Products the supplier provides, with the supplier's own code                                                                                                                                                                       |
| POST               | `/purchase-orders`                                                                               | `purchasing:manage`                                                | Order for one store; numbered PO-000001…; cost defaults to the supplier's last cost                                                                                                                                                |
| POST               | `/purchase-orders/from-low-stock`                                                                | `purchasing:manage`                                                | Quick reorder: every low product the supplier provides (or chosen ones), up to max                                                                                                                                                 |
| GET                | `/purchase-orders`, `/purchase-orders/:id`                                                       | `purchasing:read`                                                  | Orders at the member's stores; filter by `status`, `storeId`, `supplierId`                                                                                                                                                         |
| POST               | `/purchase-orders/:id/cancel` · `/close`                                                         | `purchasing:manage`                                                | Cancel before anything arrives, or short-close a partly received order                                                                                                                                                             |
| POST               | `/goods-receipts`                                                                                | `purchasing:manage`                                                | GRN against an order or a supplier invoice; free scheme units at zero cost                                                                                                                                                         |
| GET                | `/goods-receipts`, `/goods-receipts/:id`                                                         | `purchasing:read`                                                  | Receipts at the member's stores; filter by `storeId`, `supplierId`, `purchaseOrderId`                                                                                                                                              |
| GET                | `/imports`, `/imports/:kind/template`                                                            | signed in (template: the kind's permission)                        | Import kinds with their columns; a CSV template to fill in (products, parties, opening-stock)                                                                                                                                      |
| POST               | `/imports/:kind/preview`                                                                         | `catalog:manage` · `parties:manage` · `inventory:manage`           | Checks a CSV and reports, row by row, what would be created, updated or left unchanged, with errors                                                                                                                                |
| POST               | `/imports/:kind`                                                                                 | as above                                                           | Saves every row in one transaction, or nothing if any row has an error; safe to run again                                                                                                                                          |
| GET                | `/onboarding`                                                                                    | signed in                                                          | Setup checklist for a new business: stores, team, products, suppliers, customers, stock, reorder levels                                                                                                                            |
| POST               | `/documents` (multipart: `recordType`, `recordId`, `category`, `file`)                           | the record's manage permission                                     | Attach a file (≤ 10 MB; PDF, JPG, PNG, WebP, HEIC, DOCX, XLSX) after a virus scan                                                                                                                                                  |
| GET                | `/documents?recordType=&recordId=`, `/documents/:id/download`                                    | the record's read permission                                       | A record's documents; downloads always as an attachment                                                                                                                                                                            |
| DELETE             | `/documents/:id`                                                                                 | the record's manage permission                                     | Hide a document (the file is kept for the audit trail)                                                                                                                                                                             |
| GET                | `/notifications?unread=true`                                                                     | signed in (own only)                                               | Notification centre, newest first, with the unread count for the badge                                                                                                                                                             |
| POST               | `/notifications/:id/read` · `/notifications/read-all`                                            | signed in (own only)                                               | Mark one or all as read                                                                                                                                                                                                            |
| GET · PUT          | `/notifications/preferences`                                                                     | signed in (own only)                                               | Turn in-app and email on or off per event                                                                                                                                                                                          |
| POST               | `/leads`                                                                                         | `leads:manage`                                                     | Capture a lead (LD-000001…) for a party, or from a name and mobile number (matched, else added as a customer)                                                                                                                      |
| GET                | `/leads`, `/leads/:id`, `/leads/pipeline`                                                        | `leads:read`                                                       | Filter by `stage`, `source`, `assignedTo` (id or `me`), `q`; per-stage counts and values for a kanban board                                                                                                                        |
| PATCH · POST       | `/leads/:id`, `/:id/assign`, `/:id/stage`, `/:id/lose`, `/:id/win`, `/:id/reopen`                | `leads:manage`                                                     | Edit, reassign, move between new / contacted / qualified, lose with a reason, win directly, reopen                                                                                                                                 |
| POST               | `/leads/:id/convert`                                                                             | `leads:manage`                                                     | Turn a qualified lead into an opportunity (OP-000001…)                                                                                                                                                                             |
| POST · GET         | `/opportunities`, `/opportunities/:id`, `/opportunities/pipeline`                                | `leads:manage` · `leads:read`                                      | Opportunities with value, quantity, order date, category, salesperson, probability; weighted pipeline                                                                                                                              |
| PATCH · POST       | `/opportunities/:id`, `/:id/assign`, `/:id/stage`, `/:id/win`, `/:id/lose`                       | `leads:manage`                                                     | Discovery → proposal → negotiation → won / lost; winning or losing closes its lead too                                                                                                                                             |
| POST               | `/projects`, `/opportunities/:id/project`                                                        | `projects:manage`                                                  | A project (PJ-000001…) with customer, site and map pin, dates, area, paint litres, value; or started from an opportunity                                                                                                           |
| GET                | `/projects`, `/projects/:id`, `/projects/pipeline`                                               | `projects:read`                                                    | Filter by `stage`, `partyId` (customer or anyone linked), `assignedTo`, `q`; per-stage totals                                                                                                                                      |
| PATCH · PUT · POST | `/projects/:id`, `/:id/parties`, `/:id/assign`, `/:id/stage`, `/:id/cancel`                      | `projects:manage`                                                  | Edit, set architects / contractors / painters / dealers, reassign, move stages, cancel with a reason                                                                                                                               |
| POST               | `/contracts`                                                                                     | `contracts:manage`                                                 | A contract (CT-000001…) with a party, optional store and project, start/end and renewal date (default 30 days before the end), value, terms, credit and discount terms; starts as a draft                                          |
| GET                | `/contracts`, `/contracts/:id`                                                                   | `contracts:read`                                                   | Filter by `status` (incl. `expired`), `type`, `partyId`, `storeId`, `projectId`, `assignedTo`, `q`; `renewalDue=30` lists active contracts ending within 30 days (or already ended), soonest first                                 |
| PATCH · POST       | `/contracts/:id`, `/:id/activate`, `/:id/terminate`, `/:id/renew`                                | `contracts:manage`                                                 | Edit, put in force, terminate with a reason, renew (creates the follow-on contract, 201)                                                                                                                                           |
| GET                | `/parties/:id/credit`, `/parties/:id/credit/check?amountPaise=`, `/credit-profiles`              | `credit:read`                                                      | A party's limit, days, status, risk, hold and current check; whether a sale may go ahead (allowed / manager approval / owner approval / blocked); parties with credit, closest to their limit first                                |
| PATCH · POST       | `/parties/:id/credit`, `/parties/:id/credit/hold`                                                | `credit:manage`                                                    | Risk, notes and (until billing) what the party owes and how many days overdue; put the account on hold with a reason                                                                                                               |
| POST · GET         | `/credit-requests`, `/credit-requests/:id`                                                       | `credit:manage` to ask, `credit:read` to see                       | Ask for credit or a new limit / days (CR-000001…); approvers are notified                                                                                                                                                          |
| POST · PUT         | `/credit-requests/:id/approve`, `/:id/reject`, `/parties/:id/credit/release`, `/credit-rules`    | `credit:approve` (owners, admins)                                  | Decide requests (the requester is notified), release a hold, set the credit rules (`GET /credit-rules` with `credit:read`)                                                                                                         |
| GET                | `/parties/:id/loyalty?limit=&offset=`, `/loyalty-accounts`, `/loyalty-settings`                  | `loyalty:read`                                                     | A party's points (balance, earned, redeemed, tier, next tier, next expiry) and ledger, newest first; enrolled parties, most points first; the programme                                                                            |
| POST · PATCH       | `/parties/:id/loyalty`, `/:id/loyalty/purchases`, `/awards`, `/redemptions`, `/adjustments`      | `loyalty:manage`                                                   | Enrol (with a salesperson), close or reassign; points for a purchase entered by hand; a manual or campaign award; redeem; adjust with a reason                                                                                     |
| PUT                | `/loyalty-settings`                                                                              | `loyalty:manage` and all-store access                              | Earn rate, tiers, expiry days, minimum redemption                                                                                                                                                                                  |
| POST               | `/activities`                                                                                    | the record's manage permission                                     | Log a call, meeting, visit, WhatsApp, email or note on a party, lead, opportunity or project; with `dueAt` it is scheduled                                                                                                         |
| GET                | `/activities?recordType=&recordId=`                                                              | the record's read permission                                       | The record's timeline, latest first                                                                                                                                                                                                |
| GET                | `/activities/follow-ups?when=today`                                                              | signed in                                                          | My (or `assignedTo`) open follow-ups: `overdue`, `today`, `upcoming` or `open`, in India time, with badge counts                                                                                                                   |
| PATCH · POST       | `/activities/:id`, `/:id/complete`, `/:id/cancel`                                                | the record's manage permission                                     | Reschedule or reassign; complete with an outcome and optionally schedule the next step; cancel                                                                                                                                     |
| GET                | `/parties/:id/overview`                                                                          | `parties:read`                                                     | Customer 360: the party with its leads, opportunities (open and won value), projects (with its roles there), activities, next follow-up and documents                                                                              |
| POST               | `/parties/:id/merge`                                                                             | `parties:manage` and all-store access                              | Merges this duplicate into `intoPartyId`: every reference moves, the duplicate is deactivated with `mergedIntoId`; answers the survivor and what moved                                                                             |
| GET                | `/audit-log`                                                                                     | `audit:read` (owners, admins)                                      | Who changed what and when: filter by `table`, `recordId`, `actorMemberId`, `from`, `to`; old and new values ready to read                                                                                                          |
| GET                | `/search?q=`                                                                                     | signed in (each group checks its own permission)                   | One search box: customers by name / mobile / GSTIN, products by name / brand / SKU / barcode, leads, opportunities, projects, and documents by number                                                                              |
| GET                | `/search/actions?q=`                                                                             | signed in                                                          | Quick actions the member may use (+ Customer, + Transfer, Receive goods…), with two-key shortcuts such as `N C`                                                                                                                    |
| GET                | `/dashboard?storeId=`                                                                            | `stores:read` (each section its own permission)                    | Every store's position: stock value, units and SKUs; low stock; transfers awaiting approval, to dispatch, incoming; open POs and value still due; totals; leads, opportunities and projects by stage; follow-ups overdue and today |
| GET                | `/reports`, `/reports/:kind?format=csv`                                                          | the report's permission                                            | Stock by location, stock ledger, transfers, goods receipts, leads, projects; filters, JSON paging or CSV for Excel                                                                                                                 |
| GET                | `/organization/features`                                                                         | signed in                                                          | The business's plan, its limits, usage, and which features are on                                                                                                                                                                  |
| GET · PUT          | `/organization/branding`                                                                         | signed in to read; `organization:manage` to change                 | The business's look (app name, colours, mode, corners, density, font), checked with `validateBranding`; 404 until set. Saving answers the theme's readability adjustments                                                          |
| GET · POST         | `/support-requests`, `/:id/approve`, `/:id/decline`, `/:id/end`, `/:id/activity`                 | `organization:manage`                                              | Decide on platform support's requests for access, end access, and see every request support made                                                                                                                                   |
| POST               | `/platform/bootstrap`, `/platform/login`, `/platform/logout`                                     | platform operators                                                 | The SaaS operator's own sign-in; the first operator is created once with `PLATFORM_BOOTSTRAP_TOKEN`                                                                                                                                |
| POST               | `/platform/login/2fa/setup`, `/platform/login/2fa`                                               | platform operators, with the `pendingToken` from `/platform/login` | Operators always use an authenticator app: add it at first sign-in, then a code each time                                                                                                                                          |
| GET · POST · PATCH | `/platform/tenants`, `/:id`, `/:id/suspend`, `/:id/reactivate`                                   | platform operators                                                 | Businesses with usage; onboard one and its owner; change plan and feature flags; suspend or reactivate                                                                                                                             |
| POST · GET         | `/platform/tenants/:id/support-requests`, `/platform/support-grants`, `/:id/session`, `/:id/end` | platform operators                                                 | Ask for time-limited access, sign in read-only once approved, end it                                                                                                                                                               |

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

**Catalogue** (roadmap §3.11): one product family (e.g. Apex Ultima) with a variant per pack
size, each with its own SKU, MRP and selling price in paise, and barcodes. EAN/UPC barcodes are
check-digit validated. The catalogue is shared by all stores; stock per store comes next.

**Stock** (roadmap §3.13–3.16): every movement is a permanent, append-only ledger entry (a
database trigger refuses edits and deletes; corrections are new entries). Balances per store and
product change only through `postStockMovements()` in `@paint/db`, in the same transaction, with
exact decimal arithmetic and a weighted-average cost. Stock never goes negative.
`findStockMismatches()` compares balances with the ledger and should be run nightly.

**Transfers** (roadmap §3.15): requested → approved → in transit → received (or rejected /
cancelled). Each step moves the status only from the expected one, so double clicks and races
cannot apply a step twice. Dispatch and receipt post through `postStockMovements()`; damaged
units are written off at the destination and shortages stay on the transfer.

**Stock counts** (roadmap P1-M13): corrections are `counted − books at the start`, posted on
approval as `count_correction` ledger entries, so movements during the count are kept. The
person who submitted a count cannot approve it unless they have all-store access.

**Purchasing** (roadmap P1-M15, P1-M16): suppliers are parties with the supplier role. A purchase
order is open → partially received → received (or cancelled before anything arrives, or closed
short). Goods receipts (GRN-000001…) post `purchase_receipt` entries; scheme free units are a
separate entry at zero cost, so they lower the average cost. Receipts lock their order, so two
entered at once cannot over-receive, and a supplier's invoice number can be entered only once.
Each receipt records the supplier's latest cost for the next order.

**Imports** (roadmap P1-M17): CSV as Excel or Google Sheets saves it, up to 5,000 rows. A preview
saves nothing and lists every problem by row and column; committing saves all rows or none. Running
the same file again updates instead of duplicating: products match by SKU, parties by GSTIN or
mobile number, opening stock by store and SKU. Blank cells keep saved values. Opening stock is
refused once a product has other movements at that store; use a stock count instead.

**Documents** (roadmap P1-M18): files attach to parties, products, stores, purchase orders, goods
receipts, transfers, stock counts, leads, opportunities, projects and contracts. Whoever can see the record sees its documents; whoever can
change it can add or remove them, and store access applies (a Pune order's documents are invisible to
Hyderabad staff). Every file is scanned by ClamAV before it is stored — including inside Word and
Excel archives — and refused if infected or if scanning is down. The type comes from the file's bytes,
not its name; names are cleaned of paths and direction tricks; downloads are always attachments with
`nosniff`, so an uploaded page can never run in our site. Bytes live in S3 (Mumbai) under
`<organization>/documents/<id>`.

**Notifications** (roadmap P1-M19): a transfer request goes to the sending store's stock managers,
a dispatch to the receiving store's, a submitted stock count to whoever else can approve it, and a
product falling to its reorder level to that store's stock managers — once per dip, grouped by
store. Never to the person who acted. Notifications are written in the same transaction as the
event; emails go to an outbox and the background worker (every `WORKER_INTERVAL_SECONDS`) sends
them over SMTP (Amazon SES in production, Mailpit locally at http://localhost:58025), retrying 4
times with growing gaps. Several servers can run the worker safely. Follow-ups remind their assignee
(see Activities below).

**Leads & opportunities** (roadmap P1-M07): a lead moves new → contacted → qualified, then converts
into an opportunity (discovery → proposal → negotiation → won / lost), or is won directly or lost
with a reason. Every change locks the record first, so two people acting at once cannot both
apply. Leads and opportunities belong to a store; staff see their stores' only.

**Projects & sites** (roadmap P1-M08): identified → survey → specification → quotation →
negotiation → order → execution → completed (or cancelled with a reason). A project links its
customer, any number of architects, contractors, painters and dealers, and the opportunity it came
from. Site photos are documents on the project (categories `before_photo`, `after_photo`, with a
note); documents also attach to leads and opportunities. No shade or tinting data until Phase 2.

**Contracts** (roadmap P1-M24): contractor, supplier, customer and dealer agreements as a record
with terms, dates, documents and status, not a legal engine. Draft → active → terminated (with a
reason) or renewed; an active contract past its end date (India time) shows as `expired` until it is
renewed or terminated. Renewing creates a new contract (new number, active, linked both ways via
`renewalOf` / `renewedBy`), by default starting the day after the old one ends and copying its
terms. The signed agreement is a document on the contract (record type `contract`). Contracts with
a store are visible to that store's staff; those without are business-wide. On the renewal date
the assignee is reminded once, in the app and by email (`contract_renewal_due`); moving the date
reminds again. Status, dates and value changes are in the audit log; the customer 360 and search
include contracts.

**Credit** (roadmap P1-M25, spec §3.21–3.22): each party has at most one credit profile: status
(none, active or on hold, with a reason), limit in paise, credit days and risk. Limits and days
change only through a credit request that someone with `credit:approve` (owners and admins) approves
or rejects; approvers at the party's store (or anywhere, for business-wide parties) are notified
(`credit_request_awaiting_approval`) and the requester hears the decision (`credit_request_decided`).
One request may wait per party. Approving a new limit for an account on hold keeps it on hold; staff
with `credit:manage` hold an account, approvers release it. The rule engine (`checkCredit` in
`@paint/shared`) blocks credit without a limit, on hold, or overdue beyond the configured days, and
otherwise decides by utilisation: up to 80 % normal, up to 100 % manager approval, above that owner
approval (configurable per business with `PUT /credit-rules`). Until billing (Release 2.0) calculates
exposure from invoices, what a party owes and how late it is are entered by hand
(`manualExposurePaise`, `overdueDays`). Changes to limits, days, status, holds and the rules are in the
audit log; the customer 360 shows the credit position.

**Loyalty** (roadmap P1-M26, spec §3.23): a party (typically a painter or contractor) gets a
loyalty account, optionally looked after by a salesperson. Points live only in an append-only ledger
(a trigger refuses edits and deletes; corrections are adjustments with a reason), so the balance is
always the sum of the entries and is never stored. Entries are purchases (points at the programme's
earn rate, default 1 point per ₹100, on an amount entered by hand until billing exists:
`manualPurchasePaise`), manual and campaign awards, redemptions, adjustments and expiries.
Redemptions and negative adjustments lock the account and can never take the balance below zero, and
redemptions respect the minimum. With `expiryDays` set, each entry that adds points expires that many
days later; points are used soonest-expiring first, and the background worker writes off unused expired
points once a day (expired points are also written off before any redemption, so they cannot be spent).
Tiers go by lifetime points earned; reaching a new one tells the account's salesperson
(`loyalty_tier_reached`). Programme changes, account status and every adjustment are in the audit log;
the customer 360 shows the points.

**Activities & follow-ups** (roadmap P1-M09): every call, visit and note is an activity on a party
(customer, contractor, dealer, supplier…), lead, opportunity or project, and access follows that
record. A follow-up's assignee is reminded once, in the app and by email, when it is within 15
minutes of due (`follow_up_due`); rescheduling reminds again.

**Customer 360** (roadmap P1-M06): `GET /parties/:id/overview` gathers everything linked to a party,
counting all and listing the latest ten of each. Sections the member has no permission for come back
as `null`, and leads, opportunities and projects are limited to the member's stores.

**Audit log** (roadmap P1-M20): database triggers record every change to prices, roles and their
permissions, members' roles, store access and active status, and stock adjustments, write-offs and
count corrections, with the watched columns' old and new values. No code path can skip it, and the
application can only read the log: it cannot add, edit or delete entries, and even the database owner
cannot change or empty it. Each request runs as its member (`runAsMember`), so entries name who acted;
background and setup work appears as system. Contracts and credit are audited too (see their sections).

**Search** (roadmap P1-M21): every word must match somewhere, exact matches (a SKU, barcode,
mobile number or document number) come first, and `%` and `_` are ordinary characters. Each group
appears only with its read permission and keeps to the member's stores. Trigram indexes (`pg_trgm`)
keep "contains" searches fast: about 40 ms through the API with 10,000 customers and products.

**Dashboard & reports** (roadmap P1-M22): the dashboard puts one row per store the member works at
on one screen, with totals; sections without permission come back as `null`. Reports filter by
store and India-time days (`from`, `to`), plus status, stage, source, movement type or supplier
where they apply. Money is shown in rupees, times in India time; CSV downloads include a BOM so
Excel shows ₹ correctly.

**Two-factor sign-in** (TOTP, RFC 6238, implemented in `apps/api/src/auth/totp.ts` and checked
against the RFC test vectors): after the password or SMS code, people with an authenticator app, and
owners and organization admins of businesses that require it (the default; `PUT /organization/security`),
get a `twoFactor` challenge instead of a session: a `pendingToken` valid for 5 minutes and 5 tries.
Those without an app add one first (`setupRequired`); the first code confirms it and returns 10
one-time recovery codes, shown once and stored only as keyed hashes. Secrets are encrypted with
AES-256-GCM (key derived from `AUTH_SECRET`), each code works once, and one step of clock drift is
allowed. An owner can reset a member's two-factor sign-in (audited); support sessions are exempt and
cannot change it. Platform operators always sign in with an app. A new business's owner is signed in
at sign-up and adds the app at their next sign-in.

**Party merge:** `POST /parties/:id/merge` moves everything that pointed at a duplicate (leads, opportunities, projects
and project roles, contracts, purchase orders, goods receipts, supplier prices, activities, documents,
credit and loyalty) to the surviving party in one transaction, then deactivates the duplicate with
`mergedIntoId` so old links lead to the survivor. Roles are combined; one-per-party records (customer and
supplier profiles) keep the survivor's. Credit: refused when both have a request waiting, or both have a
profile and the duplicate's gives credit; otherwise the duplicate's profile moves if the survivor has none.
Loyalty: the duplicate's account moves if the survivor has none; otherwise its unused points move as
adjustments keeping their expiry dates and its account is closed. Only members with all-store access
merge; merges are audited. A guard test fails when a new table references parties without being handled.

**Branding** (white-label): each business can set its app name, primary and accent colours, light /
dark / system mode, corner radius, density and font. The API validates and normalises it with
`validateBranding` from `@paint/shared`, the same rules the web app uses, and answers which colours
`deriveTheme` had to adjust to stay readable. Changes are in the audit log.

**Shared response types:** the shapes the web app reads (`SessionGrant`, `AuthProfile`, `Dashboard`,
`SearchResults`, `NotificationPage`, `BrandingView`, …) live in `packages/shared/src/api.ts`; the API
returns them and the web app imports them, so the two cannot drift apart.

**Platform console** (roadmap P1-M23): operators sign in separately (their tokens and businesses'
tokens never work for each other). Businesses are on a plan (trial: 5 stores and 25 team members,
standard: 10 and 50, enterprise: unlimited; self sign-ups start on `SIGNUP_PLAN`) with per-business
feature flags. Suspending a business signs it out and blocks sign-in. Businesses may only rename
themselves: plan, flags and suspension are set by the platform, and every change is in the business's
audit log. Support access must be approved by the business's owners or admins, lasts 15 minutes to 8
hours, is read-only, can be ended by either side, and every request made with it is recorded for the
business to review.

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
apps/web              Web app (React + Vite PWA): sign-in (with two-factor), shell, dashboard, customers, credit, loyalty, appearance, account security
packages/ui           Design system: theme runtime and accessible components on design tokens
packages/db           PostgreSQL schema, migrations, tenant isolation (Drizzle)
packages/shared       code shared by all apps (money in paise, branding and theme derivation, …)
packages/testing      test helpers (throwaway PostgreSQL for integration tests)
packages/observability  error-report scrubbing shared by the API and web Sentry setup
packages/ops          one-off operations: migrations on deploy, the backup restore drill
infra/terraform       AWS (ap-south-1): staging and production, never applied from CI
docs                  architecture, environment variables, runbooks (deploy, restore, secrets, incidents)
```

Production: [docs/architecture.md](docs/architecture.md) and [docs/runbooks](docs/runbooks).

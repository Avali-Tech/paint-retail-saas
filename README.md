# Paint Retail SaaS

Multi-store, multi-brand paint dealer platform for India. Product plans live in the
[roadmap repo](https://github.com/kamaljeet121/paint-retail-saas-roadmap).

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

## API

Every route requires `Authorization: Bearer <token>` unless marked public.

| Method         | Path                                                                              | Access                                                   | What it does                                                                                                                             |
| -------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| GET            | `/health`, `/health/ready`                                                        | public                                                   | Liveness and readiness (checks PostgreSQL)                                                                                               |
| POST           | `/auth/signup`                                                                    | public                                                   | New business + owner; returns a session token                                                                                            |
| POST           | `/auth/login`                                                                     | public                                                   | Mobile/email + password. 409 lists businesses if the person belongs to several; resend with `organizationId`                             |
| POST           | `/auth/otp/request`                                                               | public                                                   | Texts a 6-digit code (30 s between codes, 5 per hour)                                                                                    |
| POST           | `/auth/otp/verify`                                                                | public                                                   | Code (5 tries, 5 minutes) → session token                                                                                                |
| GET            | `/auth/me`                                                                        | signed in                                                | User, business, role, permissions, store access                                                                                          |
| POST           | `/auth/logout`                                                                    | signed in                                                | Ends this device's session                                                                                                               |
| GET            | `/stores`                                                                         | `stores:read`                                            | Stores the member can access                                                                                                             |
| GET            | `/stores/:id`                                                                     | `stores:read`                                            | One store (404 if not accessible)                                                                                                        |
| POST           | `/stores`                                                                         | `stores:manage`                                          | Create a store or godown                                                                                                                 |
| GET            | `/roles`                                                                          | `members:read`                                           | Roles with their permissions                                                                                                             |
| GET            | `/members`, `/members/:id`                                                        | `members:read`                                           | Team members the caller can see (people in their stores)                                                                                 |
| POST           | `/members`                                                                        | `members:manage`                                         | Add a person (links an existing account) with a role and stores                                                                          |
| PATCH          | `/members/:id`                                                                    | `members:manage`                                         | Change role, stores or active status (deactivating signs them out)                                                                       |
| GET            | `/parties`                                                                        | `parties:read`                                           | Customers, contractors, painters, suppliers…: search `q` (name, phone fragment, GSTIN), `role`, `includeInactive`, `limit`/`offset`      |
| GET            | `/parties/:id`                                                                    | `parties:read`                                           | One party with roles and customer details                                                                                                |
| POST           | `/parties`                                                                        | `parties:manage`                                         | Create; 409 with `existingPartyId` for a duplicate mobile or GSTIN                                                                       |
| PATCH          | `/parties/:id`                                                                    | `parties:manage`                                         | Update; `null` clears a field; replacing roles adds/removes customer details                                                             |
| GET/POST/PATCH | `/brands`, `/brands/:id`                                                          | read: `catalog:read`, write: `catalog:manage`            | Brands (unique ignoring case)                                                                                                            |
| GET/POST/PATCH | `/categories`, `/categories/:id`                                                  | same                                                     | Categories with one level of subcategories                                                                                               |
| GET            | `/products`                                                                       | `catalog:read`                                           | Product families with variants: search `q` (name, brand, SKU, barcode), `brandId`, `categoryId` (includes subcategories), `type`, paging |
| GET            | `/products/lookup?code=`                                                          | `catalog:read`                                           | Variant by scanned barcode or typed SKU (counter)                                                                                        |
| GET/POST/PATCH | `/products`, `/products/:id`                                                      | same                                                     | Product family: brand, category, type, HSN, GST rate, variants                                                                           |
| POST           | `/products/:id/variants`                                                          | `catalog:manage`                                         | Add a pack size                                                                                                                          |
| PATCH          | `/variants/:id`                                                                   | `catalog:manage`                                         | SKU, MRP, selling price (never above MRP), barcodes, status                                                                              |
| POST           | `/stock/movements`                                                                | `inventory:manage`                                       | Opening stock (once per store and product), adjustments and write-offs (with a reason), several products at once, all or nothing         |
| GET            | `/stock`                                                                          | `inventory:read`                                         | Stock by store: on hand, reserved, available, average cost, value; filters and paging                                                    |
| GET            | `/stock/availability?variantId=`                                                  | `inventory:read`                                         | One product across the member's stores                                                                                                   |
| GET            | `/stock/ledger`                                                                   | `inventory:read`                                         | Movement history, newest first, with who made each change                                                                                |
| POST           | `/transfers`                                                                      | `inventory:manage` (receiving store)                     | Request stock from another store; numbered TR-000001… without gaps                                                                       |
| GET            | `/transfers`, `/transfers/:id`                                                    | `inventory:read`                                         | Transfers touching the member's stores; filter by `status`, `direction` (incoming/outgoing), `storeId`                                   |
| POST           | `/transfers/:id/approve` · `/reject`                                              | `inventory:manage` (sending store)                       | Approve (optionally less) or reject with a reason                                                                                        |
| POST           | `/transfers/:id/dispatch`                                                         | `inventory:manage` (sending store)                       | Stock leaves the sender at its average cost                                                                                              |
| POST           | `/transfers/:id/receive`                                                          | `inventory:manage` (receiving store)                     | Record good, damaged (written off) and short quantities                                                                                  |
| POST           | `/transfers/:id/cancel`                                                           | `inventory:manage` (receiving store)                     | Withdraw before dispatch                                                                                                                 |
| GET            | `/transfers/:id/challan`                                                          | `inventory:read`                                         | Delivery challan data; flags when different GSTINs need a tax invoice                                                                    |
| POST           | `/stock-counts`                                                                   | `inventory:manage`                                       | Start a count (whole store, a brand, or a category with subcategories); records the books                                                |
| POST           | `/stock-counts/:id/counts`                                                        | `inventory:manage`                                       | Batches of counts by barcode, SKU or id; a scan adds 1, `set` replaces; unlisted products are added                                      |
| POST           | `/stock-counts/:id/submit` · `/reopen` · `/approve` · `/cancel`                   | `inventory:manage`                                       | Submit (optionally uncounted as zero), recount, approve with variance reasons (corrections posted), cancel                               |
| GET            | `/stock-counts`, `/stock-counts/:id`                                              | `inventory:read`                                         | Counts with variances in quantity and value, and accuracy %                                                                              |
| GET            | `/stock-counts/accuracy`                                                          | `inventory:read`                                         | Each store's accuracy at its last approved count                                                                                         |
| PUT            | `/reorder-rules`                                                                  | `inventory:manage`                                       | Set min / reorder level / max per store and product, many at once                                                                        |
| GET · DELETE   | `/reorder-rules`, `/reorder-rules/:storeId/:variantId`                            | read / manage                                            | List (search, paging) and remove rules                                                                                                   |
| GET            | `/stock/low`                                                                      | `inventory:read`                                         | At or below reorder level: out of stock, below minimum, reorder; suggested quantity up to max                                            |
| GET            | `/stock/slow-movers?days=90`                                                      | `inventory:read`                                         | In stock with no sale or transfer out for N days, by money tied up                                                                       |
| GET            | `/suppliers`, `/suppliers/:id`                                                    | `purchasing:read`                                        | Parties with the supplier role: terms, lead time, products with their last cost                                                          |
| PUT            | `/suppliers/:id/profile`                                                          | `purchasing:manage`                                      | Payment terms (days of credit) and lead time                                                                                             |
| PUT · DELETE   | `/suppliers/:id/products`, `/suppliers/:id/products/:variantId`                   | `purchasing:manage`                                      | Products the supplier provides, with the supplier's own code                                                                             |
| POST           | `/purchase-orders`                                                                | `purchasing:manage`                                      | Order for one store; numbered PO-000001…; cost defaults to the supplier's last cost                                                      |
| POST           | `/purchase-orders/from-low-stock`                                                 | `purchasing:manage`                                      | Quick reorder: every low product the supplier provides (or chosen ones), up to max                                                       |
| GET            | `/purchase-orders`, `/purchase-orders/:id`                                        | `purchasing:read`                                        | Orders at the member's stores; filter by `status`, `storeId`, `supplierId`                                                               |
| POST           | `/purchase-orders/:id/cancel` · `/close`                                          | `purchasing:manage`                                      | Cancel before anything arrives, or short-close a partly received order                                                                   |
| POST           | `/goods-receipts`                                                                 | `purchasing:manage`                                      | GRN against an order or a supplier invoice; free scheme units at zero cost                                                               |
| GET            | `/goods-receipts`, `/goods-receipts/:id`                                          | `purchasing:read`                                        | Receipts at the member's stores; filter by `storeId`, `supplierId`, `purchaseOrderId`                                                    |
| GET            | `/imports`, `/imports/:kind/template`                                             | signed in (template: the kind's permission)              | Import kinds with their columns; a CSV template to fill in (products, parties, opening-stock)                                            |
| POST           | `/imports/:kind/preview`                                                          | `catalog:manage` · `parties:manage` · `inventory:manage` | Checks a CSV and reports, row by row, what would be created, updated or left unchanged, with errors                                      |
| POST           | `/imports/:kind`                                                                  | as above                                                 | Saves every row in one transaction, or nothing if any row has an error; safe to run again                                                |
| GET            | `/onboarding`                                                                     | signed in                                                | Setup checklist for a new business: stores, team, products, suppliers, customers, stock, reorder levels                                  |
| POST           | `/documents` (multipart: `recordType`, `recordId`, `category`, `file`)            | the record's manage permission                           | Attach a file (≤ 10 MB; PDF, JPG, PNG, WebP, HEIC, DOCX, XLSX) after a virus scan                                                        |
| GET            | `/documents?recordType=&recordId=`, `/documents/:id/download`                     | the record's read permission                             | A record's documents; downloads always as an attachment                                                                                  |
| DELETE         | `/documents/:id`                                                                  | the record's manage permission                           | Hide a document (the file is kept for the audit trail)                                                                                   |
| GET            | `/notifications?unread=true`                                                      | signed in (own only)                                     | Notification centre, newest first, with the unread count for the badge                                                                   |
| POST           | `/notifications/:id/read` · `/notifications/read-all`                             | signed in (own only)                                     | Mark one or all as read                                                                                                                  |
| GET · PUT      | `/notifications/preferences`                                                      | signed in (own only)                                     | Turn in-app and email on or off per event                                                                                                |
| POST           | `/leads`                                                                          | `leads:manage`                                           | Capture a lead (LD-000001…) for a party, or from a name and mobile number (matched, else added as a customer)                            |
| GET            | `/leads`, `/leads/:id`, `/leads/pipeline`                                         | `leads:read`                                             | Filter by `stage`, `source`, `assignedTo` (id or `me`), `q`; per-stage counts and values for a kanban board                              |
| PATCH · POST   | `/leads/:id`, `/:id/assign`, `/:id/stage`, `/:id/lose`, `/:id/win`, `/:id/reopen` | `leads:manage`                                           | Edit, reassign, move between new / contacted / qualified, lose with a reason, win directly, reopen                                       |
| POST           | `/leads/:id/convert`                                                              | `leads:manage`                                           | Turn a qualified lead into an opportunity (OP-000001…)                                                                                   |
| POST · GET     | `/opportunities`, `/opportunities/:id`, `/opportunities/pipeline`                 | `leads:manage` · `leads:read`                            | Opportunities with value, quantity, order date, category, salesperson, probability; weighted pipeline                                    |
| PATCH · POST   | `/opportunities/:id`, `/:id/assign`, `/:id/stage`, `/:id/win`, `/:id/lose`        | `leads:manage`                                           | Discovery → proposal → negotiation → won / lost; winning or losing closes its lead too                                                   |

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
receipts, transfers and stock counts. Whoever can see the record sees its documents; whoever can
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
times with growing gaps. Several servers can run the worker safely. Follow-up reminders arrive with
P1-M09.

**Leads & opportunities** (roadmap P1-M07): a lead moves new → contacted → qualified, then converts
into an opportunity (discovery → proposal → negotiation → won / lost), or is won directly or lost
with a reason. Every change locks the record first, so two people acting at once cannot both
apply. Leads and opportunities belong to a store; staff see their stores' only.

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

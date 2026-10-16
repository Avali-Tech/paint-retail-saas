# Performance at large-shop scale

How the API and web app hold up for a large paint dealer, measured against the `DEMO_SIZE=large`
demo data (see the README, "Run the demo"). Budget: about **300 ms p95** for list and search
endpoints, **1 s** for the dashboard and reports.

**Verdict:** after the fixes below, every read the web app makes is within budget at this size, most
of them well under 100 ms. Three requests were not (or were heading there) and are fixed: the
activities and documents lists, the audit log filtered to stock write-offs, and slow movers.

## Dataset

`DEMO_SIZE=large pnpm demo:reset` (about 30 seconds): the full demo plus, in bulk, inside the
business's tenant scope,

| What                                                                            |                How many |
| ------------------------------------------------------------------------------- | ----------------------: |
| Stores (the demo's 3 + 5, each with a manager and a salesperson)                |                       8 |
| Products / pack sizes (variants), 20 brands                                     |           5,082 / 9,878 |
| Parties (customers, painters, contractors, architects, dealers, suppliers)      |                   5,084 |
| Stock ledger entries (opening stock, receipts, sales, write-offs over 6 months) |                 100,652 |
| Stock balances / reorder rules                                                  |         31,478 / 15,861 |
| Purchase orders / goods receipts                                                |           2,521 / 1,919 |
| Leads / opportunities / projects                                                |     6,022 / 1,423 / 810 |
| Activities (follow-ups open, overdue and due today among them)                  |                  30,103 |
| Documents (metadata only) / notifications / loyalty entries                     | 5,000 / 15,000 / 15,080 |
| Audit log entries (most from the other businesses' setup)                       |                  21,082 |
| Other businesses on the platform (for the console's list)                       |                     150 |

About 15% of the leads, projects and customer activities go to 25 key accounts, so the customer 360 and record
timelines are measured on a busy customer (47 leads, 65 activities), not an average one. The
database is 125 MB.

## Method

- **Machine:** a shared MacBook (6 CPUs and 12 GB for Docker, shared with two other agents running
  builds and tests at the same time). Absolute numbers are noisy and pessimistic; compare the before
  and after columns, which were measured back to back.
- **Database:** PostgreSQL 17 (alpine) in its own container, `shared_buffers=256MB`,
  `work_mem=16MB`, otherwise defaults (so JIT is on, as on RDS by default). `VACUUM ANALYZE` after
  seeding.
- **API:** the production bundle (`apps/api/dist/server/main.js`), worker off, on the same machine.
  **Before** is `mvp-1` at `bd75cff`; **after** is this branch. Both ran twice, alternating
  (before, after, after, before); the table shows the average of the two runs.
- **Requests:** exactly what the web app sends (page size 50, its filters), one at a time over
  HTTP, 2 warm-up requests then 20 timed. p50 and p95 by nearest rank, client-side wall time
  including JSON serialisation. As the owner (all 8 stores, the worst case) unless noted.
- **Slow ones:** `log_min_duration_statement` on the measurement database, then
  `EXPLAIN (ANALYZE, BUFFERS)` of the logged statement as `app_tenant` with the organisation set,
  as the API runs it.

## Results (ms)

| Request                                                     | Budget p95 | Before p50 / p95 | After p50 / p95 | Response |
| ----------------------------------------------------------- | ---------: | ---------------: | --------------: | -------: |
| `/dashboard`                                                |       1000 |          56 / 62 |     **57 / 60** |     5 KB |
| `/dashboard?storeId=` (one store)                           |       1000 |          21 / 22 |     **21 / 24** |     2 KB |
| `/search?q=reddy`                                           |        300 |          36 / 38 |     **34 / 36** |     5 KB |
| `/search?q=silk emulsion`                                   |        300 |          34 / 44 |     **34 / 35** |     1 KB |
| `/search?q=7012` (mobile fragment)                          |        300 |          37 / 39 |     **37 / 39** |     1 KB |
| `/search?q=LD-0059` (document number)                       |        300 |          36 / 39 |     **36 / 38** |     1 KB |
| `/search?q=re` (two letters)                                |        300 |          35 / 35 |     **35 / 36** |     7 KB |
| `/products/lookup?code=<barcode>`                           |        300 |            5 / 6 |       **5 / 7** |     1 KB |
| `/products/lookup?code=<sku>`                               |        300 |            5 / 6 |       **5 / 6** |     1 KB |
| `/products?limit=50`                                        |        300 |           8 / 10 |      **8 / 10** |    40 KB |
| `/products?limit=50&offset=5000`                            |        300 |          13 / 15 |     **13 / 14** |    37 KB |
| `/products?q=silk&limit=50`                                 |        300 |          27 / 28 |     **26 / 28** |    37 KB |
| `/stock?limit=50`                                           |        300 |          38 / 41 |     **39 / 41** |    22 KB |
| `/stock?storeId=&limit=50`                                  |        300 |          18 / 19 |     **18 / 19** |    22 KB |
| `/stock?q=silk&limit=50`                                    |        300 |          27 / 28 |     **26 / 27** |    22 KB |
| `/stock/low?limit=50`                                       |        300 |          44 / 45 |     **43 / 46** |    17 KB |
| `/parties?limit=50`                                         |        300 |           9 / 10 |      **9 / 11** |    29 KB |
| `/parties?q=reddy&limit=50`                                 |        300 |          11 / 12 |     **11 / 11** |    29 KB |
| `/parties?role=painter&limit=50`                            |        300 |          11 / 12 |     **11 / 12** |    30 KB |
| `/parties?limit=50` as a branch manager                     |        300 |            7 / 8 |       **6 / 8** |    27 KB |
| `/parties/:id/overview` (customer 360, busiest customer)    |        300 |          21 / 23 |     **20 / 21** |    10 KB |
| `/leads?limit=50`                                           |        300 |          16 / 17 |     **15 / 17** |    37 KB |
| `/leads?q=villa&limit=50`                                   |        300 |          22 / 24 |     **21 / 23** |    36 KB |
| `/leads?stage=new&limit=50` (pipeline board column)         |        300 |          13 / 13 |     **13 / 14** |    35 KB |
| `/leads/pipeline`                                           |        300 |            5 / 5 |       **4 / 4** |     1 KB |
| `/opportunities/pipeline`                                   |        300 |            4 / 4 |       **3 / 4** |     1 KB |
| `/activities/follow-ups?when=today` (mine, sales executive) |        300 |           8 / 10 |      **8 / 10** |    11 KB |
| `/activities/follow-ups?when=open` (mine, sales executive)  |        300 |            9 / 9 |      **9 / 11** |    11 KB |
| `/activities/follow-ups?assignedTo=everyone` (team)         |        300 |          12 / 13 |     **11 / 12** |    11 KB |
| `/activities?limit=50`                                      |        300 |        113 / 118 |     **16 / 17** |    28 KB |
| `/activities?limit=50` as a sales executive                 |        300 |        135 / 144 |     **16 / 18** |    28 KB |
| `/documents?limit=50`                                       |        300 |          77 / 81 |     **17 / 18** |    24 KB |
| `/documents?limit=50` as a sales executive                  |        300 |          71 / 73 |     **11 / 11** |    25 KB |
| `/purchase-orders?limit=50`                                 |        300 |            6 / 7 |       **6 / 8** |    19 KB |
| `/audit-log?limit=50`                                       |        300 |          54 / 56 |     **11 / 11** |    20 KB |
| `/audit-log?table=stock_ledger&limit=50`                    |        300 |      1261 / 1283 |       **7 / 8** |    43 KB |
| `/audit-log?table=loyalty_accounts&limit=50`                |        300 |          51 / 52 |      **7 / 10** |    20 KB |
| `/stock/ledger?limit=50` (API only, no screen)              |        300 |          49 / 51 |     **46 / 49** |    17 KB |
| `/stock/slow-movers?days=90` (API only, no screen)          |        300 |        502 / 510 |   **119 / 123** |    15 KB |
| `/notifications (bell)`                                     |        300 |            5 / 5 |       **5 / 6** |    11 KB |
| `/platform/tenants?limit=50`                                |        300 |          22 / 23 |     **22 / 25** |    26 KB |
| `/reports` (descriptions)                                   |       1000 |            1 / 2 |       **1 / 2** |     6 KB |
| `/reports/stock-by-location?limit=50`                       |       1000 |          58 / 59 |     **59 / 63** |     9 KB |
| `/reports/stock-by-location?format=csv`                     |       1000 |        101 / 105 |   **103 / 107** |   2.4 MB |
| `/reports/stock-ledger?limit=50`                            |       1000 |          70 / 72 |     **62 / 64** |    10 KB |
| `/reports/stock-ledger?format=csv`                          |       1000 |        287 / 299 |   **286 / 301** |   9.4 MB |
| `/reports/transfers?limit=50`                               |       1000 |            4 / 4 |       **4 / 5** |     2 KB |
| `/reports/transfers?format=csv`                             |       1000 |            3 / 4 |       **3 / 4** |     1 KB |
| `/reports/goods-receipts?limit=50`                          |       1000 |            8 / 8 |       **8 / 8** |    12 KB |
| `/reports/goods-receipts?format=csv`                        |       1000 |          39 / 41 |     **27 / 28** |   195 KB |
| `/reports/leads?limit=50`                                   |       1000 |          14 / 15 |     **14 / 15** |    17 KB |
| `/reports/leads?format=csv`                                 |       1000 |          26 / 29 |     **27 / 31** |   934 KB |
| `/reports/projects?limit=50`                                |       1000 |            8 / 8 |       **8 / 9** |    16 KB |
| `/reports/projects?format=csv`                              |       1000 |            8 / 9 |       **8 / 9** |   111 KB |

Also measured: opening a whole-store stock count at the largest store (about 3,800 lines) answers in
25 ms p95 but is **903 KB** of JSON; the web app used to render all of them with an input each
(see fix 4).

## What was slow, and the fixes

1. **JIT compilation on short queries** (activities and documents lists, the audit log, customer
   360, CSV exports). The visibility filter on activities and documents is an `OR` of `EXISTS` per
   record type; PostgreSQL over-estimates it (cost ~640,000 for a 12 ms query), crosses
   `jit_above_cost` and spends ~100 ms compiling. `EXPLAIN ANALYZE` of the activities count:
   129 ms with JIT (109 ms of it compiling), 11.6 ms without. Fix: `createDatabase()` opens every
   pooled connection with `-c jit=off` (`packages/db/src/client.ts`). Nothing here runs long enough
   for JIT to pay back; the slowest query, the 100,000-row ledger CSV, is no slower without it.
   Activities 118 → 17 ms, documents 81 → 18 ms, audit log 56 → 11 ms (p95).
2. **Audit log record names compared `id::text = record_id`**, which cannot use the primary key:
   every row on the page scanned its table. Filtered to stock write-offs, each of 50 rows scanned
   the whole 100,000-row ledger: **1,283 ms → 8 ms**. Fix: compare `id = record_id::uuid` for the
   named tables, whose keys are all uuids; the catch-all branch keeps the text comparison
   (`apps/api/src/audit/audit.service.ts`).
3. **Slow movers** looked up each balance's last sale and first receipt with two correlated
   subqueries, for the page and again for the count: 31,000 balances × 4 index probes. Now one
   grouped pass over the ledger (limited to the member's stores) joined to the balances:
   **510 → 123 ms**, same answers (`apps/api/src/reorder/reorder.service.ts`). No screen uses it
   yet.
4. **Stock count detail rendered every line.** A whole-store count at a large shop has thousands
   of lines, each with an input. The page now shows 100 lines at a time with the usual pager;
   typed counts are kept across pages, and saving with a mistake on another page jumps to it
   (`apps/web/src/stock-counts/StockCountDetailPage.tsx`).

Checked and fine as they are: every search box is debounced (250–300 ms) and every list the web app
shows is paged at 50 (follow-ups at 20, the board at 50 per column); the customer 360 lists the
latest 10 of each kind; the import preview shows a slice of its rows; lookups by barcode or SKU
are 6 ms; search is 35–39 ms with the trigram indexes.

## Indexes added

Added in migration `0049_newest_first_indexes` (measured by hand on the measurement database first).
The same migration rebuilds `documents_recent_idx` (from 0047) as `created_at DESC NULLS FIRST, id DESC
NULLS FIRST`: Drizzle writes `.desc()` as `DESC NULLS LAST`, which does not match the queries'
`ORDER BY created_at DESC, id DESC` (PostgreSQL's default for `DESC` is `NULLS FIRST`), so
PostgreSQL still sorted after reading the index. `migrate.int.test.ts` checks both plans have no sort.

```sql
CREATE INDEX stock_ledger_organization_created_idx
  ON stock_ledger (organization_id, created_at DESC, id DESC);
```

The stock ledger report and `GET /stock/ledger` list the newest movements first; without this
index PostgreSQL reads and sorts all 100,000 entries for each page (parallel seq scan + sort,
39 ms), with it it reads 50 index entries (1 ms). Measured through the API (p50 / p95, 20 runs):
`/reports/stock-ledger?limit=50` 60 / 63 → 40 / 41 ms, `/stock/ledger?limit=50` 45 / 46 → 26 /
27 ms. What remains is each page's total count. Size: 5.8 MB at 100,000 entries. It grows with
the ledger, which grows fastest of all tables, so it matters more over time.

## To watch as data grows

These are within budget now but grow linearly with the business:

- **Totals on report pages** (`count(*)` of the whole report, 40–60 ms at 100,000 ledger rows).
  At about a million ledger rows the stock-ledger page would approach the 1 s budget. Options then:
  a capped count ("10,000+", needs a small change in the report pager) or a default date range.
- **CSV exports are the whole report in one string**: the stock ledger is 9.4 MB in 300 ms now,
  and would be ~90 MB at a million rows. Stream it (cursor) or require a date range before then.
- **Stock list and low stock** sort by store, brand, product and pack across joined tables, so
  each page scans every balance (40–46 ms at 31,000 balances). Fine until a few hundred thousand.
- **Response compression:** the API returns JSON uncompressed (a whole-store stock count is
  903 KB). CloudFront compresses only when the cache policy allows it, and the API behaviour uses
  the managed CachingDisabled policy, which (as we understand it) does not; worth checking, or
  adding compression in the API.

## Release 2.1: receivables, collections, credit and statements

MVP 3 round 4b measured the Release 2.1 reads on the same large shop. **Verdict:** every read
is within budget after three fixes:

- the credit list ran a query per customer;
- site accounts ran a query per site;
- PDFs read and parsed their font file again for every line, so a busy customer's statement PDF
  took 4 s.

### Dataset

`DEMO_SIZE=large` now also writes the books of 1,200 credit customers
(`apps/api/src/demo/bulk-receivables.ts`), in bulk like the rest, inside the tenant scope with the
audit and allocation rules on. Each customer has:

- an opening balance from the old books for about a third, some overdue since well before go-live;
- 1–23 bills on account since go-live, some booked to a site;
- payments set against the oldest bills first, advances used on the next bill, and a quarter who
  never paid;
- holds by hand, and for every account over 30 days late;
- site accounts and promises to pay (open, and broken with escalations).

The nightly reconciliation then finds nothing, as on the demo.

| What                                                     |                How many |
| -------------------------------------------------------- | ----------------------: |
| Credit customers                                         |                   1,223 |
| Tax documents (invoices, notes) / payments / allocations | 15,679 / 6,304 / 16,948 |
| Party ledger entries / site accounts / promises to pay   |        22,429 / 88 / 55 |
| Database                                                 |                  188 MB |

### Method

The large demo was seeded into a PostgreSQL 17 Testcontainer and `VACUUM ANALYZE`d. The API ran
in-process (the seed's own `createApp`, `jit=off` as in production), with requests sent by
`app.inject`: 2 warm-up requests, then 20 timed. p50 and p95 are by nearest rank; queries are
counted on the `pg` client for one request. All requests are as the owner, with all 8 stores.

Before and after were measured back to back on the same machine, an 8 GB Mac running other work.
"Before" is commit `f40261f`; "after" is `6912b52`. Compare the two columns rather than the
absolute numbers.

`apps/api/src/receivables/receivables-scale.int.test.ts` keeps the same reads in CI. It uses
1,500 credit customers and about 9,000 bills, and fails on two things:

- a query count that grows with the page (a page of 200 must run as many queries as a page of 50);
- times over generous limits (4 s for ageing and the worklist, 1.5 s for a credit check).

### Results (ms)

| Request                                                     | Budget p95 | Before p50 / p95 | After p50 / p95 | Queries before → after | Response |
| ----------------------------------------------------------- | ---------: | ---------------: | --------------: | ---------------------: | -------: |
| `/receivables/summary`                                      |       1000 |        205 / 216 |   **210 / 225** |                12 → 12 |     1 KB |
| `/receivables/ageing?limit=50` (by customer)                |        300 |        207 / 227 |   **205 / 214** |                11 → 11 |    17 KB |
| `/receivables/ageing?groupBy=salesperson`                   |        300 |        205 / 212 |   **200 / 206** |                11 → 11 |     3 KB |
| `/receivables/ageing?groupBy=store`                         |        300 |        198 / 211 |   **206 / 213** |                11 → 11 |     3 KB |
| `/receivables/ageing?projectId=` (one site)                 |        300 |              n/a |     **54 / 55** |                     11 |     1 KB |
| `/receivables/ageing` as a sales executive (2 of 8 stores)  |        300 |        117 / 119 |   **117 / 129** |                12 → 12 |    17 KB |
| `/collections/worklist?limit=50`                            |        300 |        212 / 222 |   **205 / 223** |                14 → 14 |    23 KB |
| `/collections/worklist?salespersonId=me` (sales executive)  |        300 |        111 / 116 |   **114 / 119** |                15 → 15 |    22 KB |
| `/collections/escalations`                                  |        300 |           8 / 10 |      **8 / 10** |                10 → 10 |    10 KB |
| `/credit-profiles?limit=50`                                 |        300 |        121 / 130 |     **22 / 24** |           **111 → 13** |    20 KB |
| `/credit-approvals?status=pending`                          |        300 |          13 / 14 |     **12 / 15** |                  9 → 9 |     1 KB |
| `/parties/:id/credit` (the busiest customer)                |        300 |          15 / 20 |     **20 / 24** |                17 → 17 |     1 KB |
| `/parties/:id/sites`                                        |        300 |            8 / 9 |     **12 / 14** |  10 → 9 (one per site) |     1 KB |
| `/site-accounts/:id`                                        |        300 |          13 / 14 |     **13 / 16** |                13 → 12 |     2 KB |
| `/parties/:id/statement` (the customer with the most bills) |        300 |          29 / 32 |     **30 / 32** |                13 → 13 |    59 KB |
| `/parties/:id/statement.pdf` (the same)                     |       1000 |      4025 / 4066 |   **138 / 156** |                13 → 13 |    31 KB |
| `/reports/receivables-ageing?format=csv`                    |       1000 |        202 / 219 |   **204 / 232** |                11 → 11 |   121 KB |
| `/reports/receivables-open-bills?format=csv`                |       1000 |        205 / 220 |   **211 / 234** |                11 → 11 |   592 KB |

The scale test (1,500 customers) shows the same: `/credit-profiles?limit=50` 130 → 22 ms and
`?limit=200` 494 → 25 ms (111 and 411 queries → 13). A contractor with six sites now runs the same
9 queries as one with one site.

### What was slow, and the fixes

1. **The credit list ran two queries per customer.** `GET /credit-profiles` called `exposureOf`
   for each row (the go-live check, then the exposure). `exposuresOf` now answers the whole page in
   one query over `unnest` of the page's parties: `apps/api/src/credit/credit-lookups.ts`.
   `exposureOf` is the same query for one party, so the list and the credit check cannot disagree.
2. **Site accounts ran a query per site.** `siteAccountsOf` now selects each site's outstanding
   and open orders as columns of its list query, with the same SQL the credit check uses.
3. **PDFs re-read their font for every line.** pdfkit 0.20 caches a registered font under its name
   only when it opens it first. Our documents were created with the regular font's file as their
   default, so every later `font('regular')` read and parsed the file again: about 1.5 ms a table
   cell. `pdfDocument` (`apps/api/src/print/render-invoice-pdf.ts`) registers the fonts with no
   default file, for statements, invoices (ours and the businesses'), quotations and receipts. A
   300-entry statement went from 2.9 s to 0.1 s, with the same bytes.
4. **The worklist searched lists per row** for each customer's promise, escalation and last
   activity. It now uses maps (no visible change at this size; quadratic at tens of thousands).

### Indexes

None were needed at this volume, and none were added (this round has no migrations). The ageing
query reads a business's whole receivable books by design. In `EXPLAIN (ANALYZE, BUFFERS)` as
`app_tenant`, its joins use primary keys (a memoised index scan for openings), and the
cancellation lookup uses `party_ledger_reference_unique`. The rest are sequential scans of the
business's own rows, which suit a read of everything; no plan showed a missing index. Each 200 ms
request is that query, then ageing every bill in `@paint/shared` and serialising the rows.

Two candidates for the migrations session, if the daily jobs grow slow:

- `tax_documents (organization_id, due_on) WHERE status = 'issued' AND kind IN ('invoice',
'bill_of_supply', 'debit_note')`, for the reminders run's `due_on = today − n`;
- `party_ledger (organization_id, party_id) WHERE entry_type IN ('opening', 'adjustment')`, for the
  ageing's openings and charges.

### To watch as data grows

- **Ageing reads the whole history** of the business's receivable books on every request, settled
  bills included, and drops what is settled after aggregating. That is 200 ms at 15,000 bills, so
  about 1.5 s at 100,000.

  Cheapest next step: skip settled bills before aggregating their allocations when ageing as of
  today. Beyond that: a "settled on" date per bill (a migration).

- **Parameter lists:** the ageing lookups and the worklist pass every party id as its own
  parameter (`IN (...)`). PostgreSQL allows 65,535 parameters, so a business with that many owing
  customers would fail; passing one array (`= any($1::uuid[])`) avoids it.

## Release 2.1: brand profitability (round 5b)

`GET /reports/brand-profitability` reads the books in six queries whatever the period holds (the
period's sale lines, the units its credit notes put back, the costed receipts behind the average
cost, every bill owed during it with its dated allocations, the points its documents earned, the
painter earn rules), then three name lookups. The integration test checks the count does not grow
as invoices are added. Round 6b measured it at large-shop volume: see the next section.

### To watch as data grows

- **Average cost is replayed** from the stock ledger: the costed-receipts query runs a window sum
  over every movement of each store and variant the period sold, from the first. At hundreds of
  thousands of movements, a nightly average-cost snapshot per store and variant (a migration)
  would bound it.
- **Credit cost reads every bill owed during the period**, settled ones included when they were
  settled inside it; like ageing, a "settled on" date per bill would let it skip the rest.

## Release 2.1: brand schemes, the planner and brand profitability (round 6b)

MVP 3 round 6b measured round 5's brand screens at a large shop's volume. **Verdict:** every read
is within budget after three fixes:

- each scheme was matched against every brand's GRN lines;
- the engines parsed the same dates millions of times;
- a scheme's page drew thousands of GRN lines at once.

Listing 100 schemes went from 1.8 s to 0.27 s, and brand profitability for a quarter from 1.2 s
to 0.6 s.

### Dataset

`apps/api/src/brand-schemes/brand-money-scale.int.test.ts` builds it in bulk
(`apps/api/src/test-support/brand-money-books.ts`), inside the tenant scope with the stock and
tax-document rules on. The large demo has no sale invoices with lines and no schemes, so it
could not be used as it is.

| What                                                                          |                    How many |
| ----------------------------------------------------------------------------- | --------------------------: |
| Brands / products / packs                                                     |            20 / 500 / 1,000 |
| GRNs / GRN lines over a year (the first brand bought most, the 20th least)    |              3,000 / 18,000 |
| Sale invoices / their lines / credit notes                                    |        9,919 / 29,558 / 245 |
| Stock movements (receipts, sales, returns)                                    |                      49,342 |
| Schemes: per brand three finished quarters, the running one and a yearly one  | 100 (80 running), 60 claims |
| Credit customers' books (`bulk-receivables.ts`), bills with dated allocations | 600 customers, ~3,600 bills |

The sale invoices are not paid, so brand profitability's credit cost reads every one of them as
owed: a worst case for its bills query. There are no loyalty points.

### Method

As for round 4b: the API in-process (`createApp`, `jit=off`), requests by `app.inject` as the
owner, one warm-up call, the median of five timed calls, and queries counted on the `pg` client
(the fewest of three calls). Each count includes about 7 queries of sign-in and tenant set-up.
"Before" is commit `1227c66`; "after" is `8585e8e`, measured back to back on the same 8 GB Mac
running other work, so compare the columns rather than the absolute numbers.

The scale test keeps these reads in CI with generous limits: 4 s for the scheme lists, 3 s for a
scheme and the planner, 6 s and 10 s for profitability over a quarter and a year. It also fails
if the query count grows:

- 100 schemes of 20 brands must run the queries of one brand's 5;
- the busiest brand's yearly scheme, those of the quietest brand's;
- the planner for the brand with the most packs, those for the brand with the fewest;
- profitability for a year, those for a quarter.

Set `BRAND_MONEY_SCALE_REPORT` to a file to get the times.

### Results (ms)

| Request                                                         | Budget | Before | After | Queries | Response |
| --------------------------------------------------------------- | -----: | -----: | ----: | ------: | -------: |
| `/brand-schemes` (100 schemes)                                  |    300 |   1832 |   268 |      15 |   193 KB |
| `/brand-schemes?brandId=` (the busiest brand, 5 schemes)        |    300 |    165 |   105 |      15 |    10 KB |
| `/brand-schemes?status=active` (80)                             |    300 |   1276 |   221 |      15 |   153 KB |
| `/brand-schemes/overview` (the dashboard tile)                  |    300 |   1290 |   205 |      15 |     1 KB |
| `/brand-schemes/claims`                                         |    300 |   1832 |   269 |      16 |    74 KB |
| `/brand-schemes/:id` (the busiest brand's yearly scheme)        |    300 |    119 |    97 |      16 |  2058 KB |
| `/brand-schemes/:id` (the quietest brand's yearly scheme)       |    300 |     57 |    54 |      16 |    96 KB |
| `POST /brand-schemes/price-hike-plan` (50 packs)                |    300 |     12 |    15 |      14 |    23 KB |
| `/reports/brand-profitability` (last quarter, by brand)         |   1000 |   1466 |   765 |      27 |     9 KB |
| `/reports/brand-profitability?from&to` (90 days)                |   1000 |   1231 |   610 |      26 |     9 KB |
| `/reports/brand-profitability?from&to` (a year)                 |   1000 |   2478 |   987 |      26 |     9 KB |
| `/reports/brand-profitability?groupBy=product`                  |   1000 |   1445 |   847 |      27 |   214 KB |
| `/reports/brand-profitability?groupBy=store`                    |   1000 |   1477 |   624 |      27 |    25 KB |
| `/reports/brand-profitability?from&to&groupBy=product` (a year) |   1000 |   2451 |   811 |      26 |   217 KB |
| `/reports/brand-schemes?format=csv`                             |   1000 |   1795 |   227 |      15 |    12 KB |
| `/reports/brand-scheme-claims?format=csv`                       |   1000 |   1816 |   226 |      16 |    11 KB |
| `/reports/brand-profitability?format=csv&groupBy=product`       |   1000 |   1458 |   663 |      27 |    54 KB |

A second run of the same code was within about 20 % of these, apart from one CSV call that met a
busy moment on the machine.

After the fixes, a quarter's profitability spends its time like this:

- the six reads of the books, about 420 ms: the bills owed with their dated allocations 210 ms,
  the costed receipts 106 ms, the period's lines 82 ms;
- attributing them to brand, product and store, about 75 ms;
- the scheme money, about 150 ms: the GRN lines of every brand with a scheme in the period.

### What was slow, and the fixes

1. **Every scheme was matched against every brand's GRN lines.** `evaluateSchemes` loads the GRN
   lines of all the schemes' brands in one query, as before, but then ran each scheme over all of
   them: 100 schemes × 18,000 lines. It now groups the lines by brand and the receipts by scheme
   first. `loadSchemes` groups slabs, benefits and what each scheme covers the same way
   (`apps/api/src/brand-schemes/scheme-data.ts`). The list, claims, dashboard tile and CSVs went
   from 1.3–1.8 s to about 0.5 s, and brand profitability's scheme money gained the same.
2. **The engines parsed the same dates over and over.** A scheme checks each GRN line's day
   against its period twice: when choosing its lines and again in `schemeProgress`. Each check
   parsed and validated four ISO dates. `dayNumber` (`packages/shared/src/receivables/dates.ts`)
   now remembers the dates it has worked out, in a cache cleared at 20,000 entries. Lists went from
   about 0.5 s to 0.2–0.27 s, and a quarter's profitability from 0.86 s to 0.61 s. Ageing, the
   worklist and the credit check use the same function.
3. **A scheme's page drew every GRN line.** The busiest brand's yearly scheme counts about 4,500
   GRN lines (a 2 MB answer, 97 ms at the API). The page now shows 100 at a time with the usual
   pager (`apps/web/src/brand-schemes/SchemeDetailPage.tsx`), as stock counts do.

Checked and fine: the price-hike planner reads stock, sales and last costs in three grouped
queries (13–15 ms for 50 packs), and brand profitability's query count is the same for a year as
for a quarter.

### Indexes

None are needed at this volume, and none were added (this round has no migrations). The scheme
GRN query filters goods receipts by India date, which no index serves, but at 3,000 GRNs reading
them all takes a few milliseconds.

For the migrations session, if a shop's GRNs grow past about 100,000: add
`goods_receipts (organization_id, received_at)`, and rewrite the scheme query's date filter as a
range on `received_at` (the India day's start and end) or the supplier invoice date.

### To watch as data grows

- **A scheme's page receives all its GRN lines.** The page shows 100 at a time, but the API still
  answers with every line counted: 2 MB for a busy brand's year. Paging in the API, or totals per
  GRN, would cut it.
- **The scheme lists load every GRN line of the period** for the brands listed, to work out
  progress (14,500 lines and about 145 ms here). Summing per brand, product and day in SQL would
  cut the rows; a stored progress per scheme, updated with each GRN, would need a migration.
- **Brand profitability's bills query** reads every bill owed during the period with its dated
  allocations and lines (210 ms at 11,800 bills, every sale invoice unpaid here). As for ageing, a
  "settled on" date per bill would let it skip what was settled before the period.

## Release 2.1: sales reports and the GST summary (round 7b)

MVP 3 round 7b added the dashboard's sales tile, eight sales reports and the GST summary. Every
one is a single grouped query over the period's document lines, plus the report's count; the
tile is a single query of one row per day. No fix was needed. **Verdict:** every read is within
budget at the round 6b volume, with large room to spare.

### Method

`apps/api/src/brand-schemes/brand-money-scale.int.test.ts` reuses round 6b's dataset: about
9,900 sale invoices with 29,600 lines and 245 credit notes over a year, plus 600 credit
customers' books with payments. The same method as round 6b applies: one warm-up call, the
median of five timed calls, and queries counted on the `pg` client. Each count includes about
7 queries of sign-in and tenant set-up. The machine was an 8 GB Mac running other work.

The test fails on three things:

- a report that runs more queries over a year (page of 200) than over a quarter (page of 50);
- a report slower than 4 s, or the tile slower than 2 s;
- the year's net sales by store, by brand and in the GST summary that do not agree.

### Results (ms)

| Request                                            | Budget | Time | Queries | Response |
| -------------------------------------------------- | -----: | ---: | ------: | -------: |
| `/dashboard/sales`                                 |   1000 |    6 |       9 |     2 KB |
| `/dashboard/sales?storeId=` (one store)            |   1000 |    6 |       9 |     2 KB |
| `/reports/sales-by-period?limit=50` (a quarter)    |   1000 |   51 |       9 |     7 KB |
| `/reports/sales-by-period?limit=200` (a year)      |   1000 |  104 |       9 |    27 KB |
| `/reports/sales-by-period?interval=month` (a year) |   1000 |  102 |       9 |     2 KB |
| `/reports/sales-by-store` (a year)                 |   1000 |  103 |       9 |     1 KB |
| `/reports/sales-by-product?limit=200` (a year)     |   1000 |  131 |       9 |    47 KB |
| `/reports/sales-by-product?format=csv` (a year)    |   1000 |   93 |       8 |    92 KB |
| `/reports/sales-by-brand` (a year)                 |   1000 |  125 |       9 |     4 KB |
| `/reports/sales-by-category` (a year)              |   1000 |  116 |       9 |     1 KB |
| `/reports/sales-by-salesperson` (a year)           |   1000 |  114 |       9 |     1 KB |
| `/reports/sales-by-customer?limit=200` (a year)    |   1000 |  112 |       9 |    48 KB |
| `/reports/payments-by-mode?limit=200` (a year)     |   1000 |   14 |       9 |    36 KB |
| `/reports/gst-summary` (a quarter)                 |   1000 |   69 |       9 |     1 KB |
| `/reports/gst-summary` (a year)                    |   1000 |  197 |       9 |     1 KB |
| `/reports/gst-hsn-summary` (a year)                |   1000 |   73 |       9 |     1 KB |

### Indexes

None were added (this round has no migrations). The reports filter `tax_documents` by
organisation, status, kind and `issued_on`, then join each document's lines through
`tax_document_lines`' foreign key. For an owner with every store, the existing
`tax_documents_store_issued_idx (organization_id, store_id, issued_on)` cannot serve an
`issued_on` range on its own, so PostgreSQL reads the business's documents. That takes a few
milliseconds at 15,000 documents.

One candidate for the migrations session, if a shop passes a few hundred thousand documents:
`tax_documents (organization_id, issued_on) WHERE status = 'issued'`. It would serve the tile's
seven weeks and short report ranges across every store. The line join already has an index:
`tax_document_lines_document_line_unique (document_id, line_no)`.

### To watch as data grows

- Without a date range the reports cover the business's whole history: about 200 ms a year at
  this volume, so about 1 s after five years. The screen sends no default range today. Defaulting
  `from` to the start of the financial year would bound it.
- Each page's count runs the grouped query again. That is cheap here, since there are few
  groups, but it doubles the time of a whole-history report.

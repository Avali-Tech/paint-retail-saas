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

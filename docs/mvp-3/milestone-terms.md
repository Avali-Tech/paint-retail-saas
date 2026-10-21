# Milestone payment terms for contractor sites (MVP 3): design spec

|           |                                                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Modules   | Extends P2-M09 site accounts ([credit-and-receivables.md](credit-and-receivables.md) §3.3), P2-M10 ageing, P2-M11 collections, P2-M32 messages |
| Branch    | feature PRs → `mvp-3`                                                                                                                          |
| Builds on | `mvp-3` at migration `0091`; the dispatch hold of PR #67 (`apps/api/src/credit/dispatch-hold.ts`, branch `feature/mvp3-dispatch-site-credit`)  |
| Status    | Draft for product-owner review; nothing built. Open questions in §9 ([PO-130] – [PO-148], [CA-120])                                            |

**How to read it.** §1 is what we build, §2 the model, §3 the data model, §4 its effect on the
credit and receivables rules (numbered MT rules, each with its check), §5 the nudges, §6
permissions and audit, §7 the API and screens, §8 the build slices and §9 the open questions.

**The problem.** A contractor does not pay a site's bills N days after each bill. Their own
client pays them by stage of work (putty done, primer coat done, final coat done), and they pay
the shop then. Today every credit bill gets `due_on = today + credit_profiles.credit_days`
(`apps/api/src/orders/order-invoicing.ts`, `invoice-issue.service.ts`), so a site's bills go
"overdue" while the work is on schedule, the collections run reminds the contractor for money
their client has not yet released, and the nightly hold (§4.4 there) can stop their deliveries.

---

## 1. Scope

### 1.1 Built (slices in §8)

| Piece                         | What ships                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Schedule per site             | An ordered list of milestones on a site account: name, share of the site's billing (or a fixed amount), reached by hand or by the project's stage            |
| Milestone due date            | A site bill is due, part by part, when the milestone that releases it is reached + grace days, and never later than a long-stop date                         |
| Reached                       | "Mark reached" (and an approver's undo), audited; moving the project to a linked stage reaches it too                                                        |
| Everywhere a due date is read | Overdue days, the credit check, the nightly hold, ageing, the site view, statements, reports, payment links and reminders read one effective due date (§2.4) |
| Nudges                        | "Primer coat done at Sharma residence: ₹24,000 is due by 15 Nov" to the contractor through the outbox; staff told in the app                                 |

### 1.2 Research, not in this spec's slices

| Item                                                | Why not now                                                                                                                         |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Painting stages (putty, primer, coats) on projects  | `project_stage` is the sales pipeline (`identified` … `execution`, `completed`, `packages/db/src/schema.ts`), not the work's stages |
| A default schedule from the estimator               | `packages/shared/src/estimator` splits putty, primer and paint quantities; a share per material is plausible but unproven           |
| The contractor confirms "primer done" by replying   | Needs inbound WhatsApp from a BSP ([PO-1])                                                                                          |
| Homeowner-billed sites guaranteed by the contractor | Already research in §3.3 of the credit spec                                                                                         |
| Interest on a missed milestone                      | [PO-6]                                                                                                                              |

### 1.3 Reused, not rebuilt

| Existing piece                                                                       | Used for                                                                  |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `site_credit_accounts` (party + project, limit, status)                              | Holds the terms; the schedule hangs off it (no second "site" object)      |
| `projects.stage`, `POST /projects/:id/stage` (`ProjectsService.moveTo`)              | Linked-stage milestones                                                   |
| `tax_documents.due_on`, `project_id`; `allocations` (`payment_id`, `credit_note_id`) | Long-stop date; which bills are on the site; what paid them               |
| `openDocumentsOf` (`apps/api/src/credit/credit-lookups.ts`)                          | One place the effective due date enters the credit check and nightly hold |
| `ageReceivables` engine (`packages/shared/src/receivables/ageing.ts`)                | Ageing by part; the invariant Σ buckets − advance = balance is unchanged  |
| `reminder_schedules`, `collections-job.ts`, `queueMessage`, `message_outbox`         | Reminders on release due dates; the milestone notice                      |
| `promises_to_pay`, `collection_runs`, consent (MSG-1), messaging hours (MSG-6)       | Unchanged                                                                 |
| `roundDiv` (`packages/shared/src/gst/arith.ts`), `formatINR` (`money.ts`)            | Shares in basis points over integer paise, `BigInt` arithmetic            |
| `audit_row_change()`, `Notifier`, `credit:manage` / `credit:approve`                 | Audit, staff notices, permissions (no new permission, no data migration)  |

---

## 2. The model

### 2.1 Definitions

| Term           | Definition                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Milestone site | A site account with `terms = 'milestones'` and a schedule                                                                                                                             |
| Milestone bill | An invoice, bill of supply or debit note issued to the site account's party with its `project_id` while the site is on milestone terms; marked at issue (`milestone_site_account_id`) |
| Net value(d)   | `total(d) − Σ credit-note allocations to d`                                                                                                                                           |
| Site base      | Σ net value of the site's milestone bills, cancelled ones excluded, on the day a milestone is reached                                                                                 |
| Release        | A part of one milestone bill made due by one milestone: amount and due date (`reached_on + grace_days`). Stored, append-only                                                          |
| Remainder(d)   | Net value(d) − Σ live releases of d; due on `d.due_on`, the long-stop (`issued_on + longstop_days`)                                                                                   |
| Parts(d, asOf) | Releases of d made on or before asOf, then the remainder, ordered by due date                                                                                                         |

### 2.2 The schedule

A site account gains `terms` (`credit_days` default / `milestones`), `grace_days` (0–60, default
7, [PO-131]), `longstop_days` (1–365, default 90, [PO-130]) and `milestone_basis` (`share` /
`amount`). Its milestones (1–10, ordered by `position`):

| Field          | Rule                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | Unique on the site (any case), e.g. "Putty", "Primer coat", "Final coat"                                                                    |
| `share_bps`    | Basis `share`: this milestone's own share, > 0; all but the last sum to < 10,000                                                            |
| `amount_paise` | Basis `amount`: this milestone's own amount, > 0                                                                                            |
| The last       | Neither: it always releases "the rest", so a finished site leaves nothing undue                                                             |
| `trigger`      | `manual`, or `project_stage` with `stage` ∈ `execution` / `completed` (moving to that stage, or past it in `WORK_STAGES` order, reaches it) |
| Reached        | `reached_on`, `reached_by_member_id`, `reached_source` (`manual` / `project_stage` / `project_cancelled`), `note`; written once             |

Milestones are reached in order: reaching one reaches every earlier unreached one on the same
day. A reached milestone never changes; unreached ones may be renamed, re-weighted, added or
removed (the share rule re-checked). Changing `terms` affects bills issued afterwards only.

### 2.3 How a bill gets its due date

```text
issue of a bill d with party p and project s, unpaid after the payments taken with it:
  site account a = (p, s) with terms = 'milestones' and an unreached milestone
    → d.due_on = issued_on + a.longstop_days   (the long-stop; printed "payable on milestone,
      latest by …"); d.milestone_site_account_id = a. A typed dueOn is refused (400)
  otherwise → today's rule: issued_on + credit_days (or the typed date)

milestone k of site a reached on day R (one transaction, site account row locked):
  cumulative(k) = Σ share_bps of milestones 1..k        (basis share; the last = 10,000)
                  Σ amount_paise of 1..k, capped at base  (basis amount; the last = base)
  target        = roundDiv(cumulative(k) × base, 10,000)  (share) or cumulative amount
  to release    = max(0, target − Σ live releases of the site's still-issued milestone bills)
  fill the site's milestone bills oldest first (issued_on, issued_at, id), each up to its
  remainder, writing one release per bill: (d, k, amount, due_on = R + a.grace_days)
```

So a bill issued **before** a milestone is released by it (oldest first), and one issued
**after** it waits for the next milestone, whose cumulative target catches it up. A bill issued
once the last milestone is reached is an ordinary credit-days bill (touch-up work, [PO-133]).
Every bill is due by its long-stop whatever happens to the site. Cancelling the project
reaches the last milestone (`project_cancelled`), so all that is left falls due ([PO-134]).

### 2.4 One effective due date, payments and credit notes

```text
outstanding parts(d, asOf):
  credit notes take value off from the back: the remainder first, then the latest release
  payments (and reversals, bounces as today) settle from the front, in due-date order
effective due(d, asOf) = due date of the first part not fully settled
                       = d.due_on for every bill with no releases (today's behaviour, exactly)
```

"Payments pay the oldest due part; returns shrink what is not yet due" keeps the site figure
exact: what is due on the site = Σ releases due − payments to its bills, whatever the order of
credit notes ([PO-135]). It lives in one SQL function, `document_due_on(document_id, as_of)`
(and a twin returning the amount due by then), and one pure function in
`packages/shared/src/receivables` (`documentParts`) that the ageing engine and the SQL tests
share. Payments allocated by hand to a newer bill leave an older released part unpaid, as they
would today ([PO-136]).

### 2.5 Worked example

Rahul Painters, site "Sharma residence" (PJ-000004): Putty 30 %, Primer coat 30 % (both
manual), Final coat the rest (reached when the project moves to `completed`); grace 7 days,
long-stop 90.

| Day    | Event                                         | Result                                                                                              |
| ------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1 Oct  | INV-1 ₹40,000 issued                          | `due_on` 30 Dec (long-stop); nothing due yet, not overdue                                           |
| 10 Oct | INV-2 ₹20,000 issued                          | `due_on` 8 Jan                                                                                      |
| 15 Oct | Putty marked reached                          | base ₹60,000, target ₹18,000: release INV-1 ₹18,000 due 22 Oct; notice to Rahul                     |
| 20 Oct | Rahul pays ₹10,000 (to INV-1)                 | Settles ₹10,000 of the release                                                                      |
| 23 Oct | Nightly run                                   | INV-1 effective due 22 Oct, 1 day past due, ₹8,000 in 0–30, ₹22,000 not due; INV-2 not due          |
| 25 Oct | Credit note ₹5,000 on INV-2 (primer back)     | INV-2 net ₹15,000; base ₹55,000                                                                     |
| 5 Nov  | INV-3 ₹15,000 issued                          | base ₹70,000                                                                                        |
| 8 Nov  | Primer coat marked reached by the salesperson | target 60 % × ₹70,000 = ₹42,000 − ₹18,000 = ₹24,000: INV-1 ₹22,000 and INV-2 ₹2,000, due 15 Nov     |
| 15 Nov | Due on the site                               | ₹42,000 released − ₹10,000 paid = ₹32,000 (INV-1 ₹30,000, INV-2 ₹2,000); INV-3 waits for Final coat |

---

## 3. Data model: migrations 0092–0093

| Migration | What                                                                                                                                                                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0092      | `site_milestones`, `site_milestone_releases` (RLS, composite keys); `site_credit_accounts` gains the terms columns (existing rows `credit_days`); `tax_documents.milestone_site_account_id`; enum values `message_template_key.milestone_reached`, `notification_event.site_milestone_reached`; `document_due_on()` |
| 0093      | Rules: reached written once and only in position order; reached milestones fixed; releases append-only, voided once; a release's bill is a milestone bill of the same site; audit triggers; the `site_credit_accounts` audit (0070) re-created with the new columns. The 0092 enum values are not named in 0093     |

No data migration: no new permission, and existing sites stay on credit days.

| Table / change                                | Key columns                                                                                                                                                                                                                                                   | Rules                                                                                                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site_credit_accounts` (changed)              | add `terms` (`site_terms`: `credit_days` / `milestones`), `grace_days`, `longstop_days`, `milestone_basis` (`share` / `amount`)                                                                                                                               | `milestones` needs a schedule (API) and the basis set; ranges as §2.2. Audited                                                                                                                                                          |
| `site_milestones` (new)                       | `site_account_id`, `position` (1–10), `name`, `share_bps` or `amount_paise`, `trigger` (`manual` / `project_stage`), `stage`, `reached_on`, `reached_by_member_id`, `reached_source`, `note`, `undone_at`, `undone_by_member_id`, `undo_reason`, `created_by` | Position and name unique per site; exactly the column of the basis, none on the last; `stage` exactly with `project_stage`; reached and undone each written once (trigger); undone only with a reason; no deletes once reached. Audited |
| `site_milestone_releases` (new)               | `site_account_id`, `milestone_id`, `document_id`, `amount_paise` (> 0), `released_on`, `due_on`, `voided_at` (an undo)                                                                                                                                        | Append-only but for `voided_at`, once (trigger); composite keys keep the bill the site's party's and project's. Audited (insert, void)                                                                                                  |
| `tax_documents` (changed)                     | add `milestone_site_account_id`                                                                                                                                                                                                                               | Written in the issuing update like `credit_check`, then fixed by `tax_documents_immutable` (0055); the issued `due_on` is never rewritten                                                                                               |
| `message_template_key` / `notification_event` | add `milestone_reached` / `site_milestone_reached`                                                                                                                                                                                                            | `DEFAULT_TEMPLATES` in en / hi / te; variables `site`, `milestone`, `amount`, `dueOn`, `payLink` (MSG-5: no address, no GSTIN; [PO-141])                                                                                                |

---

## 4. Effects on the credit and receivables rules

| #     | Rule                                                                                                                                                                                                                                                                                             | Checked by                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| MT-1  | **Exposure does not change.** Milestones move when money is due, not how much is owed: §4.1's exposure (balance + open postpaid orders) and the site's (§3.3) count milestone bills in full. The limit is the only guard on a site whose milestone never comes, so [PO-137]                      | `credit.int.test.ts`: exposure equal with and without           |
| MT-2  | **Overdue days** (§4.1) take `min(effective due)` of open bills: `openDocumentsOf` returns `document_due_on(d.id, today)` as its `due_on`, so `exposuresOf`, `checkCredit`'s overdue block at confirm and issue (§4.2) and the site check read it with no other change                           | Integration: released part past due blocks, unreleased does not |
| MT-3  | **Ageing** (`ageReceivables`): a milestone bill is split into its parts, each in the bucket of its own due date; parts as of `asOf` count only releases made by then. Σ buckets − advance = balance still holds (parts sum to outstanding); the property test gains random releases              | `ageing.test.ts` property test; `receivables.int.test.ts`       |
| MT-4  | **Site view** (`site-accounts.service.ts`, today `coalesce(d.due_on, d.issued_on)`) and the site filter of `GET /receivables/ageing` use the same parts; `site-agreement.int.test.ts` keeps both equal                                                                                           | `site-agreement.int.test.ts`                                    |
| MT-5  | **Nightly hold** (`holdOverdue`, `credit-holds.ts`) uses `openDocumentsOf`, so a bill whose milestone is not reached is never what holds a contractor; an overdue release does, after `hold_after_overdue_days`, as any bill. The hold stays party-wide ([PO-138])                               | `credit-holds.int.test.ts`                                      |
| MT-6  | **Dispatch hold** (PR #67, `assertNotHeldForDispatch`): no code change; it reads the party's and the site's hold status, which MT-5 now sets only for real overdue money. A site whose released money is unpaid still dispatches until a hold is placed ([PO-139])                               | PR #67's tests, plus one milestone case                         |
| MT-7  | **Statements** (`statements.service.ts`, `render-statement-pdf.ts`): entries and balances unchanged (ledger); the open bills list shows each milestone bill's effective due date, the due part and "rest on Final coat, latest by 30 Dec" (labels en / hi / te)                                  | Statement view-model unit test                                  |
| MT-8  | **Reports**: `receivables-open-bills` adds milestone, released, due part and long-stop columns; `receivables-ageing` follows MT-3; the dashboard's due today / this week count release due dates. Sales reports and brand profitability's credit cost (from invoice date, [PO-84]) are unchanged | `receivables-reports` tests                                     |
| MT-9  | **Payment links** (`overdue` purpose, PL-2) take the parts past due, not whole bills; `invoice` and `outstanding` unchanged                                                                                                                                                                      | `planPaymentLink` tests                                         |
| MT-10 | **Invoice print** (`invoice-view.ts`): a milestone bill prints "Payable on completion of the site's milestones, latest by {long-stop}" instead of a bare due date                                                                                                                                | Print view-model test                                           |

---

## 5. Nudges

| #     | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                   | Checked by                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| MT-11 | **Milestone notice.** Reaching a milestone that releases money queues `milestone_reached` to the contractor (the site account's party) with `queueMessage` in the same transaction (MSG-7): "Primer coat is done at Sharma residence: ₹24,000 is now due, by 15 Nov." with a UPI link for the released parts (PL-12, message validity PL-19). `dedupe_key` `milestone:<milestone id>:<channel>`, so an undo and redo never sends twice | Outbox integration test   |
| MT-12 | Channels: those of the business's active reminder schedule with the smallest offset ≥ 0; no such schedule, no notice (as "no rows = no reminders"). Consent (MSG-1) and messaging hours (MSG-6, the worker holds it till 09:00) as every message. Never the project's customer (the homeowner): it is the contractor's debt ([PO-140])                                                                                                 | Job / outbox tests        |
| MT-13 | **Reminders** (CO-6, `queueReminders`): `d.due_on = today − offset` becomes "a part of d whose due date is today − offset is still unpaid", and the amount is the bill's parts due by then, not its whole outstanding. So a −3 schedule says "due in 3 days" inside the grace period and +7 chases a missed milestone payment. CO-7 (open promise) applies                                                                             | `collections.int.test.ts` |
| MT-14 | **Staff.** `site_milestone_reached` in the app to the party's salesperson (`customer_profiles.assigned_member_id`) and the project's `assigned_member_id`, never the member who acted                                                                                                                                                                                                                                                  | Notifier test             |
| MT-15 | **Milestones to confirm.** The collections worklist (CO-1) lists sites with milestone bills older than 30 days and nothing released, with "Mark reached", so the shop asks the contractor instead of waiting for the long-stop ([PO-142])                                                                                                                                                                                              | `compareWorklist` test    |

---

## 6. Permissions and audit

| Action                                                       | Permission                                                                                                   | Audit                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| See terms, schedule, releases                                | `credit:read` (site view), `receivables:read` (worklist)                                                     | —                                                                              |
| Set terms, grace, long-stop; edit unreached milestones       | `credit:approve` (as the site limit, §5.1)                                                                   | `site_credit_accounts`, `site_milestones` triggers                             |
| Mark reached (today, or back-dated up to 7 days, [PO-143])   | `credit:manage` at the site's store (Branch Manager, Sales and CRM Executives); it only brings money forward | Member, date, source and note on the milestone; releases audited               |
| Reached by a project stage move                              | `projects:manage` (the stage move); recorded `project_stage` with that member                                | `projects` has no audit trigger, so the milestone row is the record            |
| Undo a reached milestone (with a reason; voids its releases) | `credit:approve`, never the member who marked it ([PO-144])                                                  | `undone_*` and `voided_at` written once; notices already sent are not recalled |

`POST …/reach` takes an `Idempotency-Key`; the site account row is locked (`for update`) so two
reaches cannot release twice.

---

## 7. API and screens

| Method and path                                         | Body / returns                                                                                                                                                            | Permission        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `GET /site-accounts/:id` (changed)                      | Adds terms, schedule with reached state, releases, due now, not due, next milestone                                                                                       | `credit:read`     |
| `PUT /site-accounts/:id/terms`                          | `{terms, graceDays, longstopDays, basis, milestones: [{id?, name, sharePercent \| amountPaise, trigger, stage?}]}`; 409 `milestone_reached` when a reached one is changed | `credit:approve`  |
| `POST /site-accounts/:id/milestones/:milestoneId/reach` | `{reachedOn?, note?}` → site view with the new releases                                                                                                                   | `credit:manage`   |
| `POST /site-accounts/:id/milestones/:milestoneId/undo`  | `{reason}`; only the latest reached milestone                                                                                                                             | `credit:approve`  |
| `POST /projects/:id/stage` (changed)                    | Reaches linked milestones of every site on the project in the same transaction                                                                                            | `projects:manage` |

Shares are entered as percentages with up to two decimals and stored as basis points.

| Screen                    | Behaviour                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Site account              | Terms card; milestone strip (reached / next / later) with released, paid, due and "Mark reached"; edit schedule for approvers |
| Invoice issue, order bill | "Due on milestone: Primer coat (latest by 30 Dec)" in place of the credit-days date                                           |
| Customer 360, receivables | Milestone bills show the due part and "on milestone" for the rest                                                             |
| Collections worklist      | "Milestones to confirm" group (MT-15)                                                                                         |

---

## 8. Build plan

Each slice ships its unit and integration tests and passes `pnpm verify` (CLAUDE.md); only slice
A adds migrations.

| Slice | Contents                                                                                                                                                                                | Depends on        |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| A     | Migrations 0092–0093; `@paint/shared` pure rules: schedule validation, `planMilestoneRelease`, `documentParts` (with the §2.5 example as a test); `document_due_on()` and its SQL tests | —                 |
| B     | Terms and schedule API; due date at issue (`order-invoicing.ts`, `invoice-issue.service.ts`); reach / undo; project stage and cancel hook                                               | A                 |
| C     | One effective due date: `openDocumentsOf`, site view, `ageReceivables`, statements, reports, payment links (MT-1 – MT-10); site agreement and ageing invariant tests                    | A, B              |
| D     | Nudges: template and notice, reminders on parts, staff notice, worklist group (MT-11 – MT-15)                                                                                           | C                 |
| E     | Web: site terms and milestone strip, issue dialog text, print line; demo seed (`apps/api/src/demo`) gains one milestone site                                                            | B (C for figures) |

PR #67 should merge before slice C, which touches its tests.

---

## 9. Open questions

### For the product owner (Manpreet)

| #      | Question                                                                                                                                                                          | Default if unanswered                           |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| PO-130 | Long-stop: every milestone bill falls due this many days after issue even if its milestone never comes. How long?                                                                 | 90 days, per site (1–365)                       |
| PO-131 | Grace after a milestone is reached, before the released money is due?                                                                                                             | 7 days, per site                                |
| PO-132 | Should the share be of the site's actual billing (as designed) or of the project's estimate (`expected_order_value_paise`)? Actual billing can never ask for more than was billed | Actual billing                                  |
| PO-133 | A bill issued after the last milestone is reached (touch-up): ordinary credit days, or due at once?                                                                               | Credit days                                     |
| PO-134 | A cancelled project: is everything still undue then due (cancel date + grace)?                                                                                                    | Yes                                             |
| PO-135 | A credit note on a milestone bill shrinks what is not yet due first (the contractor's favour). Or should it pay off what is already due, as a payment does?                       | Not yet due first                               |
| PO-136 | Payments the staff allocate to a newer bill leave an older released part unpaid. Compute what is due per site instead of per bill (more work in ageing and links)?                | Per bill; oldest-first allocation makes it rare |
| PO-137 | Should a milestone site need its own limit lower than the contractor's, since overdue never protects the shop until the long-stop?                                                | No extra rule; the site limit as today          |
| PO-138 | An overdue milestone release holds the contractor everywhere (today's party-wide hold). Hold only that site instead?                                                              | Party-wide, as today                            |
| PO-139 | Should dispatch to a site stop as soon as a released part is past due, before any hold?                                                                                           | No: only holds stop dispatch (PR #67)           |
| PO-140 | Should the project's customer (the homeowner) ever be told a milestone was reached?                                                                                               | Never                                           |
| PO-141 | May the message name the site (`projects.name`, e.g. "Sharma residence")? Site names may contain a person's name or address                                                       | Yes, the name only                              |
| PO-142 | "Milestones to confirm": after how many days without a release does a site appear?                                                                                                | 30 days from the oldest milestone bill          |
| PO-143 | May a milestone be back-dated, which can make money overdue at once?                                                                                                              | Up to 7 days                                    |
| PO-144 | May the member who marked a milestone undo it?                                                                                                                                    | No: an approver                                 |

### For Kamaljeet (how shops and contractors work)

| #      | Question                                                                                                                                                   | Default if unanswered            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| PO-145 | What milestones and splits do contractors actually agree with their clients (putty / primer / final, 30-30-40)? Should a business keep a default schedule? | Typed per site; no default yet   |
| PO-146 | Who tells the shop a stage is done: the contractor, the salesperson on site, or the shop asks? Is the salesperson's word enough, or is a photo wanted?     | The salesperson marks it; a note |
| PO-147 | Does a contractor pay the shop the same share their client paid them, or everything billed so far?                                                         | The same share (the design)      |
| PO-148 | Are site bills one per delivery (many per site), and does one contractor run several sites with you at once?                                               | Many bills, several sites        |

### For the CA

| #      | Question                                                                                                                                                                                                                                     | Section |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| CA-120 | Milestone terms change only when payment is due, not GST's time of supply (the invoice). Where the shop is a micro or small enterprise, does a long-stop beyond 45 days matter (MSMED Act s.15, Income-tax s.43B(h) for a contractor buyer)? | §2.3    |

[PO-1]: credit-and-receivables.md#8-open-questions
[PO-6]: credit-and-receivables.md#8-open-questions
[PO-84]: credit-and-receivables.md#8-open-questions
[PO-130]: #9-open-questions
[PO-131]: #9-open-questions
[PO-133]: #9-open-questions
[PO-134]: #9-open-questions
[PO-135]: #9-open-questions
[PO-136]: #9-open-questions
[PO-137]: #9-open-questions
[PO-138]: #9-open-questions
[PO-139]: #9-open-questions
[PO-140]: #9-open-questions
[PO-141]: #9-open-questions
[PO-142]: #9-open-questions
[PO-143]: #9-open-questions
[PO-144]: #9-open-questions
[PO-148]: #9-open-questions
[CA-120]: #for-the-ca

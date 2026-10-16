# Receivables, ageing and statements (MVP 3, session 1b)

|           |                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------ |
| Modules   | P2-M10 Receivables & Ageing, P2-M12 Customer Ledger & Statements (roadmap Release 2.1)           |
| Builds on | [sell-and-bill.md](../mvp-2/sell-and-bill.md) §1.3, §4.6, §5.4 and [print.md](../mvp-2/print.md) |
| Schema    | None: ageing and statements are queries over the 2.0 books (no migration)                        |

## The rule

Spec §4.6 says, for every party:

```text
balance             = Σ party_ledger = party_balances.balance_paise
outstanding(d)      = total(d) − Σ allocations to d      (invoice, bill of supply, debit note, opening, charge)
Σ outstanding(d) − party_balances.advance_paise = balance
```

So the buckets hold what is outstanding on bills, money paid ahead (advances, unused credit
notes) is shown beside them, and **Σ buckets − paid ahead = balance**, i.e. Σ buckets =
balance + advance. An integration test checks this for every party of a business with
invoices, part payments, a bounced cheque with a charge, a refund, a credit note and an
opening balance (`apps/api/src/receivables/receivables.int.test.ts`).

## The engine (`packages/shared/src/receivables`)

| Input               | From                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Receivable (owed)   | Issued or cancelled invoices, bills of supply, debit notes (`total_paise`, `issued_on`, `due_on`); ledger `opening` and positive `adjustment` (charges) entries |
| Credit (paid ahead) | Payments in (`received_on`, voided on `cheque_bounced_on`); credit notes                                                                                        |
| Allocation, dated   | Every `allocations` row, on the later of its two ends' ledger dates; an undo also no earlier than the day it was undone, a bounce on the bounce date            |
| Due date            | `due_on`, else the day raised; an opening balance from `credit_profiles.opening_overdue_since` when set                                                         |

Because no allocation is dated before either of its ends, the same rows age **as of any day**
and still match the ledger summed to that day: a property test builds random books (invoices,
cancellations, payments, bounces with charges, credit notes, refunds) and checks every day.

Buckets count days past the due date on the as-of day: **not yet due** (due date after it),
**0–30** (0 = due that day), **31–60**, **61–90**, **over 90**. "Overdue" on the dashboard is 1
day or more; "due this week" is the as-of day and the six after it.

## API and screens

| Piece                                                  | Permission         | Notes                                                                                                                                                                                      |
| ------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /receivables/summary`                             | `receivables:read` | Total outstanding, paid ahead, due today / this week, overdue, credit used, top 5                                                                                                          |
| `GET /receivables/ageing`                              | `receivables:read` | By customer, salesperson (`customer_profiles.assigned_member_id`) or store; `projectId` ages one site's bills only (no openings, charges or advances), as its site account does (round 4b) |
| Reports `receivables-ageing`, `receivables-open-bills` | `receivables:read` | CSV through the reports framework, which now takes computed reports                                                                                                                        |
| `GET /parties/:id/statement` and `.pdf`                | `sales:read`       | As the party ledger; opening, entries, closing, ageing and bills due on the last day                                                                                                       |
| `/receivables`, dashboard tile                         | `receivables:read` | Customer rows link to the ledger and the statement; salesperson and store rows narrow                                                                                                      |
| `/parties/:id/statement`                               | `sales:read`       | A4 preview, print, PDF, Share on WhatsApp                                                                                                                                                  |

Store scope: members not at every store see the parties they may see (`canSeeParty`: no home
store, or one of theirs) with their whole balances; a store filter limits bills and payments
to that store, refused (404) for a store the member does not work at.

The statement follows the invoice print pattern: a pure view model
(`buildStatementView`), labels in en / hi / te in `@paint/shared` (dates are printed beside a
label, never inside a translation, as the script fonts have no Latin letters), an A4 React
template (`apps/web/src/print/StatementA4.tsx`) and a pdfkit PDF
(`apps/api/src/print/render-statement-pdf.ts`).

**Two clicks:** the customer record (or the ledger, or a receivables row) has **Statement**;
the statement opens on this financial year to today in the member's language, and **Share
on WhatsApp** is a `wa.me` link with the message in the statement's language that also saves
the PDF to attach. A link opens WhatsApp without a pop-up to block.

## Later

- ~~Signed, expiring public statement link~~ and ~~`receivables:read`~~: built in round 2a as a
  stored, revocable link (`statement_links`, `GET /public/statements/:token`) and migration 0076;
  see [credit-and-receivables.md](credit-and-receivables.md) §6.4. Until round 2a the permissions
  in the table above were `credit:read`.
- Web Share API (share the PDF file straight into WhatsApp on phones).

# Sales basics for owners (MVP 3 round 7b)

The dashboard's sales tile, the core sales reports, collections by payment mode and the GST
summary. Everything here reads the documents already issued; nothing new is stored and there
are no migrations.

## 1. What a sale is

One definition is used by every report below and by the dashboard tile
(`apps/api/src/reports/sales-basis.ts`):

- **Counts:** issued tax invoices, bills of supply and debit notes add; issued credit notes take
  away.
- **Date:** each document counts on its own issue date, an India-time day. A credit note issued
  in November against an October invoice lowers November's sales, as it does in GST and in
  Tally.
- **Left out:** drafts, and cancelled documents of any kind. A cancelled invoice is as if it
  had never been issued; it is not shown as a sale and a reversal.
- **Values:** taken from the document lines as issued, so the report by product adds up exactly
  to the report by day or by store. Bill discounts are already spread over the lines.
  Round-off belongs to no line and is left out.
- **Net sales** is the taxable value: GST excluded. This is the headline figure everywhere.
  **Net sales with GST** adds CGST, SGST, IGST and cess, before round-off. Both are shown.
- **Bills** counts invoices and bills of supply. Notes are not bills.
- **Average bill** is the bills' own taxable value divided by their number, before any note.
  For example, one ₹10,000 bill with a ₹1,000 credit note has an average bill of ₹10,000, not
  ₹9,000.
- **Quantity (net):**
  - bills add the packs they sold;
  - credit notes for goods returned (a sales return) take them back;
  - value-only credit notes (discount, overcharge) and debit notes move no quantity.
- **Litres (net):** quantity × pack size for packs sold in litres or millilitres. Other units
  (kg, pieces) show no litres.
- **B2B / B2C:** B2B when the buyer gave a GSTIN (the document's GSTR-1 class `b2b`); B2C
  covers B2C large and small.
- **Composition stores** issue bills of supply. They count as sales, with no tax, and are a
  separate section of the GST summary.

## 2. Dashboard sales tile

`GET /dashboard/sales?storeId=` (permission `sales:read`), shown at the top of the dashboard.
It follows the dashboard's store picker. Members see only their own stores; a store that is not
theirs answers 404.

| Period | Range            | Compared with                                            |
| ------ | ---------------- | -------------------------------------------------------- |
| Today  | today            | yesterday                                                |
| Week   | Monday to today  | the previous Monday to the same weekday                  |
| Month  | the 1st to today | last month's 1st to the same date (its last day at most) |

For each period the tile shows:

- net sales;
- net sales with GST;
- the number of bills and the average bill;
- the change in net sales as a percentage.

When the earlier period had no sales, the tile shows no percentage.

Each period's figure opens **Sales by day** for its dates. Below the periods, 14 bars show the
last 14 days of net sales. Screen readers get the same as a table. The tile reads the
documents' totals in one query of one row per day.

## 3. Sales reports

All of these are in the reports framework (`GET /reports/:kind`): a table on screen and the
whole report as CSV. They are under "Sales and GST" on the reports page.

They share these filters:

- dates (`from`, `to`);
- store;
- document kind;
- B2B / B2C;
- customer type;
- salesperson, meaning the member who issued the bill;
- the customer's salesperson, meaning the member assigned to the customer;
- brand, category, and product name or SKU (free text).

They also share these columns:

- bills;
- credit notes;
- net sales;
- GST;
- net sales with GST;
- average bill.

Reports by product, brand and category show no average bill. They add units and litres
instead.

| Report                 | One row per                     | Notes                                                                                                       |
| ---------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `sales-by-period`      | day, week or month (`interval`) | Newest first. Weeks start on Monday.                                                                        |
| `sales-by-store`       | store                           | With the store's GSTIN and its share of net sales.                                                          |
| `sales-by-product`     | pack (variant)                  | SKU, brand, product, size, category, net quantity and litres.                                               |
| `sales-by-brand`       | brand                           | Packs sold, net quantity and litres, share.                                                                 |
| `sales-by-category`    | product category                | Uncategorised products show as one row with no category.                                                    |
| `sales-by-salesperson` | member who issued the bill      | A note counts against whoever issued the note. Also shows how many customers each person billed.            |
| `sales-by-customer`    | customer                        | Top customers first, with mobile, type, GSTIN and last bill date. Walk-in sales are the walk-in customer's. |
| `payments-by-mode`     | day × store × payment mode      | See §4.                                                                                                     |

**Salesperson:** the main definition is the member who issued the bill
(`issued_by_member_id`). It is known for every document and does not change if the customer is
later reassigned. The customer's assigned salesperson (`customer_profiles.assigned_member_id`)
is available as a filter. Receivables ageing groups by the assigned salesperson; see [PO-120].

**Cross-report identities** (tested in `sales-book.int.test.ts`): for any filters, Σ by store =
Σ by day = Σ by product = Σ by brand = Σ by customer = Σ by salesperson. Over the month's
dates, each equals the dashboard's month figure.

## 4. Collections by payment mode

`payments-by-mode` shows one row per day, store and payment mode. The modes are cash, UPI, card,
bank transfer, cheque, UPI link and the business's own modes. It counts money the way the day
end counts it:

- **Received:** every payment in, on the day it was received. A cheque that later bounced is
  still counted, as the day end and the Tally receipt count it.
- **Of which at a counter:** the part taken in a register session. For a store and day with one
  session, these columns equal the session's mode totals (tested).
- **Refunded:** money paid back. **Net** is received less refunded.
- **Cheques bounced since:** the part of the day's cheques that has bounced since, shown beside
  the day it was received.

"Credit / on account" is not a payment mode: a bill sold on credit brings in no money. It shows
as outstanding in receivables ageing. See [PO-121].

## 5. GST summary

`gst-summary` and `gst-hsn-summary` (permission `accounting:export`: owners, admins and
accounting). This is a **summary, not a GSTR-1 filing export**; the filing export is
Release 2.3.

- It covers one row per our GSTIN, supply section, GST rate, cess rate, B2B / B2C and intra- or
  inter-state.
- **Sections** come from each line's GST nature as issued. Exempt is kept apart from nil-rated,
  as MVP 2 decided:
  - taxable;
  - nil-rated;
  - exempt;
  - non-GST;
  - bill of supply (composition).
- Credit notes are netted and debit notes added, on their own issue dates.
- Columns:
  - taxable value;
  - CGST, SGST / UTGST, IGST and cess;
  - total tax;
  - number of documents, and how many of them were credit notes.
- The **HSN view** shows one row per GSTIN, HSN code, unit (UQC), section and rate, with net
  quantity and total value.

**Reconciliation** (tested in `sales-book.int.test.ts`): over a period, the summary's taxable
value, CGST, SGST, IGST and cess equal two other totals:

- the issued documents' own totals;
- the Tally export of the same period. That is the sales and composition-sales ledgers, and the
  output CGST, SGST, IGST and cess ledgers, each credit less debit. It holds rate by rate too.

## 6. Permissions

| What                                           | Permission          | Who has it by default                                         |
| ---------------------------------------------- | ------------------- | ------------------------------------------------------------- |
| Sales tile, sales reports, collections by mode | `sales:read`        | owner, admin, branch manager, sales executive, store employee |
| GST summary and HSN view                       | `accounting:export` | owner, admin                                                  |

The sales reports show sales value only: no cost and no margin. Margins stay in brand
profitability, behind its own permission. Every report keeps a member to their own stores.
Store employees see collections because they run the register.

## 7. Performance

Each report is one grouped query over the period's document lines, plus its count. The tile is
one query. `brand-money-scale.int.test.ts` runs them over about 10,000 invoices and 30,000
lines. A year must run the same number of queries as a quarter, within generous time limits.
See `docs/performance.md`, "Sales reports (round 7b)".

## 8. Open questions

| #      | Question                                                                                                                                                                                                                          | Assumed for now                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| PO-120 | Should "sales by salesperson" credit the member who issued the bill, or the salesperson assigned to the customer (as receivables ageing does)? A counter employee issues many bills for customers a field salesperson brought in. | The member who issued the bill; the customer's salesperson is a filter. |
| PO-121 | Owners asked for "credit / on account" beside cash and UPI. Show it in collections as the part of each day's bills not paid that day, or leave it to receivables?                                                                 | Collections show money only; credit sales are in receivables.           |
| PO-122 | The headline is net sales before GST. Some owners think in bill totals with GST. Keep before-GST as the headline, with GST shown below it?                                                                                        | Before GST is the headline; the figure with GST is shown under it.      |
| PO-123 | Average bill counts the bills' own value, before credit notes. Should it be net of notes instead?                                                                                                                                 | Before notes, so one return does not make a day's bills look smaller.   |
| PO-124 | Weeks start on Monday. Do pilot shops count weeks from Sunday, or from their weekly holiday?                                                                                                                                      | Monday.                                                                 |

### For the CA

| #      | Question                                                                                                                                                                                                                         | Where |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| CA-110 | The GST summary nets credit notes in the period they were issued, not in the period of the invoice. Is that the view you want to compare with GSTR-1 and GSTR-3B? GSTR-1 reports notes in their own period, so we believe it is. | §5    |
| CA-111 | Bills of supply from a composition store are shown as a separate section with no tax. Is that enough for the CMP-08 turnover, or do you also want them by rate of composition tax?                                               | §5    |
| CA-112 | B2C large and B2C small are shown together as B2C, split only by intra- or inter-state. Do you need B2CL apart here, before the GSTR-1 export of Release 2.3?                                                                    | §5    |

[PO-120]: #8-open-questions
[PO-121]: #8-open-questions

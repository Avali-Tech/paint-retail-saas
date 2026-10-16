# Pilot checklist: taking a shop live on Release 2.1

A working list for the first pilot shops on Release 2.1 (MVP 1–3). Every item names what is
built today. Open questions are in [credit-and-receivables.md §8](credit-and-receivables.md#8-open-questions);
the defaults below apply until they are answered.

## 0. Before anything else

- [ ] The environment is deployed by the [deploy runbook](../runbooks/deploy.md); a restore was
      rehearsed ([restore runbook](../runbooks/restore.md)); alarms reach someone
      ([incident runbook](../runbooks/incident.md)).
- [ ] Providers in production (see [environment-variables.md](../environment-variables.md)):
  - `MESSAGING_PROVIDER` and `SMS_PROVIDER` are `disabled` in production (`log` is refused). No
    WhatsApp BSP is chosen yet ([PO-1]), so **reminders go by email only** (`EMAIL_PROVIDER=smtp`)
    and statements are shared with `wa.me` links from staff's own phones ([PO-103]).
  - `PAYMENT_LINK_PROVIDER=razorpay` with `GATEWAY_CREDENTIALS_KEY` set, or `disabled` if the shop
    takes no UPI links in the pilot.
  - `SUBSCRIPTION_GATEWAY=manual` (we invoice by hand), with `PLATFORM_*` GST details and our bank
    account set.
  - `PUBLIC_API_URL` is the public address (statement links use it); `WORKER_INTERVAL_SECONDS` is
    not `0` (the nightly jobs and reminders run in the worker).
- [ ] The business exists (sign-up or platform console) and its subscription is set
      (**Platform → tenant**: trial, or a plan applied by an operator; [subscriptions.md](subscriptions.md)).

## 1. Data, in this order

Imports are at **Imports** (`/imports`): download the template, upload, check the preview, apply.

1. [ ] **Stores** on **Settings → Stores** (`/settings/stores`, `stores:manage`, [PO-102]): name,
       code (up to 5 letters or digits, printed on document numbers, never changed), kind, and the
       GST registration, state and address in the same step (also editable later, here or on
       `/settings/tax`). Close a store there rather than deleting it; reopening counts against the
       plan. Then **tax categories and rates** (`/tax-categories`) and **team** with roles and
       stores (`/team`; owners and admins work at every store). Invoice series follow each store's
       GSTIN and are set up with its first document.
2. [ ] **Products** import (`products`): brand, product, type, HSN, SKU, pack size and unit
       (litres matter: schemes and painter points count millilitres), category, tax category, MRP,
       selling price, barcodes. Brands and categories are created as named — check spellings,
       since brand schemes and profitability group by brand.
3. [ ] **Parties** import (`parties`): name and roles first; phone or GSTIN is how later imports
       find a party. Optional **`credit_limit`** (₹) and **`credit_days`** (0–365) give customers
       credit, for owners and admins (credit approvers) only, recorded in the audit log ([PO-101]).
       A first limit needs both; blank cells keep what is saved; importing again updates the
       terms; a waiting credit request must be decided first.
4. [ ] **Opening stock** import (`opening-stock`): store code, SKU, quantity **and unit cost**.
       Without a cost, profitability counts those units at zero and lists them as uncosted.
5. [ ] **Opening balances** import (`opening-balances`): phone or GSTIN, amount owed on the go-live
       day, and **`overdue_since`** where part of it is already late. A balance without it is aged
       from go-live by receivables but treated as current by the credit check and reminders
       ([CA-7], [CA-40]). Re-importing replaces a party's figures until go-live.
6. [ ] **Billing go-live** on **Settings → Billing go-live** (`/settings/go-live`, owners and
       admins, [PO-100]): pick the date (today or earlier), check every opening against the old
       books, correct or add one there if needed (an overdue date can be cleared), review the
       totals, tick that they were checked and go live. It cannot be undone. From then on
       exposure, overdue days and ageing come from the ledger, and the screen shows what was
       posted.
7. [ ] Supplier products and last costs come in with GRNs; enter open purchase orders by hand.

## 2. Settings

### 2.1 Credit (P2-M09)

- [ ] **Settings → Credit rules** (`/settings/credit`, owners and admins): sell normally up to
      **80 %** of the limit, manager approves up to **100 %**, owner above; block credit after
      **30 days** overdue. Agree these with the owner.
- [ ] Per customer, on the customer 360 credit panel (`credit:manage`): credit limit and credit days,
      risk, and site accounts with their own limits for contractors (`/parties/:id`).
- [ ] Who approves: managers and owners see **Credit → Approvals** (`/credit/approvals`). Branch
      managers approve across stores today ([PO-8]); self-approval follows [PO-3].
- [ ] The automatic hold runs nightly; a release may waive overdue days for up to **90 days**
      ([PO-11]).

### 2.2 Collections, reminders and consent (P2-M11, P2-M32)

- [ ] **Collections → Reminder schedule** (`/collections/reminders`): start from the suggested
      schedule (**3 days before, on the due date, 7, 15 and 30 days after**) and pick channels.
      Messages go out only between 9 am and 8 pm India time.
- [ ] **Consent**: record each customer's choice per channel on the customer 360 (**Messages and
      consent → Record consent**), reading the notice in their language. No consent, no reminder
      ([CA-3]).
- [ ] Assign each credit customer a salesperson, so the worklist filters "mine" work.

### 2.3 UPI payment links (P2-M32)

- [ ] Rehearse first on a staging business with `PAYMENT_LINK_PROVIDER=log`: send a link from the
      worklist, pay it on `/pay/:reference`, see it allocated by itself.
- [ ] **Settings → Payment link settings** (`/settings/payment-links`, owners and admins): connect
      the shop's own Razorpay account (live keys after KYC), add the webhook address shown there with
      the five events, **Test connection** ([payment-links.md §1](payment-links.md#1-how-a-shop-connects-razorpay)).
- [ ] Rules on the same screen: how long counter links stay payable (10 minutes by default), how
      long links sent in messages stay payable (a day by default, [PO-61]), the most one link asks
      for, and net of advance vs full outstanding. With Razorpay neither validity may be under
      15 minutes: connecting raises a shorter one and says so ([PO-60]).
- [ ] Pay one small live link end to end, then refund it, before telling customers.

### 2.4 Subscription (P2-M08)

- [ ] The owner sees **Settings → Billing** (`/settings/billing`). Renewal invoices are raised
      7 days before the period ends; an operator records the payment in the platform console.
      Prices are placeholders ([PO-22]); TDS deducted by the shop is settled short ([CA-8]).

### 2.5 Brand schemes and profitability (P2-M33, P2-M35)

- [ ] Grant `schemes:manage` only to who enters schemes (owners and admins have it).
- [ ] **Purchasing → Brand schemes → New** (`/brand-schemes/new`): one scheme per brand circular —
      period, products or categories, target in value or litres, slab mode (retro default,
      [PO-30]), slabs and benefits, **settlement days** (claim due date, [PO-32]) and **date basis**
      (GRN date by default, or supplier invoice date, [CA-21], [CA-62]). Activate it.
- [ ] Enter GRNs on time with the supplier invoice date and scheme-free units — progress counts
      GRN lines only.
- [ ] **Reports → Brand profitability** (`/reports/brand-profitability`, `accounting:export` today,
      [PO-80]): set **cost of money** (default 12 %, [PO-5], [PO-83]) and **point value** (default
      ₹1, [PO-81]).
- [ ] **Purchasing → Brand statements → Statement templates** (`/brand-statements/templates`,
      `schemes:manage`, [PO-90]): one template per distributor, its column headings copied from a
      statement exported from the brand portal (CSV or Excel; PDF is not read, [PO-91]), the
      date format, the words for credit notes and payments, the brand of its scheme credit notes,
      the date window and amount tolerance, and whether GRNs compare with GST ([PO-94]).
- [ ] Each month: **Upload a statement**, **Check the file**, **Import and match**; then on the
      reconciliation settle what is left: match by hand, explain (our payments show as not
      tracked until P2-M17, [PO-92]), or record an unrecorded scheme credit note in one step.
      Download the mismatches for the distributor. Keep ClamAV and storage up so the original
      file is kept ([PO-93]).

### 2.6 Loyalty and painter points (P2-M36)

- [ ] **Settings → Loyalty** (`/settings/loyalty`) and **Settings → Painter points**
      (`/settings/painter-points`): earn rules (value or per litre, brand multipliers), validity.
      Rules are not versioned ([PO-20]); set them before go-live and change them rarely.

### 2.7 Statements

- [ ] Shared statement links live **7 days** and show the ledger as it stands when opened
      ([PO-4], [PO-15]); revoke from the customer 360. Check the statement wording ([CA-5]).

## 3. What the CA and accountant review before go-live

- [ ] The opening balances and the go-live preview against the old books; one opening per
      customer rather than bill by bill ([CA-90]); the rule for balances without `overdue_since`
      ([CA-7], [CA-40]).
- [ ] Ageing basis and allocation dating: due date ([CA-1]), allocation date ([CA-2]).
- [ ] Statement wording and language ([CA-5]); consent records for messages ([CA-3]).
- [ ] UPI receipts into a gateway clearing ledger and the fee ([CA-30]); overpaid links become
      advances with receipt vouchers ([CA-31]); gateway refunds' dating, failures and lost fees
      ([CA-50], [CA-51], [CA-52]).
- [ ] Brand money: scheme-free units and later free goods at zero cost ([CA-4], [CA-20], [CA-61]),
      rebates as credit notes vs payments ([CA-6], [CA-60]), slab dates ([CA-21], [CA-62]).
- [ ] Profitability: returns at average cost ([CA-70]), debit notes as sales and credit cost on
      outstanding including GST ([CA-71]).
- [ ] Our subscription invoices: SAC, 7-day advance invoicing, credit notes ([CA-9]), TDS ([CA-8]).
- [ ] The Tally export (`/accounting/export`, [tally.md](../mvp-2/tally.md)) imports cleanly into
      the shop's company, including payment-link receipts and refunds.

## 4. Day 1

- [ ] A credit invoice for a customer near the limit asks for approval; the approval appears in
      **Credit → Approvals** and the sale goes through once approved.
- [ ] A held customer is blocked; a release with a waiver lets them buy within the limit.
- [ ] A payment link sent from the worklist is paid and allocated with no manual entry; the bill
      drops off the worklist and the customer's balance falls by the amount.
- [ ] A customer's statement closing balance equals the ledger balance and the receivables row.
- [ ] Next morning: **Accounting → Reconciliation** (`/accounting/reconciliation`) shows last night's
      run with **no findings**; the hold job ran; today's reminders were queued (worklist,
      customer 360 messages) and emails sent.
- [ ] Promises recorded on the worklist appear on the customer 360.

## 5. Week 1

- [ ] **Receivables** (`/receivables`) total equals Σ customer balances; spot-check five customers'
      ageing against their ledgers; the open-bills CSV opens in Excel.
- [ ] The collectors use the worklist daily; promises are kept or broken by the daily run, and a
      broken one escalates.
- [ ] Payment links: every paid link is allocated; nothing waits in refunds; the day-end notice
      matches the gateway's settlement report.
- [ ] Each running scheme's progress matches the brand's own statement or portal; claims are filed
      for finished schemes.
- [ ] Brand profitability for the week or month looks sane to the owner (no large uncosted
      count; margins near what the owner expects).
- [ ] Reconciliation clean every night; no worker errors in the logs; a backup restored to a scratch
      database checks out.
- [ ] Collect the owner's and CA's answers to the open questions above and record them in §8.

[PO-1]: credit-and-receivables.md#8-open-questions
[PO-3]: credit-and-receivables.md#8-open-questions
[PO-4]: credit-and-receivables.md#8-open-questions
[PO-5]: credit-and-receivables.md#8-open-questions
[PO-8]: credit-and-receivables.md#8-open-questions
[PO-11]: credit-and-receivables.md#8-open-questions
[PO-15]: credit-and-receivables.md#8-open-questions
[PO-20]: credit-and-receivables.md#8-open-questions
[PO-22]: credit-and-receivables.md#8-open-questions
[PO-30]: credit-and-receivables.md#8-open-questions
[PO-32]: credit-and-receivables.md#8-open-questions
[PO-41]: credit-and-receivables.md#8-open-questions
[PO-61]: credit-and-receivables.md#8-open-questions
[PO-80]: credit-and-receivables.md#8-open-questions
[PO-81]: credit-and-receivables.md#8-open-questions
[PO-83]: credit-and-receivables.md#8-open-questions
[PO-100]: credit-and-receivables.md#8-open-questions
[PO-101]: credit-and-receivables.md#8-open-questions
[PO-102]: credit-and-receivables.md#8-open-questions
[PO-103]: credit-and-receivables.md#8-open-questions
[CA-1]: credit-and-receivables.md#for-the-ca
[CA-2]: credit-and-receivables.md#for-the-ca
[CA-3]: credit-and-receivables.md#for-the-ca
[CA-4]: credit-and-receivables.md#for-the-ca
[CA-5]: credit-and-receivables.md#for-the-ca
[CA-6]: credit-and-receivables.md#for-the-ca
[CA-7]: credit-and-receivables.md#for-the-ca
[CA-8]: credit-and-receivables.md#for-the-ca
[CA-9]: credit-and-receivables.md#for-the-ca
[CA-20]: credit-and-receivables.md#for-the-ca
[CA-21]: credit-and-receivables.md#for-the-ca
[CA-30]: credit-and-receivables.md#for-the-ca
[CA-31]: credit-and-receivables.md#for-the-ca
[CA-40]: credit-and-receivables.md#for-the-ca
[CA-50]: credit-and-receivables.md#for-the-ca
[CA-51]: credit-and-receivables.md#for-the-ca
[CA-52]: credit-and-receivables.md#for-the-ca
[CA-60]: credit-and-receivables.md#for-the-ca
[CA-61]: credit-and-receivables.md#for-the-ca
[CA-62]: credit-and-receivables.md#for-the-ca
[CA-70]: credit-and-receivables.md#for-the-ca
[CA-71]: credit-and-receivables.md#for-the-ca
[CA-90]: credit-and-receivables.md#for-the-ca

# Navigation and UX: a short menu, a home per role, one inbox

**Goal:** a smooth, uncluttered app. Counter staff bill fast. Managers see what needs them. Owners
find any page without scanning a long list. Today an owner sees about 35 flat menu items, all at
the same level, and every role gets the same dashboard.

This spec records the product owner's approved direction. Step 1 (§5) is specified in full and
shipped first; step 2, the inbox, is recorded as built (§6), and step 3, the missing screens
(§8). The later steps (§7) are outlines with their open questions.

## 1. Targets

- A walk-in bill takes under 30 seconds, from any screen.
- Any daily task is at most 2 clicks away.
- Each role sees 7 or fewer top-level items, not counting Settings and "+ New sale".
- New counter staff are productive on day 1, without training on the back office.

## 2. Lessons from the market

| Product                              | What we take                                                        | What we avoid                      |
| ------------------------------------ | ------------------------------------------------------------------- | ---------------------------------- |
| Tally Prime                          | Keyboard first; "Go To" any screen by typing its name               | Screens that need training to find |
| Vyapar                               | Phone first; one big "+ Sale"                                       | —                                  |
| Marg, Busy, GoFrugal                 | The billing counter comes first                                     | Their crowded back-office menus    |
| Zoho                                 | The same list and record layout everywhere                          | —                                  |
| Odoo                                 | Area apps with sub-menus; Ctrl+K; features switched on per business | —                                  |
| Salesforce, HubSpot                  | The record is the hub; a "my tasks" home                            | —                                  |
| Dynamics Business Central, SAP Fiori | A home page per role (role centres)                                 | —                                  |

## 3. The seven layers

1. **Role home pages.** Each role starts on a page made for its work:
   - cashier: counter first (new sale, today's bills, the register);
   - sales rep: "My day" (follow-ups, quotations to chase, promises due);
   - branch manager: "Today at {store}" (sales, approvals, low stock, cash);
   - inventory manager: receipts due, transfers, counts, reorder;
   - owner: every store at a glance, with what needs a decision.
2. **A short main menu with tabs inside each entry.** About eight areas. Each area's pages are tabs
   at the top of the page (§5).
3. **One "Needs action" inbox** for every approval and pending decision: credit approvals,
   transfers, stock counts, credit requests, broken promises, low stock and plan requests. Approve
   inline. The menu shows a badge with the count.
4. **Records as hubs.** The customer page has tabs (overview, sales, payments, credit, loyalty,
   documents, activity) and one action bar: New sale · Quotation · Take payment · Statement ·
   Record promise. Product and supplier pages follow the same pattern.
5. **A Ctrl+K command palette.** It merges the `/` search, the two-key quick actions and "go to"
   any page by name.
6. **Features switched on per shop:** tinting, brand schemes, site accounts, painter points and
   brand statements. A shop that does not tint never sees tinting.
7. **One page template everywhere.**
   - Lists: search, filter chips, saved views, bulk actions and export.
   - Records: a status chip, ONE primary next-step button, and the rest under "…".
   - Forms: a single column; Enter moves to the next field.
   - Empty states say what the page is for and offer the first step.

## 4. Known dead ends to fix

- No screens for a payment on account, allocating a payment, clearing or bouncing a cheque, or a
  refund. **Built in step 3 (§8.1).**
- An issued invoice cannot be cancelled or reprinted from its page. **Built in step 3 (§8.2).**
- Message templates can only be changed through the API. **Built in step 3 (§8.3).**
- Store employees cannot sign in without SMS.
- No setup checklist screen. **Built in step 3 (§8.4).**
- One dashboard for every role.

## 5. Step 1: grouped menu, tabs, Settings hub, role-filtered menu

Front end only. No migrations, no API changes, and no changes to route guards.

### 5.1 Menu

The sidebar shows these entries, top to bottom. Each entry is a **section**. Its pages are
**tabs**.

| Section        | Tabs, in order                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| **+ New sale** | The counter (`/pos`). It is a prominent button at the top of the sidebar, not a plain item. Needs `billing:issue`.   |
| Home           | Dashboard (`/dashboard`) · Inbox (`/inbox`, step 2, §6)                                                              |
| Sales          | Quotations · Sales orders · Invoices · Credit & debit notes · Estimates                                              |
| Customers      | Customers · Leads · Opportunities · Projects · Follow-ups · Contracts · Credit approvals · Credit requests           |
| Money          | Receivables · Collections · Payments · Day end · Tally export · Payment links                                        |
| Stock          | Products · Balances · Transfers · Stock counts · Low stock · Reorder rules · Slow movers · Mistinted cans            |
| Buy            | Purchase orders · Goods receipts · Suppliers · Brand schemes · Scheme claims · Brand statements · Price-hike planner |
| Reports        | Reports · Brand profitability                                                                                        |
| **Settings**   | At the bottom of the sidebar. Opens the Settings hub (§5.3).                                                         |

Pages that live inside a tab keep their own small sub-navigation, because they are views of one
thing, not separate areas:

- Leads: list and pipeline board;
- Tally export: export, ledger mapping and reconciliation;
- Team & roles: members and roles.

### 5.2 Rules

- **URLs do not change.** Every existing route keeps its path, so bookmarks, e2e specs and docs
  keep working. The only new route is `/settings` (the hub).
- **A section link opens a tab.** It opens the tab last used in that section on this device, or
  the section's first visible tab. The last tab is kept in `localStorage`. If storage fails, the
  first tab is used.
- **Permissions.**
  - A tab shows only when the member's effective permissions allow it. That includes `AnyOf`
    lists, `alsoNeeds` (e.g. `costs:read`), and the member's own exceptions to their role (from
    `/auth/me`).
  - A section shows only when at least one of its tabs does.
  - Settings shows when any settings page does. Account security is for everyone, so Settings
    always shows.
  - Route guards are unchanged.
- **Active state.** The tab that owns the current address is the one with the longest matching
  path prefix. For example, `/brand-schemes/price-hike` belongs to the Price-hike planner, and
  `/brand-schemes/:id` belongs to Brand schemes. Deep record pages (`/invoices/:id`,
  `/parties/:id/statement`, `/site-accounts/:id`) highlight their section and tab. Tabs are links
  with `aria-current="page"`, not ARIA tabs, because each tab is its own route.
- **Tab bar.** It appears above the page when the section has two or more visible tabs. It scrolls
  sideways on a phone without making the page scroll sideways, and brings the current tab into
  view.
- **Phone.** The bottom bar shows Home · New sale · Customers · Stock · More. Any of these the
  member cannot see is filled by the next visible section. "More" lists the other sections, then
  Account security and Sign out.
- **Shortcuts.** `/` (search), the two-key quick actions (N C, N T …) and the G shortcuts are
  unchanged.
- **Badges.** Only the inbox's count, on Home and on the Inbox tab (step 2, §6).

### 5.3 Settings hub

`/settings` lists the settings pages the member may open, in groups. Each settings page shows a
"Settings" back link above its title instead of a tab bar.

| Group              | Pages                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| Business           | Stores · Tax & GST · Invoice print · Tinting · Appearance · Stock alerts and transfers · Billing go-live |
| Team & access      | Team & roles · Support access · Account security                                                         |
| Customers & credit | Credit rules · Loyalty programme · Painter points rules                                                  |
| Money              | Payment link settings · Subscription                                                                     |
| Data               | Import data · Documents                                                                                  |

### 5.4 What each role sees

These are the system roles. A member's exceptions add or remove tabs, and with them sections.

| Role                      | Sections (besides Settings)                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Owner, Organization Admin | + New sale, Home, Sales, Customers, Money, Stock, Buy, Reports                                                       |
| Branch Manager            | + New sale, Home, Sales, Customers, Money (no Tally export), Stock, Buy, Reports (no brand profitability)            |
| Sales Executive           | + New sale, Home, Sales, Customers, Money (Receivables, Collections, Payments, Payment links), Stock, Reports        |
| CRM Executive             | Home, Customers, Stock (Products only), Reports                                                                      |
| Inventory Manager         | Home, Customers (Customers, Follow-ups, Contracts), Stock, Buy, Reports                                              |
| Store Employee            | + New sale, Home, Sales, Customers (Customers, Follow-ups), Money (Payments, Day end, Payment links), Stock, Reports |

### 5.5 Design in code

- Each feature's `nav.ts` declares its pages as `NavItem`s with a `section`, an `order` and,
  where needed, extra path prefixes it owns (e.g. Tally export owns `/accounting`).
- `shell/sections.ts` lists the sections (label, icon) and builds the visible sections from the
  items: filter by permission, group by section, sort by order, drop empty sections.
- `stock/sections.ts` and `purchasing/sections.ts` go away. The shell draws the one tab bar, so
  pages stop drawing their own.

## 6. Step 2: the "Needs action" inbox (as built)

One page where each member sees everything waiting on them, and acts on most of it without
opening the record. No migrations: it reads the queues that already exist.

### 6.1 Where it is

- **Inbox is a tab of Home**, after the Dashboard, at `/inbox`. It has no permission: every member
  has an inbox (their own follow-ups at least). So every role now has Home, and Home always has
  two tabs.
- **The count** shows as a badge on the Home entry (side bar, phone bottom bar and "More") and on
  the Inbox tab, "99+" past 99. The link's name says it: "Home, 3 waiting for you" (an
  `aria-label`, so every browser reads it the same). At 0 there is no badge.
- The badge asks `GET /inbox/count` every minute while the app is in view (React Query does not
  poll a hidden tab), and again after any change to a queue: the refresh helpers of credit,
  approvals, collections, activities and inventory also reload the inbox, so acting on a queue's
  own screen updates the badge too.
- A header button was considered and not built: the header already has search and the bell, and
  the spec puts the badge on the menu.

### 6.2 API

- `GET /inbox?kind=&storeId=` returns `{ kinds, groups, total }` (`InboxView` in
  `@paint/shared`). `kinds` are the kinds this member can be asked about (the filter's options);
  `groups` are those with something waiting, in a fixed order, each with its `total` and its first
  20 items. A `storeId` the member does not work at is a 404.
- Each item: `kind`, `id`, `step` (what it asks, e.g. `dispatch_transfer`), `reference` (AP-, CR-,
  TR- number or SKU), `title`, `requestedBy`, `store`, `amountPaise`, `since`, `due`, `quantity`
  (low stock), `priority` (`high`, `normal`, `low`), `link` (the record in the web app) and
  `actions`: the inline actions the member may take, each with the existing endpoint it posts to
  and what it asks first (`none`, an optional `note`, a required `reason`).
- `GET /inbox/count` returns `{ total }`: the same queues, one row each.
- **No new rules.** Each queue is read through its own service with the same permissions, store
  scope and member exceptions (#74) as its screen. To reuse them as they are, the services gained
  small, general options: a store filter on credit approvals (`storeId`) and credit requests (the
  customer's home store), `awaitingMe` on stock counts (submitted, not by me unless I work at
  every store, the rule `approve` applies), and the escalations list now filters by store in SQL
  (it filtered after the limit before) and counts.
- **Queries:** a fixed number per kind whatever the queue's length (about two per queue, three
  calls for transfers); `inbox-scale.int.test.ts` checks the owner's and a manager's inbox, and the
  count, run the same number of queries with 1 and with 40 items of every kind.

### 6.3 The kinds

| Kind                    | Who (and where)                                                                                                                                                                             | Inline                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Credit approvals        | `credit:read` and an approver: the owner (every level), `credit:approve` (releases), `credit:approve_sale` (manager-level sales at their stores). Never the member's own request.           | Approve (optional reason; a release asks the waiver date), reject (reason) |
| Credit requests         | `credit:read` and `credit:approve`, for the customers they can see. Not the member's own request, unless no other active member holds `credit:approve` (§6.5)                               | Approve (optional note), reject (reason)                                   |
| Transfers               | `inventory:manage`: to approve and to dispatch at the sending store, to receive at the receiving store                                                                                      | Approve in full, reject (reason); dispatch and receive open the transfer   |
| Stock counts            | `inventory:manage` at the store; submitted, and not by the member unless they work at every store                                                                                           | None: variance reasons are given on the count                              |
| Broken promises         | `receivables:read` and `credit:manage`, for customers of their stores and business-wide ones: open escalations                                                                              | Acknowledge (optional note)                                                |
| Follow-ups              | Everyone: their own, overdue and due today (India time)                                                                                                                                     | Done (outcome, next step), when they may change the record                 |
| Team follow-ups overdue | `members:read` (owner, admin, branch manager): overdue follow-ups of the members assigned to their stores (everyone's, for who works at every store), not their own; each names whose it is | Open; reassign (`PATCH /activities/:id`) when they may change the record   |
| Low stock               | Whoever buys (`purchasing:manage`) at the store; at a store with no buyer of its own, also who manages its stock (`inventory:manage`) (§6.5); emptiest first                                | None: "Reorder" opens low stock at that store                              |

Priority: credit approvals, broken promises, stock in transit, overdue follow-ups and empty
shelves are high; low stock at its reorder level is low; the rest normal. Within a kind, items
keep their queue's order (transfers: to approve, to dispatch, to receive).

What each system role's inbox holds:

| Role               | Inbox                                                                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner              | Every credit approval and credit request but their own (their own requests too while nobody else approves credit), every transfer step, every submitted count, every broken promise, their follow-ups, the team's overdue follow-ups, low stock everywhere |
| Organization Admin | Manager-level sales and releases (not the owner's level), credit requests, transfers, counts, broken promises, follow-ups, the team's overdue follow-ups, low stock                                                                                        |
| Branch Manager     | Manager-level sales at their stores (not their own), transfers and others' counts at their stores, broken promises of their customers, follow-ups, their store team's overdue follow-ups, low stock at their stores without a buyer of their own           |
| Sales Executive    | Broken promises of their stores' customers, their follow-ups                                                                                                                                                                                               |
| CRM Executive      | Their follow-ups                                                                                                                                                                                                                                           |
| Inventory Manager  | Transfers, others' counts and low stock at their stores (they buy), their follow-ups                                                                                                                                                                       |
| Store Employee     | Their follow-ups (no "Done": they cannot change customers' activities)                                                                                                                                                                                     |

### 6.4 The page

Cards per kind, each with its count and "See all" (to the queue's own screen) past 20. Filters:
kind and store, kept in the address. Each item shows what it asks, its number, store, amount or
quantity, who asked or whose it is, when, and its due date. Dialogs are the queues' own (credit
approval, credit request, acknowledge, done, assign). Empty: "Nothing waiting for you". English,
Hindi and Telugu.

### 6.5 Rules decided with the product owner (round 2)

- **Nobody decides their own credit request**, as with credit approvals:
  `POST /credit-requests/:id/approve` and `/reject` answer 403 "You asked for this credit request:
  another approver decides it" while another active member (not platform support) holds
  `credit:approve`. A one-owner shop, where nobody else does, still decides its own. The inbox
  leaves out the member's own requests by the same rule; the requests screen shows the message.
- **Low stock goes to whoever buys.** A store "has a buyer of its own" when an active member
  assigned to it (not one who works at every store, like the owner) holds `purchasing:manage`,
  exceptions included. Low stock at a store goes to the members holding `purchasing:manage` who
  work there (the owner and admins always do); at a store without a buyer of its own, also to those
  holding `inventory:manage` there (the branch manager), so nothing goes unnoticed. The inbox and
  the low-stock notification (bell and email, from the worker) follow the same rule.
- **Managers see their team's overdue follow-ups**, as their own group (§6.3). `GET
/activities/follow-ups?assignedTo=team` gives the same list to the follow-ups screen (needs
  `members:read`). Reassigning uses the existing `PATCH /activities/:id` with `assignedMemberId`,
  and the existing assignee list (`GET /members/assignable`).
- The scale test also grows the team's follow-ups and low stock: query counts stay flat.

### 6.6 Open questions

- **Plan requests** (subscription plan changes) are not in the inbox: they wait on the platform
  console, not on a member. Add them if a business-side step appears.
- **Low stock and the owner:** the owner (and admins) work at every store, so they always get
  low stock, and do not count as a store's own buyer. Should an owner be able to opt out (the
  notification settings already can for the bell and email)?
- **Low stock** rows: group by store when a store has many?
- **Dispatch and receive** open the transfer (quantities and the challan). Is "dispatch in full"
  inline wanted?
- **Team follow-ups** are by the stores the assignee is assigned to; an admin or owner's own late
  follow-ups show to other owners and admins only. Should the follow-ups screen get a "Team"
  choice too (the API supports it)?
- **Broken promises:** a sales executive sees their stores' escalations, not only their own
  customers'. Narrow to the customers they look after?
- The count runs about a dozen small queries a minute per open app. If that shows, cache it per
  member for a short time.

## 7. Later steps (outline)

2. **Needs-action inbox.** Built: see §6.
3. **Missing screens (as built).** No migrations. Two API changes: invoice print and PDF routes,
   and the reworked checklist route. See §8.
4. **Ctrl+K command palette:** one box for search, quick actions and "go to" any page.
   - Open: does `/` keep focusing the header search, or open the palette? Does the palette show
     recent records?
5. **Role homes.**
   - Open: are homes chosen by role key or by permissions (custom roles)? Can a member choose a
     different home?
6. **Customer page as a hub:** tabs and the action bar; then products and suppliers.
   - Open: which tabs load lazily? What does "Record promise" need beyond the collections API?
7. **Feature switches per shop.**
   - Open: are switches stored on the organization or per store? Does a switch hide data that
     already exists, or only the screens?

## 8. Step 3: the missing screens (as built)

Every screen below sits under an existing tab: new pages under `/payments` belong to Money →
Payments by their path, and the two new settings pages are declared in `settings/nav.ts` and
`setup/nav.ts`. No migrations. Permissions are the API's own; the screens only hide what the API
would refuse.

### 8.1 Payments (Money → Payments)

- **Take a payment** (`/payments/new`, `?partyId=` to start with a customer; `payments:manage`).
  - Customer (a picker, or from the customer page and the ledger), store (chosen already for a
    member of one store), mode (active modes, never a UPI link), amount, date (not in the
    future), reference. A cheque needs its number and the date written on it.
  - The customer's open bills are filled **oldest first**, and each can be changed (up to what
    the bill owes, and in all up to the money). The rest shows as the advance.
  - Sent with an `Idempotency-Key`. Cash without an open register is refused by the API
    ([PO-11]); the message links to Day end for members who run it.
- **A payment** (`/payments/:id`; `sales:read` to see, `payments:manage` for every action).
  - Details, the bills it paid (with undone and bounced rows), the receipt PDF and a link to the
    customer's account.
  - **Put against bills:** what is not allocated, oldest first, editable. **Undo** on an
    allocation makes it an advance again.
  - **Cheque cleared** (date) or **Cheque bounced** (date, the bank's reason, an optional charge).
  - **Refund advance:** amount up to the advance, mode, date, reference and note; it opens the
    refund. A pending cheque is refunded only after it clears; a bounced one allows nothing.
- **Payments list:** numbers open the payment; "Take a payment" for `payments:manage`.
- **Customer page and ledger:** "Take a payment" for `payments:manage`; a payment entry, and a
  bounce charge, in the ledger opens its payment.

Refund keeps `payments:manage`, as the API has it ([PO-150]).

### 8.2 Invoices (Sales → Invoices → an invoice)

- **Reprint:** "Print A4" and "Print 80 mm" print the issued invoice or bill of supply with the
  counter's templates. `GET /invoices/:id/print` (`sales:read`) answers the document with the
  business's print settings today (`PrintableInvoiceView`); `printViewOf` moved from the web app
  to `@paint/shared` so the API and the web print the same view. **PDF** downloads
  `GET /invoices/:id/invoice.pdf?lang=en|hi|te`, the A4 PDF in the member's language (legal
  headings stay English), named after the number (`AMP-26-27-000001.pdf`). No copy mark and no
  logo on a reprint yet ([CA-125], [PO-151]). Drafts, notes and cancelled invoices are refused
  (409).
- **Cancel** (`billing:cancel`): a reason of 3+ characters. The dialog states the rules up front
  (the day of issue only; no note, dispatch or payment against it; otherwise a credit note) and
  warns when the invoice is from an earlier day; the API decides, and its refusal is shown as it
  comes ("Payments are allocated to this invoice: undo them first, or raise a credit note")
  ([PO-152]).

### 8.3 Message templates (Settings → Customers & credit → Message templates)

`/settings/messages`, `organization:manage`, over the existing `/message-templates` API. Choose
the message, the channel and the language (en / hi / te); the badge says whether the wording is
the business's own or the standard one.

- MSG-4: the wording is checked as it is typed with the API's own rules (only the template's
  variables, not empty, at most 1,000 characters); the variables are buttons that add
  `{{variable}}` where the cursor is. Saving is off until something changed and nothing is wrong.
- MSG-5: the page says what messages may carry, and the variables list is fixed per template.
- WhatsApp: a reminder that the wording must match what the provider approved ([PO-1]), and the
  provider's template name (lowercase, digits, `_`).
- Preview with sample data (the customer's name in the member's language, the business's name,
  a UPI link sentence in the message's language); an email also shows its subject.
- "Use standard wording" resets a reworded template.

### 8.4 Getting started (Settings → Business, and on Home)

`GET /onboarding` (any member; counts only) now answers nine steps, worked out from the
business's records on every call, in this order:

| Step                       | Done when                                                                     | Opens                     |
| -------------------------- | ----------------------------------------------------------------------------- | ------------------------- |
| Stores and GST             | at least one open store, and every open store (not godowns) has its GST state | `/settings/stores`        |
| Import products            | a product variant exists                                                      | `/imports`                |
| Import customers           | a customer, contractor or painter exists (not the walk-in party)              | `/imports`                |
| Opening stock              | an opening stock movement exists                                              | `/imports`                |
| Your team                  | two or more active members                                                    | `/team`                   |
| Credit rules               | the credit rules were saved once                                              | `/settings/credit`        |
| Billing go-live            | `billing_live_on` is set                                                      | `/settings/go-live`       |
| Invoice print and branding | bank details or terms are saved, or a logo is uploaded ([PO-153])             | `/settings/invoice-print` |
| Payment links              | a payment gateway is connected                                                | `/settings/payment-links` |

The page `/settings/getting-started` (`organization:manage`) shows progress and each step, done or
to do, with a link. Home shows the same card to `organization:manage` holders until every step is
done, or until "Hide" (kept on the device, per business; a blocked storage shows it again)
([PO-154]).

### 8.5 Open questions

| #      | Question                                                                                                                                                                    | Built for now                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| PO-150 | Does a refund need its own permission, or an approval above an amount?                                                                                                      | `payments:manage`, as the API has it  |
| PO-151 | Should the API's invoice PDF carry the business's logo (read from storage), as the screen print does?                                                                       | No logo on the PDF                    |
| PO-152 | Hide "Cancel invoice" after the day of issue, instead of showing it with a warning?                                                                                         | Shown with a warning; the API decides |
| PO-153 | Is "bank details or terms saved, or a logo" the right bar for "Invoice print and branding"?                                                                                 | Either one                            |
| PO-154 | Should hiding Getting started be per member on the server, rather than per device?                                                                                          | Per device                            |
| CA-125 | Should a reprinted A4 tax invoice let the member choose the copy (original / duplicate / triplicate, Rule 48(4)), or say "Reprint"? The counter print carries none ([CA-2]) | No mark                               |

# Navigation and UX: a short menu, a home per role, one inbox

**Goal:** a smooth, uncluttered app. Counter staff bill fast. Managers see what needs them. Owners
find any page without scanning a long list. Today an owner sees about 35 flat menu items, all at
the same level, and every role gets the same dashboard.

This spec records the product owner's approved direction. Step 1 (§5) is specified in full and
ships first. The later steps (§6) are outlines with their open questions.

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
  refund.
- An issued invoice cannot be cancelled or reprinted from its page.
- Message templates can only be changed through the API.
- Store employees cannot sign in without SMS.
- No setup checklist screen.
- One dashboard for every role.

## 5. Step 1: grouped menu, tabs, Settings hub, role-filtered menu

Front end only. No migrations, no API changes, and no changes to route guards.

### 5.1 Menu

The sidebar shows these entries, top to bottom. Each entry is a **section**. Its pages are
**tabs**.

| Section        | Tabs, in order                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| **+ New sale** | The counter (`/pos`). It is a prominent button at the top of the sidebar, not a plain item. Needs `billing:issue`.   |
| Home           | Dashboard (`/dashboard`)                                                                                             |
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
- **No badges yet.** They come with the inbox (step 2).

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

## 6. Later steps (outline)

2. **Needs-action inbox.** One page and a badge on the menu. It reads the queues that already
   exist (credit approvals, credit requests, transfers to send or receive, counts to approve,
   broken promises, low stock, plan requests).
   - Open: one API endpoint that aggregates the queues, or one call per queue? Approve inline
     for every kind, or open the record for some? Who sees the low-stock rows: the branch or the
     inventory manager?
3. **Missing screens:** payment on account and allocation; cheque clear and bounce; refund;
   cancel and reprint an issued invoice; message templates; setup checklist.
   - Open: which of these need API work first? Does refund need a new permission?
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

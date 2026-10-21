# Access control: exceptions to a role, and four finer permissions

A business controls who sees what through roles. A role is a set of permissions, and each team
member has one role, plus the stores they work at. Screens, the menu and the API all follow the
permissions: a menu item, a route and an endpoint each need their own permission. This round adds
two things.

1. **A member's own exceptions to their role.** One person can be given something their role does
   not have, or have something taken away, without making a new role for them.
2. **Four permissions split out of broader ones**, so that discounts, selling on credit, costs and
   CSV downloads can be switched off for a role or a person.

Migration 0093 adds the data model and the backfill (§4).

## 1. Exceptions to a role

What a member may do is their role's permissions, plus what is granted to them, less what is denied
to them. A denial wins. `effectivePermissions` in `packages/shared/src/permissions.ts` works this
out at sign-in, so the menu, the routes and the API all follow it on the member's next request.
Finding people by permission (who is told about a notice, who a lead can be handed to, who decides
on support access) uses the same rule in SQL (`holdsPermission`).

The rules for changing exceptions follow those for roles and stores:

- **Owners have none.** An owner holds every permission, so the API refuses exceptions for an
  owner, and someone made an owner loses theirs. Keeping owners whole also means a business
  always keeps someone who can do everything.
- **Nobody can grant what they do not hold.** A manager can deny anything to someone in their
  reach, but can only grant permissions they have themselves.
- **Nobody can change their own access.** Someone granted more than a manager holds is out of
  that manager's reach, as with roles.
- **Every change is audited**, as with roles and stores.

On screen: **Team → a member → Exceptions to the role**. Each permission is set to "as the role",
**Allow** or **Deny**, grouped by area. Allow is greyed out for permissions the editor does not
hold.

## 2. The four new permissions

| Permission           | Covers                                                                | Split out of                                             |
| -------------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| `billing:discount`   | A line or bill discount, or a line price other than the catalogue's   | `billing:issue`, `sales:manage`                          |
| `billing:on_account` | Issuing a bill with money left unpaid; confirming a non-prepaid order | `billing:issue`, `sales:manage`                          |
| `costs:read`         | Average cost, stock value at cost, cost variances and margins         | `inventory:read`, `purchasing:read`, `accounting:export` |
| `data:export`        | Downloading reports and lists as CSV                                  | every role                                               |

### 2.1 Discounts and prices (`billing:discount`)

These are checked where a person enters them: saving a draft bill (new or held), a quotation or a
sales order. A discount above zero, or a line price that differs from the catalogue price, is
refused as a field error ("You cannot give discounts", "You cannot change the price"). A product
with no catalogue price takes the price typed in. Turning a quotation into an order, or billing an
order, carries on with the prices already agreed, so someone without the permission can finish a
sale priced by someone with it. On the counter, the discount box is greyed out.

### 2.2 Selling on account (`billing:on_account`)

Issuing a bill that leaves money unpaid is refused without it ("take the full ₹… (or use
advances)"). A bill of a sales order is not checked at issue, because the order's terms were agreed
when it was confirmed. Confirming an order that is not prepaid needs it instead. On the counter, the
pay dialog asks for the full amount. The credit rules and approvals are unchanged and still apply
on top.

### 2.3 Costs (`costs:read`)

Without it, the API sends cost figures as empty (`null`), as it already does for stock with no
cost, and the screens leave them out:

- **Stock:** average cost and value on the stock list, and unit cost on the stock ledger.
- **Slow movers:** the money tied up.
- **Stock counts:** each line's variance value, and the net and absolute variance values.
- **Dashboard:** the stock value. The tile shows stock on hand instead.
- **Reports:** the cost columns of stock by location (average cost, value), the stock ledger (unit
  cost) and transfers (dispatched value), on screen and in the CSV.
- **Brand profitability** (report, screen, dashboard tile) and the **price-hike planner** need it
  as well as their own permission.

Purchase orders and goods receipts keep their unit costs: buying needs them, and they stay with
`purchasing:read`. The transfer challan keeps its values, because it is the delivery document.

### 2.4 Downloads (`data:export`)

Every CSV download needs it: reports (`GET /reports/:kind?format=csv`, which also serves the
receivables ageing and the brand scheme lists), the brand profitability CSV and a brand statement's
mismatches. The download buttons are hidden without it. The Tally export keeps its own permission
(`accounting:export`). Import templates are not downloads of data, so they do not need it.

## 3. Nothing changes on the day it ships

Every role that could do something before gets the new permission for it, whether it is a standard
role or a custom one. Owners then take it away where they choose. The standard roles in
`SYSTEM_ROLES` match, so new businesses start the same:

- Branch Manager, Sales Executive and Store Employee get `billing:discount` and
  `billing:on_account`.
- Everyone with stock, purchasing or accounting access gets `costs:read`. The CRM Executive does
  not get it.
- Every role gets `data:export`.

## 4. Data model (migration 0093)

- New table `member_permission_exceptions (organization_id, member_id, permission, granted)`,
  with one row per member and permission, `granted` true to allow or false to deny. It has
  row-level security per business and is deleted with the member.
- Audit trigger `audit_member_permission_exceptions`.
- A data migration grants the four permissions as described in §3, and is safe to re-run.

# SaaS subscriptions and plan limits (P2-M08)

What a business pays the platform for the product, and what happens when it does not. Built by
Manpreet Kaur in draft PR #50 on MVP 2 (with a Razorpay gateway), brought onto MVP 3 in round 3a
and switched to **manual invoicing by default**: the product owner chose "manual invoicing for
now", with no payment gateway live ([spec §7](credit-and-receivables.md#7-delivery-plan)).
Answers [MVP 2 sell-and-bill.md §8 PO-12](../mvp-2/sell-and-bill.md#8-open-questions).

**Done when:** a trial business asks for a plan, sees our invoice with how to pay it, a platform
operator records the bank transfer and the business is active (`apps/web/e2e/billing.spec.ts`).

## 1. Plans

`PLANS` in `@paint/shared` stays the catalogue: limits, features and prices. Prices stay in code,
not in the database, because a price ships with the limits and features it sells (and, with
Razorpay, must match a plan set up there, `RAZORPAY_PLAN_IDS`); changing a price is a release, as
changing a limit already is.

| Plan       | Stores    | Team      | Per store, monthly | Per store, annual | Features         |
| ---------- | --------- | --------- | ------------------ | ----------------- | ---------------- |
| Trial      | 5         | 25        | free               | free              | none             |
| Starter    | 1         | 5         | ₹799               | ₹7,990            | none             |
| Standard   | 10        | 50        | ₹1,499             | ₹14,990           | advanced reports |
| Enterprise | unlimited | unlimited | ₹2,999             | ₹29,990           | every feature    |

Prices are **placeholders** (annual = ten months) until the product owner sets them ([PO-22]);
they are before GST. A business pays per active store (at least one), counted as the plan limits
count them. Limits are still enforced only by `requireRoomFor` and the feature flags
(`resolveFeatures`); `organizations.plan` is still the one current plan.

**MVP 3 data and the limits.** Only active stores and active team members (not support
sessions) count. Nothing MVP 3 added counts against a plan: a site account is a project, a
painter or contractor is a party, a credit approval or a promise is a record. No MVP 3 module is
behind a feature flag yet (`credit_control`, `whatsapp_notifications` and `loyalty` exist as flags
for piloting but gate nothing), so a plan change cannot switch MVP 3 off mid-use ([PO-24]).

## 2. How subscriptions are collected

`SUBSCRIPTION_GATEWAY` picks one, the same in every environment unless set:

| Value              | What happens                                                                                                                                                                                     | Production                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `manual` (default) | §3: the owner asks for a plan, an operator applies it; we raise our GST invoices; the business pays by bank transfer or UPI; an operator records the payment                                     | Needs the bank account (§3.5)     |
| `razorpay`         | #50's flow (§5): a Razorpay Subscriptions checkout, renewals charged by Razorpay, our invoice on each payment, HMAC-signed webhooks                                                              | Needs the Razorpay keys and plans |
| `fake`             | #50's fake gateway for tests: its checkout is a page of the web app (`/billing/checkout/:id`), and "Pay" signs a webhook with a per-process secret that goes through every check a real one does | Refused                           |

Both the platform's GST details (`PLATFORM_LEGAL_NAME`, `PLATFORM_GSTIN`, `PLATFORM_ADDRESS`,
`PLATFORM_CITY`, `PLATFORM_PINCODE`) and, with `manual`, its bank account are required in
production; elsewhere they fall back to labelled placeholders. Switching an environment from one
value to another is not a migration: businesses already paying through Razorpay keep their
subscription there (an operator cannot apply a plan request to them, §3.2), and their webhooks are
no longer believed once Razorpay is off, so switch only before anyone pays online ([PO-25]).

## 3. Manual invoicing

### 3.1 Subscription states

One `subscriptions` row per business (migration 0077; 0078 gave every existing business one: a
fresh 14-day trial, or "active, set by hand" for a paid plan the platform chose).

| Status      | Meaning                                                                                 | Business can write?                               |
| ----------- | --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `trialing`  | free trial until `trial_ends_at` (`SUBSCRIPTION_TRIAL_DAYS`)                            | yes                                               |
| `active`    | paid to `current_period_end`; or set by hand by an operator (never lapses)              | yes                                               |
| `past_due`  | the paid period ended and the next invoice is unpaid (with a gateway: a renewal failed) | yes for `SUBSCRIPTION_GRACE_DAYS`, then read-only |
| `cancelled` | ended (cancelled at period end)                                                         | read-only                                         |
| `expired`   | the trial ended without a plan                                                          | read-only                                         |

With `manual`, `subscriptions.gateway = 'manual'` and `current_period_end` is **the end of the last
period paid for** (the start of the India day after the invoice's last day). So #50's pure
`subscriptionState()` needs no change: past that moment a running subscription is `past_due`, from
that moment, and read-only once the grace days pass, exactly as when a gateway's renewal fails.
Time moves a subscription on without a write, against the database clock.

### 3.2 Plan changes: the owner asks, an operator applies

The brief allowed "requested by the owner and applied by an operator" or "applied immediately with a
prorated invoice". We chose the first:

- **No tax invoice from a click.** An owner's click raising a GST invoice at once would leave
  unpaid tax invoices for plans nobody started, each needing a credit note ([CA-9]); an operator
  applies only what was agreed.
- **No proration or credit notes in the product** while a person is in the loop anyway: a
  mid-period upgrade or downgrade changes the limits at once and the price from the next invoice,
  as #50 already does for a running gateway subscription.

| Step                                     | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner asks (`POST /subscription/change`) | Refused (409 `plan_limits_exceeded`, with `blockers`) while the business uses more than the plan allows, and for the plan and interval it already pays for. Otherwise a `subscription_plan_requests` row: one open per business; a newer request replaces (cancels) the open one. The answer is `{kind: 'requested'}`                                                                                                                                          |
| Operator applies                         | Refused while an invoice is unpaid, for a business paying online, or when the business has outgrown the plan since asking. A business we already invoice (running, not ending) changes **in place**: plan and interval now, price from its next invoice. Any other (trial, expired, set by hand, cancelled, lapsed) gets its **first invoice** now: one period from today, payable today. Its trial (or read-only state) carries on until that invoice is paid |
| Operator declines                        | The request is closed; the owner can ask again                                                                                                                                                                                                                                                                                                                                                                                                                 |

A request is decided once (a trigger); its status and decider are audited.

### 3.3 Our invoices and renewals

Every invoice is the same GST tax invoice #50 issues on a gateway payment (§4), with a due date and
no gateway payment id. Renewals: the background worker raises the next period's invoice
**7 days before the paid period ends** (`RENEWAL_INVOICE_LEAD_DAYS`), dated today, for the period
starting the day the paid one ends, **payable on that day**, on the current plan and interval and for
the stores active today (so stores added mid-period are billed from the next invoice). One invoice
per period (a unique index), never while an earlier one is unpaid, never for a business that is
cancelling or suspended; several servers share the work (`SKIP LOCKED`). A period invoiced late (the
worker was down) is payable at once.

GST basis: subscriptions are a continuous supply of services, for which the invoice is issued on or
before the date payment is due (CGST Act s.31(5)(a)); a CA should confirm that 7 days ahead is fine
and how an invoice that is never paid is reversed ([CA-9]).

### 3.4 Recording a payment

In the platform console (a business → **Invoices and payments**) an operator records what arrived
for an unpaid invoice: amount (at least ₹0.01, **at most the invoice total**), the India date it
arrived (not in the future), the mode (bank transfer, UPI, cheque, other) and the reference (UTR, UPI
reference or cheque number). It is stored in `subscription_payments` (append-only, one per invoice;
a trigger refuses more than the total, an online invoice, or another business's invoice) and, in the
same transaction:

- the invoice is paid;
- the subscription is `active`, `gateway = 'manual'`, on the invoice's plan, interval and store
  count, paid to the end of the invoice's period: a renewal **extends** it, a first invoice
  **activates** it (ending the trial or read-only state). A plan or interval that differs from the
  business's is recorded in the plan history as the operator's change.

Less than the total settles the invoice too: a business may deduct TDS before paying ([CA-8]); the
console shows how much short.

### 3.5 What the owner sees

**Settings → Billing** (`/settings/billing`; only the role `owner`, never support): plan, status,
trial days left, usage against limits, the plans priced for the business's stores (monthly or
annual; with manual invoicing the button asks for the plan and a note says our team applies it and
sends the invoice), the open request, our invoices with **Paid** (date) or **Due** (date) and a PDF,
**How to pay** (account name, bank, account number, IFSC, UPI id: `PLATFORM_BANK_NAME`,
`PLATFORM_BANK_ACCOUNT_NAME`, `PLATFORM_BANK_ACCOUNT_NUMBER`, `PLATFORM_BANK_IFSC`,
`PLATFORM_UPI_ID`), and the plan history. There is no checkout button. The invoice PDF prints the
same bank details and "Payable by <date> by bank transfer or UPI … quote <number> as the reference".
The shell banner warns every member of a trial ending, a payment due past the period end, and
read-only mode.

**Cancel** stops renewals: no more invoices; the paid period runs to its end, then the business is
read-only. It is refused while the next invoice is already raised and unpaid ("contact us to
cancel"), since that invoice would need a credit note.

### 3.6 The platform console

Each business shows its subscription status beside its plan and how it pays ("Invoiced by us",
"Online (razorpay)", "Set by our team"); a trial (running or expired) can be **extended** by 1–90
days. The **Invoices and payments** card shows the open request (**Apply**, **Decline**) and every
invoice with its status, and records payments. A plan the operator sets by hand (the plan field) is
recorded in the history; a paid plan set by hand on a business we do not invoice is active and never
lapses; on a business we invoice it changes the plan in place.

## 4. Our GST invoices

Whatever collects the money, each invoice is a **tax invoice** from the platform to the business,
numbered `PRS/26-27/000001` (`PLATFORM_INVOICE_PREFIX`, gap-free per financial year,
`subscription_invoice_sequences`), computed by the GST engine at **18%** with no round-off: CGST +
SGST when the business is in the platform's state (from `PLATFORM_GSTIN`), IGST otherwise. The buyer
is the business's first regular GST registration (B2B, so it can claim the credit), else an
unregistered buyer in its first store's state, else in the platform's state. Supplier and buyer are
snapshotted; the PDF is drawn by the same `buildInvoiceView` + `renderInvoicePdf` as the businesses'
own invoices (`GET /subscription/invoices/:id/pdf`). Invoices are never edited.

**SAC.** The default is **998315** ("hosting and IT infrastructure provisioning services": its UN
CPC 8315 includes 83152 _application service provisioning_, which is software as a service).
Practice varies: 998314 (IT design and development) and 997331 (licensing the right to use
software) are also used, all at 18%. **A CA must confirm**; change it with `PLATFORM_SAC`.

## 5. The payment-gateway port

The provider-neutral parts live in `apps/api/src/payments-gateway/`, for P2-M32's UPI payment links
(round 4a) to reuse rather than build a second one:

| Piece                | What it is                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signatures.ts`      | Hex HMAC-SHA256 and a constant-time signature check (how Razorpay and most Indian gateways sign webhooks)                                                                                                                                                                                                                                   |
| `payment-gateway.ts` | `VerifiedGatewayEvent` (id unique per gateway, the gateway's own type), `WebhookVerifier` (verify the raw body or believe nothing), `PaymentCreator` (`createPayment({reference, amountPaise, description, expiresAt, customer})` → `{gatewayReference, url}`, which the link adapter implements next), `GatewayError` (never carries keys) |
| `gateway-events.ts`  | `receiveGatewayWebhook`: verifies, stores the event in `payment_gateway_events` (gateway, event id, type, `object_id` = what it is about, the business once known) and applies it in one transaction, once; a redelivery is a duplicate; a failed apply stores nothing, so the gateway's retry applies it                                   |

Subscriptions sit on it: `SubscriptionGateway` extends `WebhookVerifier` with #50's create, change,
cancel and fetch; `RazorpayGateway` (plain `fetch`, Basic auth; one Razorpay plan per paid plan and
interval priced per store with GST included; webhook `POST /subscription/webhooks` for
`subscription.activated`, `.charged`, `.pending`, `.halted`, `.cancelled`, `.completed`),
`FakeGateway` and `ManualGateway` (starts nothing, believes no webhook). With a gateway, choosing a
plan with no running paid subscription opens a checkout and the plan changes when the gateway reports
the payment; a running one changes in place (Razorpay `schedule_change_at: cycle_end`), no proration;
our invoice is issued on each `charged` event, once per payment id. Webhooks are public but
HMAC-verified over the raw body; an event about a gateway subscription the business no longer uses is
ignored. Keys and secrets are never logged.

## 6. Read-only mode

`ReadOnlyGuard` (#50) runs on every non-GET route after the permission check: a read-only business
gets 403 `code: subscription_read_only` with a message naming why. Only these opt out
(`@AllowWhenReadOnly`): signing in and out and two-factor settings, notifications, support access
requests, and the owner's billing (to ask for a plan and see what to pay). Support sessions are
read-only anyway; public and platform routes have no member.

MVP 3's write paths are blocked like every other: credit approvals and site accounts, credit rules,
promises to pay, escalations and reminder schedules, messaging consents and templates, statement
links, and painter points rules. `read-only-routes.int.test.ts` walks every route Nest registered
and calls each write as the owner of a read-only business, so a route added later is covered the
day it is added. The background worker keeps running for read-only businesses (the nightly credit
hold, the collections run and its reminders to parties, the reconciliation) ([PO-23]).

## 7. Data model (migrations 0077–0078)

| Table                            | What                                                                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscriptions`                  | One per business: status, interval, stores billed, trial end, paid period, cancel at period end, past due since, `gateway` (null = trial or set by hand; `manual`; `razorpay`; `fake`) and the gateway's subscription id (gateways only). Audited |
| `subscription_plan_changes`      | Every plan change (sign-up, owner, operator, gateway); append-only                                                                                                                                                                                |
| `subscription_plan_requests`     | Manual invoicing: what the owner asked for; one open per business; decided once; audited                                                                                                                                                          |
| `subscription_checkouts`         | Gateways: a payment started for a new plan                                                                                                                                                                                                        |
| `subscription_invoices`          | Our GST invoices: `due_on`, `gateway` (`manual`, or the gateway that took the money with its payment id); one manual invoice per period; append-only                                                                                              |
| `subscription_payments`          | Manual invoicing: the payment an operator recorded, one per invoice, at most its total; append-only; audited                                                                                                                                      |
| `subscription_invoice_sequences` | The platform's invoice series per financial year; platform only                                                                                                                                                                                   |
| `payment_gateway_events`         | Every webhook event, so each is applied once (the shared port); platform only                                                                                                                                                                     |

Businesses read only their own rows (row-level security) and write none: every write is the
platform's, after the API checked the owner, the operator or the gateway's signature.
`enum payment_gateway` = `manual`, `fake`, `razorpay`.

## 8. API

| Method     | Path                                                               | Access                    | What                                                                                                         |
| ---------- | ------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| GET        | `/subscription/status`                                             | signed in                 | Status, trial days left, grace end, read-only (for the banner)                                               |
| GET · POST | `/subscription`, `/subscription/change`, `/subscription/cancel`    | the owner                 | The Billing page (with `collection`, `paymentInstructions`, `planRequest`); ask for or change a plan; cancel |
| GET        | `/subscription/invoices`, `/subscription/invoices/:id/pdf`         | the owner                 | Our invoices with `dueOn` and `payment`; a PDF                                                               |
| GET · POST | `/subscription/checkouts/:id`, `/:id/fake-pay`                     | the owner                 | Gateways only                                                                                                |
| POST       | `/subscription/webhooks`                                           | public, signature-checked | Gateways only                                                                                                |
| GET        | `/platform/tenants/:id/billing`                                    | platform operators        | The open request, the latest requests and our invoices with their payments                                   |
| POST       | `/platform/tenants/:id/plan-requests/:requestId/apply`, `/decline` | platform operators        | Apply (in place, or the first invoice) or decline                                                            |
| POST       | `/platform/tenants/:id/invoices/:invoiceId/payments`               | platform operators        | `{amountPaise, paidOn, mode, reference}`: record a payment                                                   |
| POST       | `/platform/tenants/:id/extend-trial`                               | platform operators        | 1–90 more days of trial                                                                                      |

## 9. Follow-ups

- Emails: an invoice raised, a payment due, a trial ending (the banner warns the owner today).
- Credit notes for our invoices (cancelling an unpaid one, refunds), and proration ([CA-9]).
- TDS certificates (Form 16A) tracked against short payments ([CA-8]).
- Razorpay webhooks when the platform switches to manual with online subscribers ([PO-25]).
- An operator setting the trial on a business that pays online does not cancel the gateway
  subscription; cancel it in Razorpay too (from #50).
- No resume of a cancellation (ask for a plan again after it ends).

[PO-22]: credit-and-receivables.md#8-open-questions
[PO-23]: credit-and-receivables.md#8-open-questions
[PO-24]: credit-and-receivables.md#8-open-questions
[PO-25]: credit-and-receivables.md#8-open-questions
[CA-8]: credit-and-receivables.md#8-open-questions
[CA-9]: credit-and-receivables.md#8-open-questions

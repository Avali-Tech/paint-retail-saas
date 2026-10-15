# SaaS subscriptions and plan limits (P2-M08)

What a business pays the platform for the product, and what happens when it does not. Answers
[sell-and-bill.md §8 PO-12](sell-and-bill.md#8-open-questions). **Done when:** a trial business
upgrades to a paid plan by itself (`apps/web/e2e/billing.spec.ts`).

## 1. Plans

`PLANS` in `@paint/shared` stays the catalogue: limits, features and now prices. Prices stay in
code, not in the database, because each one must match a plan set up at the payment gateway
(`RAZORPAY_PLAN_IDS`), and a price ships with the limits and features it sells; changing a price is
a release, as changing a limit already is.

| Plan       | Stores    | Team      | Per store, monthly | Per store, annual | Features         |
| ---------- | --------- | --------- | ------------------ | ----------------- | ---------------- |
| Trial      | 5         | 25        | free               | free              | none             |
| Starter    | 1         | 5         | ₹799               | ₹7,990            | none             |
| Standard   | 10        | 50        | ₹1,499             | ₹14,990           | advanced reports |
| Enterprise | unlimited | unlimited | ₹2,999             | ₹29,990           | every feature    |

Prices are **placeholders** (annual = ten months) until the business sets them; they are before
GST. A business pays per active store (at least one), counted as the plan limits count them.
Limits are still enforced only by `requireRoomFor` and the feature flags (`resolveFeatures`);
`organizations.plan` is still the one current plan.

## 2. Subscription states

One `subscriptions` row per business (migration 0069; 0070 gave every existing business one: a
fresh 14-day trial, or "active, set by hand" for a paid plan the platform chose).

| Status      | Meaning                                                      | Business can write?                               |
| ----------- | ------------------------------------------------------------ | ------------------------------------------------- |
| `trialing`  | free trial until `trial_ends_at` (`SUBSCRIPTION_TRIAL_DAYS`) | yes                                               |
| `active`    | paid to `current_period_end`, or set by hand (never lapses)  | yes                                               |
| `past_due`  | a renewal failed, or the period ended unpaid                 | yes for `SUBSCRIPTION_GRACE_DAYS`, then read-only |
| `cancelled` | ended (cancelled at period end, or by the gateway)           | read-only                                         |
| `expired`   | the trial ended without a plan                               | read-only                                         |

Time moves a subscription on without a write: `subscriptionState()` (pure, in `@paint/shared`)
reads the stored row against the **database clock**. **Read-only** (`ReadOnlyGuard`): every
change is refused with 403 `code: subscription_read_only`; reading, signing in and out, two-factor
settings, notifications and the owner's Billing (to pay) still work. Support sessions are
read-only anyway.

## 3. Self-serve (owner only)

**Settings → Billing** (`/settings/billing`; only the role `owner`, never support): plan, status,
trial days left, usage against limits, the plans priced for the business's stores, monthly or
annual. Choosing a plan:

- **No running paid subscription** (trial, set by hand, lapsed, cancelling): a checkout at the
  gateway; the plan changes only when the gateway reports the payment (webhook).
- **A running paid subscription:** changes in place: the new limits at once, the gateway's price
  from the next period (Razorpay `schedule_change_at: cycle_end`). **No proration** either way.
- **Refused** (409 `plan_limits_exceeded`, with `blockers`) while the business uses more stores
  or team members than the plan allows: "close stores or deactivate team members first".
- **Cancel** stops renewal; the paid period runs to its end, then the business is read-only.

Every plan change is in `subscription_plan_changes` (append-only: signup, owner, operator,
gateway) and plan changes are in the audit log as before; subscription changes are audited too.

## 4. Payment gateway

`PaymentGateway` (`apps/api/src/subscriptions/payment-gateway.ts`): create a subscription
(checkout), change plan, cancel at period end, fetch status, verify a webhook.

- **Razorpay** (`razorpay-gateway.ts`): Subscriptions API with plain `fetch` and Basic auth; one
  Razorpay plan per paid plan and interval, **priced per store with GST included** (Standard
  monthly = ₹1,768.82), quantity = stores. Configuration only: `RAZORPAY_KEY_ID`,
  `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_PLAN_IDS`. Webhook URL:
  `POST /subscription/webhooks`, events `subscription.activated`, `.charged`, `.pending`,
  `.halted`, `.cancelled`, `.completed`.
- **Fake** (`fake-gateway.ts`): tests, e2e and the demo. Its checkout page is
  `/billing/checkout/:id` in the web app; "Pay" makes it sign a webhook with a per-process secret
  that goes through the same checks. Production refuses to start with it.

Webhooks are public but **HMAC-SHA256-verified over the raw body** (constant-time compare),
**idempotent by event id** (`payment_gateway_events`), and an event about a gateway subscription
the business no longer uses is ignored. Keys and secrets are never logged.

## 5. Our GST invoices

On every payment (`charged`), once per payment id: a **tax invoice** from the platform to the
business, numbered `PRS/26-27/000001` (`PLATFORM_INVOICE_PREFIX`, gap-free per financial year,
`subscription_invoice_sequences`), computed by the GST engine at **18%** with no round-off:
CGST + SGST when the business is in the platform's state (from `PLATFORM_GSTIN`), IGST otherwise.
The buyer is the business's first regular GST registration (B2B, so it can claim the credit), else
an unregistered buyer in its first store's state, else in the platform's state. Supplier and buyer
are snapshotted; the PDF is drawn by the same `buildInvoiceView` + `renderInvoicePdf` as the
businesses' own invoices (`GET /subscription/invoices/:id/pdf`). Invoices are never edited.

**SAC.** The default is **998315** ("hosting and IT infrastructure provisioning services": its
UN CPC 8315 includes 83152 _application service provisioning_, which is software as a service).
Practice varies: 998314 (IT design and development) and 997331 (licensing the right to use
software) are also used, all at 18%. **A CA must confirm**; change it with `PLATFORM_SAC`.

**Platform details** (`PLATFORM_LEGAL_NAME`, `PLATFORM_GSTIN`, `PLATFORM_ADDRESS` with `|`
between lines, `PLATFORM_CITY`, `PLATFORM_PINCODE`, `PLATFORM_EMAIL`) are placeholders outside
production (a made-up Telangana GSTIN, 36AAACP0000P1ZP) and required in production.

## 6. Platform console

Each business shows its subscription status beside its plan; a trial (running or expired) can be
**extended** by 1–90 days from its end or from now, whichever is later. A plan the operator sets
is recorded in the history; a paid plan set by hand is active and never lapses; the trial set
again starts a fresh trial.

## 7. Follow-ups

- Stores added mid-period are billed from the next plan change (quantity is synced then).
- No proration; no resume of a cancellation (subscribe again after it ends).
- Reminder emails before the trial ends or a renewal is due (the shell banner warns the owner).
- An operator setting the trial on a business that pays online does not cancel the gateway
  subscription; cancel it in Razorpay too.

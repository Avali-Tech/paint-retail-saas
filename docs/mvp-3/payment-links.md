# UPI payment links: each shop's own Razorpay account and gateway refunds (P2-M32, round 4c)

Round 4a built payment links on the shared payment-gateway port with a `log` provider
([credit-and-receivables.md](credit-and-receivables.md) §6.2, PL-1 to PL-12). Round 4c applies the
product owner's decisions on [PO-40] to [PO-44] and adds a real Razorpay adapter:

- Each business connects **its own Razorpay account**, so the money goes straight to the shop.
- Links are payable for **10 minutes** by default and capped at **₹1,00,000** by default. Both
  can be set per business.
- Links ask for what is owed **net of the advance** by default, or the bills' full outstanding.
- Money a link took that nothing was owed for is **refunded through the gateway**, by itself.

The rules are PL-13 to PL-18 in the spec (§6.2). The data model is §3.7: migrations 0081 and 0082.

## 1. How a shop connects Razorpay

Only owners and admins (`organization:manage`) see **Settings → Payment link settings**.

1. **Sign in to the Razorpay Dashboard** with the shop's own account, which must be activated (KYC
   done) for live payments. In **Accounts & Settings → API Keys**, generate a key and copy two
   values: the **Key Id** (`rzp_live_…`) and the **Key Secret**. Razorpay shows the secret once.
   - Test keys (`rzp_test_…`) work for trying the screens, but they take no money.
   - Razorpay has **no UPI Payment Links in test mode**. With test keys the product makes a
     standard link that offers UPI only.
2. **Add the webhook.** In **Accounts & Settings → Webhooks**, choose **Add New Webhook**:
   - **Webhook URL:** paste the address shown on the settings screen, for example
     `https://<app>/api/webhooks/payment-links/razorpay/<reference>`. The reference is random and
     belongs to the business. It stays the same if the keys are replaced, or the account is
     disconnected and connected again.
   - **Secret:** type a webhook secret of 8 to 128 characters. Note it for step 3.
   - **Active events:**
     - `payment_link.paid`
     - `payment_link.expired`
     - `payment_link.cancelled`
     - `refund.processed`
     - `refund.failed`

     `payment_link.partially_paid` is harmless but never happens: UPI links take one full payment.
3. **Connect in the product.** Enter the key id, key secret and webhook secret, then choose
   **Connect Razorpay**.
   - The product first checks the keys with a harmless read (`GET /v1/payments?count=1`).
     Razorpay refusing them (401) keeps nothing.
   - **Test connection** repeats that check at any time.
   - **Disconnect** forgets the keys. No new links are made until the shop connects again.
     Razorpay's webhooks meanwhile get a 404 and are retried by Razorpay.
4. **Set the rules** on the same screen:
   - how long a link is payable (5 minutes to 30 days, default 10 minutes);
   - the most one link may ask for (₹1 to ₹5,00,000, default ₹1,00,000);
   - what links ask for: net of the advance (the default) or the bills' full outstanding.

Who connected the keys and when is in the audit log. No secret is ever in it.

## 2. What the adapter does (`apps/api/src/payment-links/razorpay-payment-links.ts`)

| Need          | Razorpay API                                                                                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Make a link   | `POST /v1/payment_links`                                                                                   | Live keys send `upi_link: true`; test keys send a standard link with `options.checkout.method` set to UPI only. `accept_partial: false`. `reference_id` is our number plus a random suffix (at most 40 characters). Razorpay's own SMS and email are off (we send the link). `expire_by` is our expiry, but at least 16 minutes ahead: Razorpay refuses less than 15 minutes ([PO-60]). Money paid after our expiry is still recorded (PL-9). |
| Cancel a link | `POST /v1/payment_links/:id/cancel`                                                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Refund        | `POST /v1/payments/:id/refund`                                                                             | `speed: normal`. `receipt` is our refund row's id: asking again with it gets "Duplicate receipt", so the adapter finds the refund already made (`GET /v1/payments/:id/refunds`) instead of refunding twice.                                                                                                                                                                                                                                   |
| Test the keys | `GET /v1/payments?count=1`                                                                                 | Reads nothing that matters.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Webhooks      | `payment_link.paid` (and `.partially_paid`), `.expired`, `.cancelled`, `refund.processed`, `refund.failed` | Hex HMAC-SHA256 of the raw body with the business's webhook secret, in `X-Razorpay-Signature`. The event is named by `X-Razorpay-Event-Id`, or by its content for older deliveries. Anything else is kept in `payment_gateway_events` and ignored.                                                                                                                                                                                            |

**Transport.** Plain `fetch` with Basic auth, as the subscriptions adapter does:

- Each request has a 10-second timeout.
- A failure on the way (network, timeout, 5xx, 429) is tried up to three times, after 250 ms and
  1 s.
- A refusal (other 4xx) is never retried.
- Creating a link is safe to retry: a lost answer's link is found again by its `reference_id`.

Errors become `GatewayError` with Razorpay's error code (`BAD_REQUEST_ERROR`, `unauthorized`,
`unreachable`, …) and the method and path. They never carry a key or the request body.

**Tests.**

- Recorded answers in the shape of Razorpay's documented samples (`razorpay-payment-links.test.ts`).
  No test makes a network call.
- Signatures are checked with Razorpay's documented scheme.
- `razorpay-links.int.test.ts` runs the real adapter against `test-support/fake-razorpay.ts`, with
  a real database, through the business's own webhook route.

## 3. Credentials: security design

| Concern         | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| At rest         | **Envelope encryption** (`credential-vault.ts`). Each time the keys are saved, a fresh 256-bit data key encrypts `{keyId, keySecret, webhookSecret}` with AES-256-GCM. The data key is wrapped by the master key `GATEWAY_CREDENTIALS_KEY`, also AES-256-GCM. Each step uses a fresh 96-bit nonce and carries the business id as associated data, so a sealed value copied to another business does not open. Stored as `v1:<master key id>:<wrapped data key>:<sealed credentials>` in `payment_gateway_accounts.credentials_sealed`. |
| The master key  | 32 random bytes, base64, in AWS Secrets Manager (`paint-<env>/gateway-credentials-key`), put in by hand. Terraform creates the secret but never sees its value. The API refuses to start with `PAYMENT_LINK_PROVIDER=razorpay` without a valid key. The key id is an HMAC of the key, which reveals nothing about it.                                                                                                                                                                                                                  |
| In use          | Keys are opened for one request (making a link, a refund, a webhook) and never kept in memory beyond it. If they cannot be opened (a wrong master key), the business is "not ready" and its webhooks get a 404. The log line names only the business.                                                                                                                                                                                                                                                                                  |
| Rotation        | Set the new key as `GATEWAY_CREDENTIALS_KEY` and the old one as `GATEWAY_CREDENTIALS_PREVIOUS_KEY`, then restart. Credentials sealed under the old key still open, and are sealed again under the new key the next time they are used. Remove the previous key when no `credentials_sealed` row starts with the old key id ([runbook](../runbooks/rotate-secrets.md)).                                                                                                                                                                 |
| API answers     | Never a secret: the last four characters of each key, `connected`, `live`, who connected and when, and the last successful check. The connect form's validation messages are the product's own; they never echo the input.                                                                                                                                                                                                                                                                                                             |
| Who             | `organization:manage` (owners and admins) to see, connect, test or disconnect. Everyone signed in may read whether links can be made.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Audit           | `audit_payment_gateway_accounts` watches `gateway`, `key_id_hint`, `live`, `connected_at` and `connected_by_member_id`. It never watches the sealed credentials or the secrets' hints. The link settings are audited with the sales settings.                                                                                                                                                                                                                                                                                          |
| Logs and errors | No log line, error or `GatewayError` carries a key. Tests check the API's whole log output, its answers, the stored row and the audit rows for the secrets.                                                                                                                                                                                                                                                                                                                                                                            |
| Webhooks        | Public, but each business has its own route and secret. An event is believed only after the HMAC over the raw body matches that business's webhook secret. An event naming another business's link or refund is ignored (PL-6), so one shop's secret can never move another shop's money.                                                                                                                                                                                                                                              |
| Database        | Row-level security: the account is visible only in its business's tenant scope. Tenants can never delete it (a trigger and a revoke). Its business, gateway and webhook reference never change.                                                                                                                                                                                                                                                                                                                                        |

## 4. Refunds through the gateway ([PO-44])

When a link that pays bills is paid, its payment is recorded as before: the bills are paid as far
as they still owe (PL-8). Whatever its bills no longer owed then goes back to the customer:

- the bills were settled some other way (`settled`), or
- more came than they owed (`overpaid`).

An advance link's money is all wanted, so nothing goes back from it.

1. **Waiting refund.** The payment is recorded first, its leftover an advance as in round 4a. A
   `payment_link_refunds` row waits beside it, in the same transaction as the payment.
2. **Trying.** The webhook tries the refund at once, after its event is stored. The worker tries
   every due refund on each run, at any hour: refunds are not messages. Each try:
   - locks the party, then the refund;
   - asks the gateway with the row's id as the receipt;
   - once the gateway takes it, books it as MVP 2 refunds are booked:
     - a refund payment (RF-…) out by the "UPI link" mode, no member, no register;
     - its party-ledger entry `refund_out`;
     - an allocation of the link payment to the refund;
     - the advance goes down;
     - a **refund voucher** where the advance had a receipt voucher (Rule 51).

   Tally exports it with the receipts, into "Payment Gateway Clearing" unless mapped. Staff get a
   `payment_link_refund` notice.

3. **Retry-safe.** A try that crashed after the gateway took the refund asks again with the same
   receipt. Razorpay answers "Duplicate receipt", the refund already made is found, and it is booked
   once. Two servers never try one refund at once (row lock).
4. **Failures.** A failed try (gateway unreachable, refused, or not connected) keeps the money an
   advance:
   - The refund is flagged and staff are told once ("Refund failed, kept as an advance").
   - It is tried again after 1, 5, 30, 120 and 720 minutes.
   - After 6 tries it is `failed`. Staff are told to refund it by hand (MVP 2 refund) or allocate
     it.
5. **Staff got there first.** A waiting refund whose money staff allocated or refunded meanwhile
   is `dropped`.
6. **Gateway news.**
   - `refund.processed` notes the gateway's status.
   - `refund.failed` for a refund already booked brings the money back as an advance: a payment in
     by the UPI link mode, with the refund id plus `/returned` as its gateway reference. The refund
     is marked `returned`, and a new refund tries again, counting this failure among its tries.
   - News about a refund the books do not have yet is ignored: its try books it.
7. **The `log` provider** takes refunds at once, once per receipt. Tests can make it refuse or be
   unreachable (`refundBehaviour`), and it signs `refund.processed` and `refund.failed` news like
   any other event.

**On screen.** The links list, the customer 360 and the invoice show "Refunded ₹…", "Refund of ₹…
on its way" or "Refund of ₹… failed: kept as an advance". The customer ledger shows the refund
(RF-…) as a `Refund` entry beside the link payment.

## 5. Statements and links agree ([PO-43])

- **Net (the default).** A link never asks for more than the party owes net of its advance, so a
  statement's balance and its link agree.
- **Full.** A link asks for its bills' whole outstanding. Where that differs from the figure a
  message shows (a statement's balance), the message names the link's amount: "Pay ₹2,360.00 by
  UPI: …" in the message's language (`payLinkText`). Both figures are then explicit.

## 6. Later

- **Cashfree** (or PayU) is another adapter of the same `PaymentLinkProvider` interface, with its
  own credentials shape, signature header and events. A platform partner account (Razorpay Route)
  was not chosen ([PO-40]).
- Polling Razorpay for refunds whose webhook never came ([PO-62]).

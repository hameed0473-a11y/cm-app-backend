# lib/

Shared client instances and domain-level modules. All files are singletons — imported once and reused across route files.

## supabase.js

Single Supabase client used by every route and utility file. Uses `SUPABASE_URL` and `SUPABASE_KEY` (service-role key — bypasses row-level security).

## razorpay.js

Two Razorpay clients:

- **Platform client** (`module.exports`, also `.platform`) — Aftech's own Razorpay account for subscription billing. Uses `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` from env.
- **`getRazorpayForUser(userId)`** — Builds a Razorpay client from the treasurer's own encrypted credentials in `pro_integrations`. Returns `null` if not connected.
- **`getWebhookSecretForUser(userId)`** — Returns the treasurer's decrypted webhook secret for signature verification.

The distinction matters: money collected from subscribers must land in the **treasurer's** account, not Aftech's.

## gateways.js

Provider-agnostic payment gateway layer covering Razorpay, Stripe, and PayPal (PayPal partially implemented). Hides per-provider API differences behind a small interface:

| Function | Purpose |
|---|---|
| `listConnected(userId)` | All connected gateways for a user (no secrets) |
| `resolveProvider(userId, requested)` | Which provider to use; prefers Razorpay as domestic default |
| `createContributionLink(userId, provider, opts)` | Creates a payment link/session; returns `{ provider, id, url }` |
| `fetchLinkDetails(userId, provider, linkId)` | Gets status + amount for the public payment landing page |
| `getWebhookSecret(userId, provider)` | Decrypted webhook secret for signature verification |
| `capturePaypalOrder(userId, orderId)` | Server-side capture after PayPal webhook approval |
| `verifyPaypalWebhook(userId, headers, eventBody)` | PayPal webhook signature check via their verify API |

Currency: Razorpay is always INR; Stripe uses the treasurer's `pro_users.currency` setting. PayPal uses the same setting.

## pricing.js

Subscription pricing and receipt-cap calculations. Nothing here charges anyone automatically — it computes what's owed for display and gating purposes only.

| Function | Purpose |
|---|---|
| `getPricingPlan(currency)` | INR rate vs international rate (from `platform_pricing` table) |
| `computeAmountDue(subscriberCount, currency)` | Total annual amount owed |
| `countUniqueSubscribers(contributors, pledges)` | Unions both arrays by mobile number to avoid double-counting people who appear in both |
| `getMaxReceipts(paidSubscriberCount, receiptsPerSubscriber)` | Receipt cap ceiling |
| `getReceiptUsage(total, max)` | Percentage used + warning/blocked flags for the dashboard |

**Why unique-subscriber counting matters:** A person can be a contributor (in the `contributors` array) AND a pledger (in the `pledges` array). Counting only `contributors.length` would allow billing evasion by using only pledges.

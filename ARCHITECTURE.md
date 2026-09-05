# CM App — System Architecture

## Overview

CM App (Collection Management App) is a SaaS platform built by Aftech Software Services that allows treasurers to manage subscribers, collect periodic contributions, track pledges, and record expenses. It supports both a mobile app (iOS/Android via Capacitor) and a web dashboard, backed by a single Node.js API.

---

## Deployment Topology

```
aftechs.in          — Aftech company website (static HTML, Render)
cm.aftechs.in       — Pro Web Dashboard (React SPA, Vite build, Render)
api.aftechs.in      — Backend API (Node.js/Express, Render)
Supabase            — Database (PostgreSQL) + file storage
Razorpay / Stripe / PayPal  — Payment gateways (per-treasurer or platform)
Resend              — Transactional email (OTP, notifications)
```

All services run on Render. The database is a hosted Supabase project; there is no self-hosted Postgres.

---

## Component Responsibilities

### Frontend — `cm.aftechs.in`
React 19 + TypeScript + Vite + Tailwind CSS v4. A single-page application with five distinct page contexts:

| Page | Audience |
|---|---|
| `AdminDashboard` | Aftech platform admins |
| `ProDashboard` | Treasurers (Pro account holders) |
| `PaymentLandingPage` | Subscribers opening a payment link |
| `SubscriberPayPage` | Self-service subscriber payment |
| `PledgeQRPayPage` | Pledge payment via QR code scan |

All PDF generation (receipts, ledgers, insights report) happens **in the browser** using jsPDF with an embedded AppSans font — no server-side rendering.

### Backend — `api.aftechs.in`
Node.js + Express 5. All routes are mounted under `/api/auth` (a historical prefix retained for backward compatibility with the mobile app). The route tree is:

```
/api/auth/
  admin-login, admin-stats, admin-tickets, admin-subscriptions, admin-settings, admin-assistant
  webhook/razorpay, webhook/stripe, webhook/paypal
  pro/*           — Mobile app sync, authentication, payment links
  web/*           — Pro Web Dashboard (auth, data, collections, goals, pledges, settings, etc.)
  pledge-qr-*     — QR-code-based pledge collection (public, no auth)
  send-email-otp, verify-email-otp
  import-contributors, import-goals
  visitor         — Public page view counter
  contact-inquiry — Aftech website contact form
  cron/run-rollovers — Manual rollover trigger
```

### Database — Supabase (PostgreSQL)
Two data storage patterns coexist during a **dual-write migration**:

1. **Primary (JSON columns)** — `pro_user_data` holds `targets`, `contributors`, `contributions`, and `pledges` as JSON arrays. This is the authoritative source of truth for all reads.
2. **Normalized tables (mirror)** — `targets`, `contributors`, `contributor_subscriptions`, `contributions`, `pledges` receive best-effort upserts on every write (see `utils/mirrorWrite.js`). Once verified, reads will flip to these tables and the JSON columns will be retired.

Other key tables:
- `pro_users` — Treasurer accounts (mobile, email, subscription status, currency)
- `pro_integrations` — Per-treasurer gateway credentials (AES-256-GCM encrypted at rest)
- `platform_pricing` — Single-row table with INR and international per-subscriber rates
- `staff_users` — Staff accounts belonging to a treasurer
- `email_otps` — Short-lived OTP records for web registration/login
- `contact_inquiries` — Aftech website contact form submissions

---

## Authentication

There are four JWT token types, all signed with `JWT_SECRET`:

| Token type | Issued by | Accepted by | Lifetime |
|---|---|---|---|
| `admin` (role field) | `/admin-login` | `requireAdmin` middleware | 24 h |
| `pro_app` | `/pro/register`, `/pro/login`, `/verify-mpin`, `/verify-password` | `requireProToken`, `requireProOrStaffToken` | 90 d |
| `pro_web` | `/web-login-verify` | `requireProWebToken`, `requireProOrStaffToken` | 7 d |
| `pro_staff` | `/web-login` (staff path) | `requireProOrStaffToken` only | 7 d |

**Key design decisions:**

- `pro_app` and `pro_web` are separate types so a web session token cannot be replayed directly against `/pro/sync` (the mobile sync endpoint).
- `pro_staff` tokens are rejected by `requireProToken` and `requireProWebToken` by default — staff access must be explicitly opted in per-endpoint using `requireProOrStaffToken`. This makes staff-denied the safe default everywhere.
- Staff status is re-validated against the database on **every request**, so disabling a staff account takes effect immediately without waiting for token expiry.
- When a staff request passes auth, `req.proUserId` is set to the **owner's** ID, so downstream handlers operate on the owner's data transparently.

---

## Payment Flow

### Contribution link (subscriber-pays-online)

```
Treasurer (web dashboard)
  → POST /web-create-payment-link  (requireProOrStaffToken)
  → lib/gateways.js resolveProvider() — picks Razorpay/Stripe/PayPal
  → Razorpay: paymentLink.create()
  → Stripe: checkout.sessions.create()
  → Returns { provider, id, url }

Subscriber opens url → pays on gateway's page

Gateway → POST /webhook/razorpay or /webhook/stripe
  → Signature verified with the TREASURER'S secret (from pro_integrations, decrypted)
  → Payment marked as collected, receipt generated, mirror writes queued
```

### Platform subscription (treasurer pays Aftech)

Handled by the same Razorpay webhook but routed to the platform's own Razorpay account (env var keys), not the treasurer's integration row.

### Webhook routing

The webhook endpoint (`/webhook/razorpay`) inspects `notes.type` in the unverified payload to decide which secret to use for verification. Reading the unverified body is safe here because the signature check still happens before any action is taken.

---

## Goal Rollover Engine

Monthly, yearly, and installment goals auto-roll-over at period boundaries. The engine (`utils/rolloverEngine.js`) runs:

1. **At startup** — 30 seconds after server boot (catches periods missed while the server was down)
2. **Hourly** — checks if the calendar day has advanced and runs if so
3. **On demand** — via `POST /cron/run-rollovers` (protected by `CRON_SECRET`)

On rollover, for each eligible goal:
- The current goal is marked `completed`
- A new goal is created for the next period
- Every subscriber is carried over with any unpaid arrears from the previous period added on top of their normal recurring amount
- Advance credit (negative breakup items from overpayments) is preserved across rollovers
- Mirror writes for the new goal and updated subscriptions are run strictly in sequence (target row first, then subscription rows) to avoid foreign-key race conditions

Installment goals auto-stop rolling over once `installmentsPaid` reaches `totalInstallments`.

---

## Security Measures

| Layer | What |
|---|---|
| CORS | Allow-list of known origins; Capacitor `null` origin allowed; GitHub Codespace previews allowed |
| Security headers | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `X-XSS-Protection`, `Referrer-Policy`, `Permissions-Policy`; `X-Powered-By` removed |
| Body size limits | 50 KB default; 10 MB for import/sync routes; raw body for webhook |
| Rate limiting | In-memory sliding window per IP+path (`middleware/rateLimit.js`) |
| Brute-force protection | In-memory lockout counter per identifier (`middleware/bruteForce.js`); shared singleton so lockout counts aren't fragmented across route files |
| Gateway secret encryption | AES-256-GCM with a SHA-256-derived key (`utils/cryptoVault.js`); encrypted at rest in Supabase |
| Webhook verification | HMAC-SHA256 against raw body before any action |
| Password hashing | bcryptjs |
| OTP expiry | 5-minute window; one active OTP per email at a time |

---

## Data Flow — Key Operations

### Monthly contribution collection (web dashboard, cash/offline)

```
POST /web-collect-payment
  requireProOrStaffToken
  → Read pro_user_data (JSON columns)
  → Find contributor + goal
  → Compute remaining breakup (arrears-aware)
  → Increment pro_users.total_receipts_generated
  → Write updated contribution + breakup back to pro_user_data
  → Mirror write: contributions, pledges tables
  → Return receipt data to frontend
  → Frontend generates PDF receipt in browser (jsPDF)
```

### Mobile app sync

```
POST /pro/sync
  requireProToken (pro_app or pro_web only — staff tokens rejected)
  → Ownership check: req.proMobile must match pro_user_data.user_id's owner mobile
  → Read entire pro_user_data JSON blob
  → Merge incoming app state (last-write-wins per field)
  → Write back to pro_user_data
  → Mirror write: mirrorFullSyncBatch() — one upsert per table for all rows at once
```

---

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | No (default 3000) | HTTP listen port |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_KEY` | Yes | Supabase service-role key |
| `JWT_SECRET` | Yes | Signs all JWT tokens; also fallback encryption key |
| `INTEGRATION_ENC_KEY` | Recommended | Primary key for AES-256-GCM encryption of gateway secrets (falls back to JWT_SECRET if absent) |
| `RAZORPAY_KEY_ID` | Yes (platform payments) | Platform Razorpay key for subscription billing |
| `RAZORPAY_KEY_SECRET` | Yes (platform payments) | Platform Razorpay secret |
| `RAZORPAY_WEBHOOK_SECRET` | Yes (platform webhooks) | Platform Razorpay webhook signature key |
| `RESEND_API_KEY` | Yes (email OTP) | Resend transactional email API key |
| `ANTHROPIC_API_KEY` | No | Claude API key for the AI assistant fallback; local intent parser works without it |
| `CRON_SECRET` | Yes | Protects the manual rollover trigger endpoint |
| `ADMIN_PASSWORD_HASH` | Yes | bcrypt hash for the platform admin login |

---

## Module Map

```
server.js               Entry point — Express setup, security headers, CORS, body parsing,
                        404/error handlers, goal rollover scheduler

middleware/
  auth.js               JWT verification; all token types + issuer helpers
  bruteForce.js         Shared in-memory lockout store
  rateLimit.js          Shared in-memory rate-limit store

lib/
  supabase.js           Shared Supabase client singleton
  razorpay.js           Platform Razorpay client + per-user client builder
  gateways.js           Provider-agnostic gateway layer (Razorpay/Stripe/PayPal)
  pricing.js            Subscription pricing, receipt cap, unique-subscriber counting

routes/
  index.js              Mounts all route files
  adminAuth.js          Platform admin login
  adminStats.js         Platform admin statistics
  adminSettings.js      Platform integration + pricing admin
  adminTickets.js       Support ticket management
  adminSubscriptions.js Subscription lookup and extension
  adminAssistant.js     AI assistant escalation log
  payments.js           Razorpay + Stripe + PayPal webhooks
  pro.js                Mobile app sync, auth, payment links, lookup
  emailOtp.js           OTP send/verify
  importExport.js       Bulk import (contributors, goals)
  mpinDevice.js         MPIN and device-key management
  pledgeQr.js           QR-code pledge collection (public)
  contact.js            Aftech website contact form
  cron.js               Manual rollover trigger
  misc.js               Visitor counter

  web/
    index.js            Mounts all web sub-routes
    auth.js             Web dashboard login/register with OTP gate
    billing.js          Subscription renewal / upgrade requests
    dashboard.js        Main data endpoint (/web-dashboard-data)
    collections.js      Payment collection + deletion
    contributors.js     Add / edit / delete contributors
    goals.js            Goal CRUD, subscribe/unsubscribe, rollover stop
    pledges.js          Pledge creation
    settings.js         Gateway integration, currency, profile
    tickets.js          Support ticket creation + listing
    whatsapp.js         WhatsApp Business integration + bulk send
    expenses.js         Expense recording, payee management
    assistant.js        AI assistant chat (local intent + Claude fallback)

utils/
  rolloverEngine.js     Daily goal rollover logic
  mirrorWrite.js        Best-effort dual-write to normalized tables
  arrears.js            Arrears-aware due calculation (server-side copy)
  idGen.js              Globally-unique ID generation (userId-prefixed + Postgres sequence)
  cryptoVault.js        AES-256-GCM encrypt/decrypt for gateway secrets
  email.js              Resend email helper + OTP generator
  otpAuth.js            OTP create-and-send + verify helpers
  sanitize.js           Input sanitizer
  readFromNormalized.js Shadow-read from normalized tables (comparison only, not yet serving reads)
  gatewayValidation.js  Gateway key format validation + masking
  assistantLocalIntent.js Local NLP intent parser (8 languages, no AI cost)

sql/
  contact_inquiries.sql Table definition for website contact form
  staff_users.sql       Staff accounts + contributions attribution columns
  staff_login_id.sql    Staff login helper
```

---

## Standards Review

### What follows industry best practices
- Modular route splitting (each concern in its own file)
- Shared middleware singletons (brute-force and rate-limit stores are intentionally not per-file)
- Security headers on every response
- Raw body preserved for webhook signature verification before JSON parsing
- Gateway secrets encrypted at rest with authenticated encryption (AES-GCM)
- Staff permissions default-denied, opt-in per endpoint
- DB-side staff status re-check on every request (can't be bypassed by holding a valid token)
- OTP single-use + 5-minute expiry
- In-process rollover scheduler with catch-up on boot (no external cron dependency)
- Mirror writes are best-effort (never fail real requests)

### Known gaps / follow-up items
- **No automated tests** — `npm test` is a placeholder
- **In-memory rate limiting and brute-force stores** reset on server restart (Render spins down on idle); a Redis-backed store would survive deploys and scale across multiple instances
- **No request logging middleware** (Morgan or equivalent); errors are logged to console only
- **PayPal not fully implemented** — functions exist but `createContributionLink` for PayPal is partially wired; marked in code
- **Shadow-read mode** — normalized tables receive writes but reads still come from the JSON blob; the migration is in progress
- **No TypeScript** on the backend — adds risk of runtime type errors that `tsc --noEmit` would have caught
- **`ANTHROPIC_API_KEY` in `.env`** — no documentation of rate/cost controls for the AI assistant endpoint

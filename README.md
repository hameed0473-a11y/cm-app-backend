# CM App — Backend API

Node.js + Express 5 REST API for the Collection Management App by Aftech Software Services. Deployed at `api.aftechs.in` on Render.

## What it does

Provides all data and business logic for:
- The **Pro Web Dashboard** (`cm.aftechs.in`) — treasurer-facing collection management
- The **CM mobile app** (iOS/Android, Capacitor) — field collection and sync
- Public **payment landing pages** — subscribers pay via Razorpay/Stripe/PayPal links
- The **Aftech company website** (`aftechs.in`) — contact form ingestion

## Tech stack

| | |
|---|---|
| Runtime | Node.js (CommonJS) |
| Framework | Express 5 |
| Database | Supabase (PostgreSQL) |
| Auth | JWT (jsonwebtoken) |
| Payments | Razorpay, Stripe, PayPal |
| Email | Resend (HTTP API — avoids SMTP port blocking on Render) |
| Encryption | AES-256-GCM via Node `crypto` |
| AI assistant | Claude API (Anthropic) + local intent parser fallback |

## Project structure

```
server.js           Entry point
middleware/         Auth, rate limiting, brute-force protection
lib/                Shared clients: Supabase, Razorpay, multi-gateway layer, pricing
routes/             All API handlers
  index.js          Root router — mounts everything
  web/              Web dashboard routes (auth, data, collections, goals, etc.)
  payments.js       Webhook handlers for all three gateways
  pro.js            Mobile app sync and auth
  ...               Other route files (see routes/README.md)
utils/              Business logic: rollover engine, mirror writes, ID generation, etc.
sql/                One-time migration SQL snippets (run in Supabase SQL editor)
```

## Setup

### Prerequisites
- Node.js 18+
- A Supabase project with the CM App schema applied
- A Razorpay account (platform billing) and/or per-user gateway credentials
- A Resend account for transactional email

### Install and run

```bash
npm install
cp .env.example .env   # fill in values — see Environment Variables below
node server.js
```

For development with auto-restart:
```bash
npm install -g nodemon
nodemon server.js
```

### Environment variables

Create a `.env` file in the project root:

```
PORT=3000

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-service-role-key

# JWT — signs all tokens; also fallback encryption key for gateway secrets
JWT_SECRET=a-long-random-string

# Gateway secret encryption (recommended: separate from JWT_SECRET)
INTEGRATION_ENC_KEY=another-long-random-string

# Platform Razorpay (Aftech's own account — subscription billing only)
RAZORPAY_KEY_ID=rzp_live_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...

# Transactional email
RESEND_API_KEY=re_...

# AI assistant (optional — local intent parser works without it)
ANTHROPIC_API_KEY=sk-ant-...

# Manual cron trigger protection
CRON_SECRET=...

# Platform admin login
ADMIN_PASSWORD_HASH=...   # bcrypt hash of the admin password
```

## Key concepts

### Token types
Four JWT types are in use. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full auth flow.

### Dual-write migration
The system is mid-migration from a single JSON blob per user (`pro_user_data`) to normalized relational tables. Writes go to both; reads still come from the JSON blob. `utils/mirrorWrite.js` handles the shadow writes. `utils/readFromNormalized.js` is the future read path (shadow-read mode only, not yet serving production reads).

### Goal rollover
Monthly/yearly/installment goals auto-advance at period boundaries. The engine runs in-process — no external cron setup needed. See `utils/rolloverEngine.js` and the comment block in `server.js`.

### Payment webhook routing
A single webhook endpoint handles both platform billing events and per-treasurer contribution events. The routing logic selects which Razorpay secret to verify against based on `notes.type` in the event payload. See `routes/payments.js`.

## Deployment (Render)

The `server.js` is the start command. Set all environment variables in the Render service dashboard. The service can be deployed as a Web Service (not a background worker) — the goal rollover scheduler is built into the process itself.

## See also

- [ARCHITECTURE.md](ARCHITECTURE.md) — full system architecture, auth flow, data flow diagrams, module map, and standards review
- [routes/README.md](routes/README.md) — route file index
- [routes/web/README.md](routes/web/README.md) — web dashboard routes
- [middleware/README.md](middleware/README.md) — auth and security middleware
- [lib/README.md](lib/README.md) — shared library modules
- [utils/README.md](utils/README.md) — utility and business-logic modules
- [sql/README.md](sql/README.md) — database migration snippets

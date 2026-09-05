# utils/

Business logic and shared helpers. None of these files define Express routes; they are imported by route files and by each other.

## rolloverEngine.js

Automatic goal rollover. Monthly, yearly, and installment goals advance to the next period at a boundary: the old goal is marked `completed`, a new one is created, and every subscriber carries over with any unpaid arrears compounded on top of their normal recurring amount.

Key design decisions:
- **In-process scheduler** (no external cron) — runs 30 s after boot then hourly. Catches missed periods even if the server was down.
- **Arrears-forward** — a subscriber who owes from period N carries that balance into period N+1 as a labeled line item. Advance credit (negative balance from overpayment) is also preserved.
- **Mirror writes run in order** — target row is inserted before its subscription rows to satisfy the foreign-key constraint in the normalized tables.
- **Idempotency guard** — checks for an existing goal with the same `rolloverBaseName` + `rolloverPeriodKey` before creating, so running twice around a period boundary doesn't duplicate goals.

## mirrorWrite.js

Best-effort dual writes to the normalized relational tables during the JSON-to-normalized migration. **Never throws, never blocks a request.** Failures are logged as warnings only.

The `mirrorFullSyncBatch()` export is a special bulk path for `/pro/sync` — batches all upserts into one call per table instead of one call per row, because the app pushes its entire state on every sync.

## arrears.js

Server-side copy of the arrears-aware due calculation from the mobile app's `arrearsUtils.ts`. Kept in sync so amounts returned by the API (for the payment landing page) always match what the app and website show. Used by `routes/pro.js`.

## idGen.js

Globally unique ID generator. Format: `<userId>-<entityCode>-<seq>` (e.g. `pro-59476314-gm-0001`). Sequence numbers come from a Postgres function (`public.next_seq`) so concurrent requests for the same user can't collide. The user-ID prefix means IDs from different accounts can never collide either.

## cryptoVault.js

AES-256-GCM encryption for gateway API secrets stored in Supabase. The key is derived from `INTEGRATION_ENC_KEY` (preferred) or `JWT_SECRET` (fallback) via SHA-256. Output format: `iv:tag:ciphertext` (base64-encoded, colon-separated). `decrypt()` returns `null` on any tampering or format error rather than throwing, so a corrupt row can't crash a payment flow.

## email.js

Resend HTTP API wrapper for transactional email. Uses HTTP (not SMTP) to avoid port-blocking on Render. Also exports `generateOtp()` (6-digit numeric OTP).

## otpAuth.js

Shared OTP helpers for the web registration and login flows. `createAndSendEmailOtp()` clears any existing unused OTP for the same email before inserting a new one (one active OTP per email at a time). `wasOtpVerified()` confirms that `/verify-email-otp` was actually called before a registration or login completes — the registration/login finalize step cannot be reached without going through OTP verification first.

## sanitize.js

Strips `< > " ' % ; ( ) & +` from strings. Minimal sanitizer used for user-controlled text that ends up in HTML email bodies.

## readFromNormalized.js

Shadow-read path for the normalized tables: `fetchNormalizedUserData()` reconstructs the same nested JSON shape the app expects, and `shadowReadCheck()` compares it against the authoritative JSON blob and logs any mismatches. **Nothing here is served to clients yet.** Used for migration validation only.

## gatewayValidation.js

Key format validation and masking shared between the web settings route and the admin settings route, so the same format rules and the same `••••xxxx` masking logic apply in both places.

## assistantLocalIntent.js

Local NLP intent parser for the AI assistant. Handles goal creation, subscriber management, payment collection, and common FAQ questions in 8 languages (English, German, French, Spanish, Arabic, Russian, Portuguese, Chinese) using keyword matching and multi-turn confirm-first flows. Returns `{ handled: true }` if it recognized the intent; the route only calls Claude if `handled` is `false`. This keeps the common, structured operations free and fast regardless of whether `ANTHROPIC_API_KEY` is set.

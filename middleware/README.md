# middleware/

Express middleware used across route files.

## auth.js

JWT verification and token issuance. Exports:

- **`requireAdmin`** — Verifies `role: 'admin'` JWT. Used only on admin-facing routes.
- **`requireProWebToken`** — Verifies `type: 'pro_web'` JWT. Web dashboard session tokens only. Sets `req.proMobile` and `req.proUserId`.
- **`requireProToken`** — Verifies `type: 'pro_app'` or `type: 'pro_web'`. Used on routes the mobile app calls directly (notably `/pro/sync`). Explicitly rejects `pro_staff` tokens.
- **`requireProOrStaffToken`** — Accepts `pro_app`, `pro_web`, or `pro_staff`. For staff tokens, re-queries `staff_users` on every call to confirm the account is still active, then sets `req.proUserId` to the **owner's** ID so downstream handlers see owner data transparently. Also sets `req.isStaff`, `req.staffId`, `req.staffName`.
- **`issueProAppToken(userId, mobile)`** — Issues a 90-day `pro_app` JWT.
- **`issueStaffToken(...)`** — Issues a 7-day `pro_staff` JWT.

**Why staff tokens get DB re-validation but owner tokens do not:** Owner tokens are long-lived (90d) and account deletion is rare; the cost of a DB round trip on every mobile sync would be too high. Staff accounts can be disabled quickly by an owner, so the check must be live.

## bruteForce.js

In-memory lockout for failed login/OTP attempts. Shared singleton — **must not be split into per-file instances**, or a locked-out identifier would reset between the files that check it.

Exports `checkBruteForce(id, maxAttempts, lockoutMs)`, `recordFailedAttempt(id, maxAttempts, lockoutMs)`, `clearBruteForce(id)`.

Identifiers are namespaced by callers (e.g. `"mpin:9876543210"`) to avoid collisions between different auth mechanisms.

**Limitation:** Resets on server restart (Render spins down idle services). A Redis-backed store would survive restarts and scale horizontally.

## rateLimit.js

In-memory sliding-window rate limiter. Returns an Express middleware: `rateLimit(maxRequests, windowMs)`. Shared singleton for the same reason as `bruteForce.js`.

Cleans up stale entries every 10 minutes to prevent unbounded memory growth.

**Same limitation:** In-memory; resets on restart.

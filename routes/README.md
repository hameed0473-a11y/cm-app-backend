# routes/

All Express route handlers. `index.js` is the root router mounted by `server.js` at `/api/auth`; it mounts every other file here in order.

## File index

| File | Path prefix | Description |
|---|---|---|
| `index.js` | `/api/auth` | Mounts all route files below |
| `adminAuth.js` | `/admin-login` | Platform admin login (password + JWT) |
| `adminStats.js` | `/admin-stats` | Platform-wide statistics for the admin dashboard |
| `adminSettings.js` | `/admin-platform-settings`, `/admin-save-integration`, `/admin-save-bank-details`, `/admin-save-pricing` | Platform gateway and pricing admin |
| `adminTickets.js` | `/admin-tickets`, `/admin-resolve-ticket` | Support ticket management |
| `adminSubscriptions.js` | `/admin-find-subscriber`, `/admin-extend-subscription` | Lookup and manually extend a treasurer's subscription |
| `adminAssistant.js` | `/admin-assistant-escalations` | Log of AI assistant turns that fell through to Claude |
| `payments.js` | `/webhook/razorpay`, `/webhook/stripe`, `/webhook/paypal` | Payment gateway webhook handlers |
| `pro.js` | `/pro/*` | Mobile app: registration, login, data sync, payment links, dues lookup |
| `emailOtp.js` | `/send-email-otp`, `/verify-email-otp` | OTP send and verify |
| `importExport.js` | `/import-contributors`, `/import-goals` | Bulk import from Excel |
| `mpinDevice.js` | `/check-device`, `/save-device-key`, `/verify-device-key`, `/set-mpin`, `/verify-mpin` | MPIN and device-key management for the mobile app |
| `pledgeQr.js` | `/pledge-qr-*` | Public QR-code-based pledge collection (no auth required) |
| `contact.js` | `/contact-inquiry` | Aftech website contact form submission |
| `cron.js` | `/cron/run-rollovers` | Manual/external trigger for the goal rollover engine |
| `misc.js` | `/visitor` | Public page view counter |
| `web/` | All `/web-*` routes | Pro Web Dashboard — see [web/README.md](web/README.md) |

## Auth middleware

Most routes use one of these from `middleware/auth.js`:

- `requireAdmin` — `role: 'admin'` JWT only
- `requireProToken` — `type: 'pro_app'` or `type: 'pro_web'`; rejects `pro_staff`
- `requireProWebToken` — `type: 'pro_web'` only
- `requireProOrStaffToken` — `pro_app`, `pro_web`, or `pro_staff`; staff re-validated against DB on every call

The pledge QR and payment landing page routes are public (no auth).

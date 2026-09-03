# routes/web/

Web dashboard route handlers. All paths remain exactly as they were before the route file was split from the original monolithic `routes/web.js`, so the website's existing API calls resolve without any changes.

Mounted by `routes/index.js` via `require('./web')`, which Node resolves to this directory's `index.js`.

## File index

| File | Key endpoints | Auth |
|---|---|---|
| `auth.js` | `POST /web-login`, `/web-register`, `/web-register-verify`, `/web-login-verify` | Public (OTP-gated) |
| `billing.js` | `POST /web-request-renewal`, `/web-request-upgrade` | `requireProWebToken` |
| `dashboard.js` | `GET /web-dashboard-data` | `requireProOrStaffToken` |
| `collections.js` | `POST /web-collect-payment`, `DELETE /web-delete-payment` | `requireProOrStaffToken` |
| `contributors.js` | `POST /web-add-contributors`, `/web-edit-contributor`, `/web-delete-contributor` | `requireProOrStaffToken` (add/edit); `requireProWebToken` (delete) |
| `goals.js` | `POST /web-create-target`, `/web-subscribe-contributors`, `/web-unsubscribe-contributors`, `/web-delete-target`, `/web-set-installment-amount`, `/web-stop-rollover`, `/web-archive-goal` | `requireProWebToken` |
| `pledges.js` | `POST /web-create-pledge`, `/web-collect-pledge-payment`, `/web-delete-pledge` | `requireProOrStaffToken` (collect); `requireProWebToken` (create/delete) |
| `settings.js` | `POST /web-save-integration`, `/web-remove-integration`, `/web-set-currency`, `/web-set-profile`; `GET /web-integration-status` | `requireProWebToken` |
| `tickets.js` | `POST /web-raise-ticket`; `GET /web-my-tickets` | `requireProWebToken` |
| `whatsapp.js` | `POST /web-save-whatsapp-integration`, `/web-remove-whatsapp-integration`, `/web-send-whatsapp-bulk`; `GET /web-whatsapp-integration-status` | `requireProWebToken` |
| `expenses.js` | `POST /web-add-expense`, `/web-delete-expense`, `/web-add-payee`, `/web-delete-payee`, `/web-link-payee-category`; `GET /web-expenses` | `requireProWebToken` |
| `assistant.js` | `POST /assistant-chat` | `requireProWebToken` |

## Auth note

`requireProOrStaffToken` is used on endpoints where staff are allowed to act (reading data, adding contributors, collecting payments). All other endpoints use `requireProWebToken`, which rejects staff tokens. This is deliberate — staff access is opt-in per endpoint, not granted by default. See `middleware/auth.js` for the implementation.

## Web login flow

1. `POST /web-login` — validates credentials (owner or staff), sends OTP email, returns `stateId`
2. `POST /verify-email-otp` — verifies OTP, marks it `used`
3. `POST /web-login-verify` — confirms OTP was verified, issues `pro_web` or `pro_staff` JWT

Registration uses the same OTP gate:
1. `POST /web-register` — validates new account details, sends OTP
2. `POST /verify-email-otp` — verifies OTP
3. `POST /web-register-verify` — confirms OTP, creates account, issues `pro_web` JWT

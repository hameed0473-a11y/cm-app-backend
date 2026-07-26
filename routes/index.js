const express = require('express');

// ---------------------------------------------------------------
// Mounts every split route file. server.js still does
// `app.use('/api/auth', require('./routes'))`, and each file below
// defines its paths exactly as they were in the original
// monolithic routes/auth.js (e.g. '/register', '/pro/sync',
// '/web-login') — so every URL the mobile app and website already
// call resolves to the exact same place as before this split.
// ---------------------------------------------------------------
const router = express.Router();

router.use(require('./adminAuth'));      // /admin-login
router.use(require('./mpinDevice'));     // /check-device, /save-device-key, /verify-device-key
router.use(require('./payments'));       // /webhook/razorpay, /webhook/stripe
router.use(require('./pro'));            // /pro/* (register, login, sync, verify, users, lookup-dues, payment links, append-*)
router.use(require('./emailOtp'));       // /send-email-otp, /verify-email-otp
router.use(require('./importExport'));   // /import-contributors, /import-goals
router.use(require('./web'));            // /web-login, /web-dashboard-data, /web-collect-payment, /web-add-contributors, /web-edit-contributor, /web-delete-contributor, and everything else split under routes/web/
router.use(require('./adminSettings'));  // /admin-platform-settings, /admin-save-integration, /admin-remove-integration, /admin-save-bank-details, /admin-save-pricing
router.use(require('./adminStats'));     // /admin-stats
router.use(require('./adminTickets'));   // /admin-tickets, /admin-resolve-ticket
router.use(require('./adminSubscriptions')); // /admin-find-subscriber, /admin-extend-subscription
router.use(require('./misc'));           // /visitor
router.use(require('./pledgeQr'));       // /pledge-qr-info, /pledge-qr-lookup, /pledge-qr-new-pledge, /pledge-qr-pay-existing, /pledge-qr-anonymous-pay
router.use(require('./contact'));        // /contact-inquiry
router.use(require('./cron'));           // /cron/run-rollovers (manual/external fallback trigger)

module.exports = router;

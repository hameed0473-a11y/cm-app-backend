const express = require('express');
const router = express.Router();

// ---------------------------------------------------------------
// Mounts every split file that used to be the single, ~1,460-line
// routes/web.js. Each file defines its paths exactly as they were in
// the original — so every URL the website already calls (all under
// /api/auth, since routes/index.js does router.use(require('./web')),
// and Node resolves that to this directory's index.js automatically)
// resolves to the exact same place as before this split.
// ---------------------------------------------------------------
router.use(require('./auth'));         // /web-login, /web-register, /web-register-verify, /web-login-verify
router.use(require('./billing'));      // /web-request-renewal, /web-request-upgrade
router.use(require('./dashboard'));    // /web-dashboard-data
router.use(require('./collections'));  // /web-collect-payment, /web-delete-payment
router.use(require('./contributors')); // /web-add-contributors, /web-edit-contributor, /web-delete-contributor
router.use(require('./goals'));        // /web-create-target, /web-subscribe-contributors, /web-unsubscribe-contributors, /web-delete-target
router.use(require('./pledges'));      // /web-create-pledge
router.use(require('./settings'));     // /web-save-integration, /web-integration-status, /web-set-currency, /web-remove-integration, /web-set-profile
router.use(require('./tickets'));      // /web-raise-ticket, /web-my-tickets
router.use(require('./whatsapp'));     // /web-save-whatsapp-integration, /web-whatsapp-integration-status, /web-remove-whatsapp-integration, /web-send-whatsapp-bulk
router.use(require('./expenses'));     // /web-add-expense, /web-expenses, /web-delete-expense
router.use(require('./assistant'));    // /assistant-chat

module.exports = router;

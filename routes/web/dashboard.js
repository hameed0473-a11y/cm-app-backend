const express = require('express');
require('dotenv').config();

const supabase = require('../../lib/supabase');
const { requireProOrStaffToken } = require('../../middleware/auth');
const { computeAmountDue, countUniqueSubscribers, getMaxReceipts, getReceiptUsage } = require('../../lib/pricing');
const { fetchNormalizedUserData, compareUserData } = require('../../utils/readFromNormalized');
const { SUPPORTED_CURRENCIES } = require('../../lib/gateways');

const router = express.Router();

// ===============================================================
// PRO WEB DASHBOARD — the single read endpoint the website's dashboard
// polls/loads from. Returns cloud data + profile info (onboarding state,
// trial/pricing info, receipt usage).
// ===============================================================

// Reads the same pro_user_data table /pro/sync already writes to from
// the app, so there's a single source of truth — this just adds a
// properly authenticated read path for the website.
// ---------------------------------------------------------------
router.get('/web-dashboard-data', requireProOrStaffToken, async (req, res) => {
  try {
    const { data: userData, error } = await supabase
      .from('pro_user_data')
      .select('*')
      .eq('user_id', req.proUserId)
      .single();

    if (error) return res.status(500).json({ error: error.message });

    const oldData = userData || { contributors: [], targets: [], contributions: [], pledges: [] };

    // CUTOVER: serve the reconstructed data from the new normalized tables.
    // If that fetch fails for any reason, fall back to the old JSON rather
    // than erroring out to the client — this endpoint should never go down
    // because of the new tables having a transient problem.
    let responseData = oldData;
    let servedFromNewTables = false;
    try {
      responseData = await fetchNormalizedUserData(supabase, req.proUserId);
      servedFromNewTables = true;
    } catch (err) {
      console.warn('[cutover] new-table read failed, falling back to old JSON:', err?.message || err);
    }

    // Profile fields for the onboarding pop-up (account type / category /
    // currency). The frontend shows the one-time setup pop-up when
    // accountType is still null.
    const { data: profileRow } = await supabase
      .from('pro_users')
      .select('account_type, category, currency, country_code, name, subscription_expires_at, paid_subscriber_count, receipts_per_subscriber, total_receipts_generated')
      .eq('id', req.proUserId)
      .single();

    const subscriberCount = countUniqueSubscribers(responseData?.contributors, responseData?.pledges);
    const expiresAtIso = profileRow?.subscription_expires_at || null;
    const daysRemaining = expiresAtIso
      ? Math.max(0, Math.ceil((new Date(expiresAtIso).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
      : null;
    const maxReceipts = getMaxReceipts(profileRow?.paid_subscriber_count, profileRow?.receipts_per_subscriber);
    const pricing = await computeAmountDue(subscriberCount, profileRow?.currency || 'INR');

    const profile = {
      accountType: profileRow?.account_type || null,
      category: profileRow?.category || null,
      currency: profileRow?.currency || 'INR',
      countryCode: profileRow?.country_code || null,
      name: profileRow?.name || null,
      // Drives the "here's what you'll pay after your trial" pop-up shown
      // once at first login — see lib/pricing.js. No charge happens here,
      // this is informational only.
      trialInfo: {
        subscriptionExpiresAt: expiresAtIso,
        daysRemaining,
        pricing
      },
      // Drives the persistent "you've used 90% of your receipt limit"
      // banner — recomputed on every dashboard load, not just right after
      // a collection, so it's visible even if the last collection that
      // crossed the threshold happened on another device/session.
      receiptUsage: getReceiptUsage(profileRow?.total_receipts_generated, maxReceipts),
      // Current billed subscriber count — null if never billed yet (still
      // on trial). Drives the "Billing" section's "you're currently
      // covered for N subscribers" baseline for the upgrade picker.
      paidSubscriberCount: profileRow?.paid_subscriber_count ?? null
    };

    res.json({
      success: true,
      data: responseData,
      profile,
      supportedCurrencies: SUPPORTED_CURRENCIES,
      // Lets the frontend re-derive role/name after a fresh page load even
      // if sessionStorage was cleared for some reason — never trusted for
      // authorization itself, every write endpoint re-checks the token.
      role: req.isStaff ? 'staff' : 'owner',
      staffName: req.isStaff ? req.staffName : null,
      // The OWNER's id, even for a staff session — needed client-side to
      // build the public pledge-QR payment URL (/pledge-pay/:proUserId/:targetId).
      proUserId: req.proUserId
    });

    // Ongoing monitoring — runs AFTER the response is already sent. Now that
    // we're serving from the new tables, this checks the old JSON still
    // agrees, catching any future drift between the two while both are
    // still being kept (writes remain dual-write for now).
    if (servedFromNewTables) {
      const diffs = compareUserData(oldData, responseData);
      if (diffs.length > 0) {
        console.warn(`[post-cutover] drift detected for user ${req.proUserId}:`);
        diffs.forEach(d => console.warn(`  - ${d}`));
      }
    }
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});


module.exports = router;

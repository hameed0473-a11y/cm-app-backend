const express = require('express');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const supabase = require('../../lib/supabase');
const { rateLimit } = require('../../middleware/rateLimit');
const { checkBruteForce } = require('../../middleware/bruteForce');
const { requireProWebToken } = require('../../middleware/auth');
const { computeAmountDue } = require('../../lib/pricing');

const router = express.Router();

// ===============================================================
// PRO WEB DASHBOARD — renewal + mid-cycle upgrade requests. Neither
// endpoint here collects any real payment yet (no gateway wired up) —
// both just record what the treasurer asked for
// (requested_subscriber_count/requested_plan_type/requested_at) for
// manual follow-up. See RECEIPT_LIMIT_SETUP.md / RENEWAL_PLAN_PICKER_SETUP.md
// / UPGRADE_SUBSCRIBERS_SETUP.md for the full picture.
// ===============================================================

// ---------------------------------------------------------------
// WEB REQUEST RENEWAL — used on the "Trial Ended" screen once
// web-login has responded with trialExpired: true. The treasurer picks
// either an exact subscriber count or a 50-wide bundle (up to 1000;
// above that they type an exact number instead), and this records that
// choice on the account so you can see what to bill them.
//
// This does NOT collect any payment or extend subscription_expires_at —
// there's no live gateway wired up yet. It only saves
// requested_subscriber_count/requested_plan_type/requested_at, which is
// purely informational for you until you manually renew via
// `UPDATE pro_users SET paid_subscriber_count = ...` after actually
// collecting payment outside the system (see RECEIPT_LIMIT_SETUP.md).
//
// No session token exists at this point (that's the whole reason
// they're here), so identity is re-confirmed with mobile+password —
// same check /web-login itself does against `users`, not `pro_users`.
// ---------------------------------------------------------------
router.post('/web-request-renewal', rateLimit(10, 15 * 60000), async (req, res) => {
  const { mobile, password, requestedCount, planType } = req.body;
  if (!mobile || !password || requestedCount == null) {
    return res.status(400).json({ error: 'mobile, password, and requestedCount are required' });
  }

  const count = Math.max(1, Math.floor(Number(requestedCount) || 0));
  if (!count) return res.status(400).json({ error: 'Enter a valid subscriber count.' });

  const bruteCheck = checkBruteForce(`renewal-request:${mobile}`, 5, 30 * 60000);
  if (bruteCheck.blocked) {
    return res.status(429).json({ error: bruteCheck.message });
  }

  try {
    const { data: userRow, error: userError } = await supabase
      .from('users')
      .select('password')
      .eq('mobile', mobile)
      .single();

    if (userError || !userRow || !userRow.password) {
      return res.status(404).json({ error: 'No account found with this mobile number.' });
    }

    let isMatch = false;
    if (userRow.password.startsWith('$2')) {
      isMatch = await bcrypt.compare(password, userRow.password);
    } else {
      isMatch = userRow.password === password;
    }
    if (!isMatch) return res.status(401).json({ error: 'Incorrect password. Please try again.' });

    const { data: proUser, error: proError } = await supabase
      .from('pro_users')
      .select('id, currency')
      .eq('mobile', mobile)
      .single();

    if (proError || !proUser) return res.status(404).json({ error: 'Pro account not found.' });

    const { error: updateError } = await supabase
      .from('pro_users')
      .update({
        requested_subscriber_count: count,
        requested_plan_type: planType === 'bundle' ? 'bundle' : 'exact',
        requested_at: new Date().toISOString()
      })
      .eq('id', proUser.id);

    if (updateError) return res.status(500).json({ error: updateError.message });

    const pricing = await computeAmountDue(count, proUser.currency);
    res.json({ success: true, requestedCount: count, pricing });
  } catch (err) {
    console.error('web-request-renewal error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ---------------------------------------------------------------
// WEB REQUEST UPGRADE — the in-dashboard version of the renewal
// request above, for an account that's still active and wants to
// increase its subscriber limit mid-cycle. Already authenticated (has
// a valid session), so no mobile+password re-check needed here.
//
// Per spec: the additional cost is the FULL annual rate for just the
// extra subscribers being added (newTotal - currentPaid), not prorated
// by time remaining — and this endpoint never writes to
// subscription_expires_at, so the renewal date never moves just because
// someone increased their limit.
//
// Same as /web-request-renewal, this only RECORDS the request
// (requested_subscriber_count/requested_plan_type/requested_at) — no
// live charge happens here yet. You manually set paid_subscriber_count
// after collecting the additional payment, exactly as before.
// ---------------------------------------------------------------
router.post('/web-request-upgrade', requireProWebToken, async (req, res) => {
  const { requestedCount, planType } = req.body;
  if (requestedCount == null) {
    return res.status(400).json({ error: 'requestedCount is required' });
  }

  const newTotal = Math.max(1, Math.floor(Number(requestedCount) || 0));
  if (!newTotal) return res.status(400).json({ error: 'Enter a valid subscriber count.' });

  try {
    const { data: proUser, error } = await supabase
      .from('pro_users')
      .select('id, currency, paid_subscriber_count')
      .eq('id', req.proUserId)
      .single();

    if (error || !proUser) return res.status(404).json({ error: 'Account not found.' });

    const baseline = proUser.paid_subscriber_count || 0;
    if (newTotal <= baseline) {
      return res.status(400).json({
        error: `You're already covered for ${baseline} subscriber${baseline === 1 ? '' : 's'}. Enter a higher number to increase your limit.`
      });
    }
    const additionalCount = newTotal - baseline;

    const { error: updateError } = await supabase
      .from('pro_users')
      .update({
        requested_subscriber_count: newTotal,
        requested_plan_type: planType === 'bundle' ? 'bundle' : 'exact',
        requested_at: new Date().toISOString()
        // Deliberately NOT touching subscription_expires_at here.
      })
      .eq('id', proUser.id);

    if (updateError) return res.status(500).json({ error: updateError.message });

    const additionalPricing = await computeAmountDue(additionalCount, proUser.currency);
    const newTotalPricing = await computeAmountDue(newTotal, proUser.currency);

    res.json({
      success: true,
      baseline,
      requestedCount: newTotal,
      additionalCount,
      additionalPricing,
      newTotalPricing
    });
  } catch (err) {
    console.error('web-request-upgrade error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});


module.exports = router;

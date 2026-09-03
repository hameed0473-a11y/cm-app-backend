const express = require('express');
require('dotenv').config();

const supabase = require('../lib/supabase');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ===============================================================
// ADMIN — MANUAL SUBSCRIPTION EXTENSION
//
// Lets the admin extend a specific treasurer's subscription_expires_at
// by N days directly from the dashboard, instead of running a manual
// SQL UPDATE in Supabase. Typical trigger: a treasurer raises a ticket
// or otherwise contacts support saying they paid but the account still
// shows expired/about to expire — or any other reason days need adding.
// ===============================================================

// --- Look up an account by mobile number ---
router.get('/admin-find-subscriber', requireAdmin, async (req, res) => {
  const mobile = String(req.query.mobile || '').trim();
  if (!mobile) return res.status(400).json({ error: 'mobile is required' });

  try {
    const { data, error } = await supabase
      .from('pro_users')
      .select('id, name, mobile, email, currency, subscription_expires_at, paid_subscriber_count')
      .eq('mobile', mobile)
      .single();

    if (error || !data) return res.status(404).json({ error: 'No Pro account found with this mobile number.' });

    res.json({ success: true, subscriber: data });
  } catch (err) {
    console.error('admin-find-subscriber error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// --- Extend an account's subscription by N days ---
router.post('/admin-extend-subscription', requireAdmin, async (req, res) => {
  const mobile = String(req.body.mobile || '').trim();
  const days = Math.floor(Number(req.body.days));

  if (!mobile) return res.status(400).json({ error: 'mobile is required' });
  if (!Number.isFinite(days) || days <= 0) {
    return res.status(400).json({ error: 'Enter a valid number of days greater than 0.' });
  }

  try {
    const { data: proUser, error } = await supabase
      .from('pro_users')
      .select('id, subscription_expires_at')
      .eq('mobile', mobile)
      .single();

    if (error || !proUser) return res.status(404).json({ error: 'No Pro account found with this mobile number.' });

    const now = Date.now();
    const currentExpiry = proUser.subscription_expires_at ? new Date(proUser.subscription_expires_at).getTime() : now;
    // Extend from whichever is later — "now" if the account's already
    // expired (so it gets a fresh N days starting today, rather than
    // old_expiry + N which could still land in the past), or the
    // existing expiry if still active (so remaining time isn't lost).
    const base = Math.max(currentExpiry, now);
    const newExpiry = new Date(base + days * 24 * 60 * 60 * 1000).toISOString();

    const { error: updateError } = await supabase
      .from('pro_users')
      .update({ subscription_expires_at: newExpiry })
      .eq('id', proUser.id);

    if (updateError) {
      console.error('admin-extend-subscription error:', updateError.message);
      return res.status(500).json({ error: 'Could not extend the subscription.' });
    }

    res.json({ success: true, mobile, daysAdded: days, newExpiry });
  } catch (err) {
    console.error('admin-extend-subscription error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

module.exports = router;

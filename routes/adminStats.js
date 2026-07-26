const express = require('express');
require('dotenv').config();

const supabase = require('../lib/supabase');
const { requireAdmin } = require('../middleware/auth');
const { countUniqueSubscribers } = require('../lib/pricing');

const router = express.Router();

// A phone country code counts as Indian if it normalizes to "91" — covers
// stored forms like "+91", "91", " +91 ", etc. Anything else (including
// missing/unset) is bucketed as Foreign, so total always = indian + foreign.
function isIndianCountryCode(countryCode) {
  return String(countryCode || '').replace(/\D/g, '') === '91';
}

// ===============================================================
// ADMIN — DASHBOARD STATISTICS
//
// Card-level aggregates for the admin "Users" view. Every registered
// user is Pro by default (no separate basic/lite tier anymore), so
// both cards below now read from pro_users directly:
//   Card-1: total users, India/foreign split
//   Card-2: paid (active-subscription) users, India/foreign split
//   Card-3: total subscribers platform-wide — sum of
//           countUniqueSubscribers(contributors, pledges) across EVERY
//           treasurer's pro_user_data row. Not deduped across accounts:
//           the same phone number under two different treasurers counts
//           twice, since they're two separate subscriber relationships.
//   Card-4: support tickets — real counts from support_tickets (raised
//           = every row, solved/pending from each row's status).
// ===============================================================
router.get('/admin-stats', requireAdmin, async (req, res) => {
  try {
    const { data: userRows, error: userError } = await supabase
      .from('pro_users')
      .select('country_code, subscription_expires_at');

    if (userError) {
      console.error('admin-stats users error:', userError.message);
      return res.status(500).json({ error: 'Could not load user stats.' });
    }

    let usersTotal = 0, usersIndian = 0, usersForeign = 0;
    let paidTotal = 0, paidIndian = 0, paidForeign = 0;
    (userRows || []).forEach(u => {
      const indian = isIndianCountryCode(u.country_code);
      usersTotal++;
      if (indian) usersIndian++; else usersForeign++;
      const isActive = u.subscription_expires_at && new Date(u.subscription_expires_at) > new Date();
      if (isActive) {
        paidTotal++;
        if (indian) paidIndian++; else paidForeign++;
      }
    });

    const { data: dataRows, error: dataError } = await supabase
      .from('pro_user_data')
      .select('contributors, pledges');

    if (dataError) {
      console.error('admin-stats pro_user_data error:', dataError.message);
      return res.status(500).json({ error: 'Could not load subscriber stats.' });
    }

    let totalSubscribers = 0;
    (dataRows || []).forEach(r => {
      totalSubscribers += countUniqueSubscribers(r.contributors, r.pledges);
    });

    const { data: ticketRows, error: ticketError } = await supabase
      .from('support_tickets')
      .select('status');

    if (ticketError) {
      console.error('admin-stats tickets error:', ticketError.message);
      return res.status(500).json({ error: 'Could not load ticket stats.' });
    }

    const raised = (ticketRows || []).length;
    const solved = (ticketRows || []).filter(t => t.status === 'solved').length;
    const pending = raised - solved;

    res.json({
      success: true,
      users: { total: usersTotal, indian: usersIndian, foreign: usersForeign },
      paidUsers: { total: paidTotal, indian: paidIndian, foreign: paidForeign },
      totalSubscribers,
      tickets: { raised, solved, pending }
    });
  } catch (err) {
    console.error('admin-stats error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

module.exports = router;

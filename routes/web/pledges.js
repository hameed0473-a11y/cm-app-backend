const express = require('express');
require('dotenv').config();

const supabase = require('../../lib/supabase');
const { requireProToken } = require('../../middleware/auth');
const { mirrorPledge } = require('../../utils/mirrorWrite');

const router = express.Router();

// ===============================================================
// PRO WEB DASHBOARD — Event/Pledge goal subscriber creation (the
// manual "Add pledge" form; bulk goal-import also calls this).
// ===============================================================

// ---------------------------------------------------------------
// WEB CREATE PLEDGE — adds one subscriber's pledge to an event/special
// target, matching the app's Pledges tab "add subscriber" action. A pledge
// is a promise-to-pay record, separate from the contributors/contributions
// arrays, so it gets its own array + its own fetch-fresh-then-append write.
// ---------------------------------------------------------------
router.post('/web-create-pledge', requireProToken, async (req, res) => {
  const { targetId, name, mobile, promisedAmount, contributorId } = req.body;
  if (!targetId || !name || !mobile || !promisedAmount) {
    return res.status(400).json({ error: 'targetId, name, mobile, and promisedAmount are required' });
  }

  try {
    const { data: userData, error } = await supabase
      .from('pro_user_data')
      .select('targets, pledges, contributors')
      .eq('user_id', req.proUserId)
      .single();

    if (error || !userData) return res.status(404).json({ error: 'Could not find your data.' });

    const targets = userData.targets || [];
    const target = targets.find(t => t.id === targetId && t.category === 'event');
    if (!target) return res.status(404).json({ error: 'Event/pledge goal not found.' });

    const pledges = userData.pledges || [];

    const newPledge = {
      id: `pledge-${Date.now().toString().slice(-8)}`,
      targetId,
      targetName: target.name,
      name: name.trim(),
      mobile: mobile.trim(),
      promisedAmount: Number(promisedAmount),
      amountPaid: 0,
      status: 'pending',
      createdAt: new Date().toISOString(),
      ...(contributorId ? { contributorId } : {})
    };
    pledges.push(newPledge);

    const { error: updateError } = await supabase
      .from('pro_user_data')
      .update({ pledges, updated_at: new Date().toISOString() })
      .eq('user_id', req.proUserId);

    if (updateError) return res.status(500).json({ error: updateError.message });

    // Dual-write: mirror the new pledge into the new table too.
    await mirrorPledge(supabase, req.proUserId, newPledge);

    res.json({ success: true, pledge: newPledge });
  } catch (err) {
    console.error('Web create pledge error:', err?.message || err);
    res.status(500).json({ error: 'Failed to add pledge.' });
  }
});


module.exports = router;

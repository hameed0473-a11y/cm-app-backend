const express = require('express');

const supabase = require('../lib/supabase');
const gateways = require('../lib/gateways');
const { rateLimit } = require('../middleware/rateLimit');
const { mirrorPledge } = require('../utils/mirrorWrite');
const { nextId } = require('../utils/idGen');

const router = express.Router();

// ===============================================================
// PLEDGE QR PAYMENTS — a treasurer generates one QR code per event/
// pledge goal (see /web-pledge-qr-info in routes/web/goals.js) and
// posts it at a physical location. Scanning it opens a public,
// unauthenticated page: enter mobile → find an existing pledge and
// pay what's still due, or (if not found) self-declare a name +
// amount and pay that in one step, or donate anonymously with no
// details at all.
//
// Deliberately unauthenticated, like /pro/lookup-dues and
// /pro/create-payment-link-public — the target must belong to the
// given proUserId and be an active event/pledge goal, which bounds
// what a caller can actually do (add themselves to one specific,
// already-existing pledge goal — nothing a staff member couldn't
// already do manually). Rate-limited to slow down abuse.
// ===============================================================

// Looks up the target only if it's still a live, open pledge/event goal —
// every handler below calls this first so a deleted, completed, or
// wrong-category goal id (or one belonging to a different treasurer)
// can never be paid against via the public QR flow.
async function findActivePledgeTarget(proUserId, targetId) {
  const { data: userData } = await supabase
    .from('pro_user_data')
    .select('targets')
    .eq('user_id', proUserId)
    .single();
  const target = (userData?.targets || []).find(t => t.id === targetId && t.category === 'event' && t.status === 'active');
  return target || null;
}

// ---------------------------------------------------------------
// GOAL INFO — what the QR page shows before asking for anything:
// the pledge goal's name and the treasurer's currency. 404 if the
// goal doesn't exist, isn't a pledge goal, or is no longer active
// (deleted/completed goals stop accepting new QR payments).
// ---------------------------------------------------------------
router.get('/pledge-qr-info', rateLimit(30, 10 * 60000), async (req, res) => {
  const { proUserId, targetId } = req.query;
  if (!proUserId || !targetId) return res.status(400).json({ error: 'proUserId and targetId are required' });

  try {
    const target = await findActivePledgeTarget(proUserId, targetId);
    if (!target) return res.status(404).json({ error: 'This pledge goal is no longer accepting contributions.' });

    const { data: proUserRow } = await supabase.from('pro_users').select('currency').eq('id', proUserId).single();
    res.json({ success: true, targetName: target.name, currency: proUserRow?.currency || 'INR' });
  } catch (err) {
    console.error('pledge-qr-info error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ---------------------------------------------------------------
// LOOKUP BY MOBILE — does this mobile already have a pledge on this
// goal? Never matches the fixed anonymous mobile (9999999999) —
// anonymous donations always go through /pledge-qr-anonymous-pay
// instead, since many different anonymous donors intentionally
// share that same placeholder mobile and must never be merged.
// ---------------------------------------------------------------
router.get('/pledge-qr-lookup', rateLimit(20, 10 * 60000), async (req, res) => {
  const { proUserId, targetId, mobile } = req.query;
  if (!proUserId || !targetId || !mobile) return res.status(400).json({ error: 'proUserId, targetId, and mobile are required' });
  if (mobile === '9999999999') return res.json({ success: true, found: false });

  try {
    const target = await findActivePledgeTarget(proUserId, targetId);
    if (!target) return res.status(404).json({ error: 'This pledge goal is no longer accepting contributions.' });

    const { data: userData } = await supabase
      .from('pro_user_data')
      .select('pledges')
      .eq('user_id', proUserId)
      .single();
    const pledge = (userData?.pledges || []).find(p => p.targetId === targetId && p.mobile === mobile && !p.deleted);

    if (!pledge) return res.json({ success: true, found: false });

    const due = Math.max(0, pledge.promisedAmount - (pledge.amountPaid || 0));
    res.json({
      success: true, found: true, pledgeId: pledge.id, name: pledge.name,
      promisedAmount: pledge.promisedAmount, amountPaid: pledge.amountPaid || 0, due, fullyPaid: due <= 0
    });
  } catch (err) {
    console.error('pledge-qr-lookup error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Shared by both the new-pledge and anonymous flows below — creates a
// payment link for a just-created pledge and mirrors the pledge into
// the normalized table. The pledge's own `id` is passed through as
// `contributorId` in the gateway link's notes (see recordOnlineContribution
// in routes/payments.js) so the webhook credits this EXACT pledge —
// matching only by mobile would be ambiguous once more than one pledge
// shares the same mobile, which is guaranteed for anonymous donations.
async function createLinkForNewPledge(proUserId, target, pledge, requestedProvider) {
  const provider = await gateways.resolveProvider(proUserId, requestedProvider);
  if (!provider) {
    const err = new Error('gateway_not_connected');
    err.code = 'gateway_not_connected';
    throw err;
  }
  const link = await gateways.createContributionLink(proUserId, provider, {
    amountPaise: Math.round(pledge.promisedAmount * 100),
    description: `${target.name} — ${pledge.name}`,
    notes: {
      type: 'contribution', proUserId, contributorId: pledge.id,
      targetId: target.id, targetCategory: 'event', mobile: pledge.mobile
    }
  });
  supabase.from('pro_payment_links')
    .upsert({
      payment_link_id: link.id, user_id: proUserId, provider,
      notes: { type: 'contribution', proUserId, contributorId: pledge.id, targetId: target.id, targetCategory: 'event', mobile: pledge.mobile }
    }, { onConflict: 'payment_link_id' })
    .then(({ error }) => { if (error) console.error('pro_payment_links insert (pledge-qr):', error.message); });
  return { link, provider };
}

// ---------------------------------------------------------------
// NEW PLEDGE + PAY — mobile wasn't found above, so this person is
// contributing for the first time. Pledges are voluntary (no fixed
// per-person amount), so whatever they enter becomes both their
// pledge and the payment in one step.
// ---------------------------------------------------------------
router.post('/pledge-qr-new-pledge', rateLimit(10, 10 * 60000), async (req, res) => {
  const { proUserId, targetId, name, mobile, amount, provider } = req.body;
  const cleanName = String(name || '').trim();
  const cleanMobile = String(mobile || '').trim();
  const cleanAmount = Number(amount);
  if (!proUserId || !targetId || !cleanName || !cleanMobile || !cleanAmount || cleanAmount <= 0) {
    return res.status(400).json({ error: 'name, mobile, and a valid amount are required' });
  }
  if (cleanMobile === '9999999999') {
    return res.status(400).json({ error: 'Please use "Donate Anonymously" instead.' });
  }

  try {
    const target = await findActivePledgeTarget(proUserId, targetId);
    if (!target) return res.status(404).json({ error: 'This pledge goal is no longer accepting contributions.' });

    const { data: userData } = await supabase
      .from('pro_user_data')
      .select('pledges')
      .eq('user_id', proUserId)
      .single();
    const pledges = userData?.pledges || [];

    if (pledges.some(p => p.targetId === targetId && p.mobile === cleanMobile && !p.deleted)) {
      return res.status(409).json({ error: 'This mobile number already has a pledge on this goal — please look it up instead.' });
    }

    const newPledge = {
      // Prefixed with the owning pro user's own ID (see utils/idGen.js) —
      // can never collide with another user's pledge id.
      id: await nextId(supabase, proUserId, 'pledge'),
      targetId, targetName: target.name, name: cleanName, mobile: cleanMobile,
      promisedAmount: cleanAmount, amountPaid: 0, status: 'pending', createdAt: new Date().toISOString()
    };
    pledges.push(newPledge);

    const { error: updateError } = await supabase
      .from('pro_user_data')
      .update({ pledges, updated_at: new Date().toISOString() })
      .eq('user_id', proUserId);
    if (updateError) return res.status(500).json({ error: updateError.message });
    await mirrorPledge(supabase, proUserId, newPledge);

    const { link, provider: usedProvider } = await createLinkForNewPledge(proUserId, target, newPledge, provider);
    res.json({ success: true, short_url: link.url, provider: usedProvider });
  } catch (err) {
    if (err.code === 'gateway_not_connected') {
      return res.status(409).json({ error: 'Online payments are not set up for this group yet. Please contact the treasurer directly.' });
    }
    console.error('pledge-qr-new-pledge error:', err?.message || err);
    res.status(500).json({ error: 'Failed to start payment.' });
  }
});

// ---------------------------------------------------------------
// PAY EXISTING PLEDGE'S REMAINING DUE.
// ---------------------------------------------------------------
router.post('/pledge-qr-pay-existing', rateLimit(15, 10 * 60000), async (req, res) => {
  const { proUserId, targetId, pledgeId, mobile, provider } = req.body;
  if (!proUserId || !targetId || !pledgeId || !mobile) {
    return res.status(400).json({ error: 'proUserId, targetId, pledgeId, and mobile are required' });
  }

  try {
    const target = await findActivePledgeTarget(proUserId, targetId);
    if (!target) return res.status(404).json({ error: 'This pledge goal is no longer accepting contributions.' });

    const { data: userData } = await supabase
      .from('pro_user_data')
      .select('pledges')
      .eq('user_id', proUserId)
      .single();
    const pledge = (userData?.pledges || []).find(p => p.id === pledgeId && p.targetId === targetId && p.mobile === mobile && !p.deleted);
    if (!pledge) return res.status(404).json({ error: 'Could not find this pledge.' });

    const due = pledge.promisedAmount - (pledge.amountPaid || 0);
    if (due <= 0) return res.status(400).json({ error: 'This pledge has already been fully paid.' });

    const provider_ = await gateways.resolveProvider(proUserId, provider);
    if (!provider_) return res.status(409).json({ error: 'Online payments are not set up for this group yet. Please contact the treasurer directly.' });

    const link = await gateways.createContributionLink(proUserId, provider_, {
      amountPaise: Math.round(due * 100),
      description: `${target.name} — ${pledge.name}`,
      notes: { type: 'contribution', proUserId, contributorId: pledge.id, targetId: target.id, targetCategory: 'event', mobile: pledge.mobile }
    });
    supabase.from('pro_payment_links')
      .upsert({
        payment_link_id: link.id, user_id: proUserId, provider: provider_,
        notes: { type: 'contribution', proUserId, contributorId: pledge.id, targetId: target.id, targetCategory: 'event', mobile: pledge.mobile }
      }, { onConflict: 'payment_link_id' })
      .then(({ error }) => { if (error) console.error('pro_payment_links insert (pledge-qr):', error.message); });

    res.json({ success: true, short_url: link.url, provider: provider_ });
  } catch (err) {
    if (err.message === 'gateway_not_connected') {
      return res.status(409).json({ error: 'Online payments are not set up for this group yet. Please contact the treasurer directly.' });
    }
    console.error('pledge-qr-pay-existing error:', err?.message || err);
    res.status(500).json({ error: 'Failed to start payment.' });
  }
});

// ---------------------------------------------------------------
// ANONYMOUS DONATION — no identity collected at all. Every anonymous
// donation creates its OWN new pledge record (never reused/merged),
// all sharing the same fixed placeholder identity — Name: "Anonymous",
// Mobile: "9999999999" — exactly as requested, so the goal's paid list
// shows each anonymous donation as its own line rather than one lump sum.
// ---------------------------------------------------------------
router.post('/pledge-qr-anonymous-pay', rateLimit(10, 10 * 60000), async (req, res) => {
  const { proUserId, targetId, amount, provider } = req.body;
  const cleanAmount = Number(amount);
  if (!proUserId || !targetId || !cleanAmount || cleanAmount <= 0) {
    return res.status(400).json({ error: 'A valid amount is required' });
  }

  try {
    const target = await findActivePledgeTarget(proUserId, targetId);
    if (!target) return res.status(404).json({ error: 'This pledge goal is no longer accepting contributions.' });

    const { data: userData } = await supabase
      .from('pro_user_data')
      .select('pledges')
      .eq('user_id', proUserId)
      .single();
    const pledges = userData?.pledges || [];

    const newPledge = {
      // Prefixed with the owning pro user's own ID (see utils/idGen.js) —
      // can never collide with another user's pledge id.
      id: await nextId(supabase, proUserId, 'pledge'),
      targetId, targetName: target.name, name: 'Anonymous', mobile: '9999999999',
      promisedAmount: cleanAmount, amountPaid: 0, status: 'pending', createdAt: new Date().toISOString(),
      anonymous: true
    };
    pledges.push(newPledge);

    const { error: updateError } = await supabase
      .from('pro_user_data')
      .update({ pledges, updated_at: new Date().toISOString() })
      .eq('user_id', proUserId);
    if (updateError) return res.status(500).json({ error: updateError.message });
    await mirrorPledge(supabase, proUserId, newPledge);

    const { link, provider: usedProvider } = await createLinkForNewPledge(proUserId, target, newPledge, provider);
    res.json({ success: true, short_url: link.url, provider: usedProvider });
  } catch (err) {
    if (err.code === 'gateway_not_connected') {
      return res.status(409).json({ error: 'Online payments are not set up for this group yet. Please contact the treasurer directly.' });
    }
    console.error('pledge-qr-anonymous-pay error:', err?.message || err);
    res.status(500).json({ error: 'Failed to start payment.' });
  }
});

module.exports = router;

const express = require('express');
require('dotenv').config();

const supabase = require('../../lib/supabase');
const { requireProToken, requireProOrStaffToken } = require('../../middleware/auth');
const {
  mirrorTarget, mirrorArchiveTarget, mirrorSubscription, mirrorDeleteSubscription
} = require('../../utils/mirrorWrite');

const router = express.Router();

// ===============================================================
// PRO WEB DASHBOARD — Monthly/Yearly goal management: create a goal,
// subscribe/unsubscribe contributors to it, delete a goal entirely.
// ===============================================================

// ---------------------------------------------------------------
// WEB CREATE TARGET (Goal/Pledge-category) — lets a Pro user create a new
// monthly/yearly goal or event-pledge category directly from the website,
// matching the app's Goals/Pledges tab "create" action. Same fetch-fresh,
// append-one-thing, write-back pattern as the other /web-* endpoints —
// never overwrites the whole targets array, so a goal the app created
// moments earlier can't be silently lost.
// ---------------------------------------------------------------
router.post('/web-create-target', requireProToken, async (req, res) => {
  const { name, category, targetAmount, rollover } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (!['monthly', 'yearly', 'event'].includes(category)) {
    return res.status(400).json({ error: "category must be 'monthly', 'yearly', or 'event'" });
  }

  try {
    const { data: userData, error } = await supabase
      .from('pro_user_data')
      .select('targets')
      .eq('user_id', req.proUserId)
      .single();

    if (error || !userData) return res.status(404).json({ error: 'Could not find your data.' });

    const targets = userData.targets || [];

    const newTarget = {
      id: `target-${category}-${Date.now().toString().slice(-6)}`,
      name: name.trim(),
      category,
      status: 'active',
      targetAmount: Number(targetAmount) || 0,
      // Monthly and yearly goals always roll over automatically (no manual
      // opt-out). Event goals don't have rollover.
      ...(category !== 'event' ? { rollover: true } : {})
    };
    targets.push(newTarget);

    const { error: updateError } = await supabase
      .from('pro_user_data')
      .update({ targets, updated_at: new Date().toISOString() })
      .eq('user_id', req.proUserId);

    if (updateError) return res.status(500).json({ error: updateError.message });

    // Dual-write: mirror the new goal into the new table too.
    await mirrorTarget(supabase, req.proUserId, newTarget);

    res.json({ success: true, target: newTarget });
  } catch (err) {
    console.error('Web create target error:', err?.message || err);
    res.status(500).json({ error: 'Failed to create goal.' });
  }
});

// ---------------------------------------------------------------
// WEB SUBSCRIBE CONTRIBUTORS — adds one or more existing DB contributors
// to a monthly/yearly goal with a per-contributor expected amount, matching
// the app's "Add/remove subscribers" action under Goals. Takes an array so
// selecting several subscribers in one form submit is a single round trip
// (per the batching guidance — avoid one write call per person). Fetches
// fresh contributors immediately before writing, same reasoning as
// /web-add-contributors: the app may have changed this contributor's data
// since the website last loaded it.
// ---------------------------------------------------------------
router.post('/web-subscribe-contributors', requireProOrStaffToken, async (req, res) => {
  const { targetId, subscriptions } = req.body;
  if (!targetId) return res.status(400).json({ error: 'targetId is required' });
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
    return res.status(400).json({ error: 'subscriptions (a non-empty array of { contributorId, amount }) is required' });
  }

  try {
    const { data: userData, error } = await supabase
      .from('pro_user_data')
      .select('contributors, targets')
      .eq('user_id', req.proUserId)
      .single();

    if (error || !userData) return res.status(404).json({ error: 'Could not find your data.' });

    const targets = userData.targets || [];
    const target = targets.find(t => t.id === targetId);
    if (!target) return res.status(404).json({ error: 'Goal not found.' });

    const contributors = userData.contributors || [];

    let updatedCount = 0;
    const updatedSubs = [];

    subscriptions.forEach(sub => {
      const idx = contributors.findIndex(c => c.id === sub.contributorId);
      if (idx === -1) return; // skip unknown contributor id rather than failing the whole batch
      const c = contributors[idx];
      const targetIds = Array.isArray(c.targetIds) ? [...c.targetIds] : [];
      if (!targetIds.includes(targetId)) targetIds.push(targetId);
      const targetAmounts = { ...(c.targetAmounts || {}) };
      targetAmounts[targetId] = Number(sub.amount) || 0;
      contributors[idx] = { ...c, targetIds, targetAmounts };
      updatedSubs.push({ contributorId: sub.contributorId, amount: targetAmounts[targetId] });
      updatedCount++;
    });

    const { error: updateError } = await supabase
      .from('pro_user_data')
      .update({ contributors, updated_at: new Date().toISOString() })
      .eq('user_id', req.proUserId);

    if (updateError) return res.status(500).json({ error: updateError.message });

    // Dual-write: mirror each new subscription into the new table too.
    for (const s of updatedSubs) {
      await mirrorSubscription(supabase, s.contributorId, targetId, s.amount, null);
    }

    res.json({ success: true, updated: updatedCount });
  } catch (err) {
    console.error('Web subscribe contributors error:', err?.message || err);
    res.status(500).json({ error: 'Failed to add subscribers to the goal.' });
  }
});

// ---------------------------------------------------------------
// WEB UNSUBSCRIBE CONTRIBUTORS — removes one or more existing DB
// contributors from a monthly/yearly goal (the "Remove subscribers from
// this goal" action). Their past contributions/receipts are completely
// untouched — this only removes the forward-looking subscription itself,
// same fetch-fresh-then-write-back safety pattern as every other
// endpoint here.
// ---------------------------------------------------------------
router.post('/web-unsubscribe-contributors', requireProToken, async (req, res) => {
  const { targetId, contributorIds } = req.body;
  if (!targetId) return res.status(400).json({ error: 'targetId is required' });
  if (!Array.isArray(contributorIds) || contributorIds.length === 0) {
    return res.status(400).json({ error: 'contributorIds (a non-empty array) is required' });
  }

  try {
    const { data: userData, error } = await supabase
      .from('pro_user_data')
      .select('contributors')
      .eq('user_id', req.proUserId)
      .single();

    if (error || !userData) return res.status(404).json({ error: 'Could not find your data.' });

    const contributors = userData.contributors || [];
    let updatedCount = 0;
    const removedFrom = [];

    contributorIds.forEach(cid => {
      const idx = contributors.findIndex(c => c.id === cid);
      if (idx === -1) return;
      const c = contributors[idx];
      if (!(c.targetIds || []).includes(targetId)) return; // wasn't subscribed anyway
      const targetIds = (c.targetIds || []).filter(id => id !== targetId);
      const targetAmounts = { ...(c.targetAmounts || {}) };
      delete targetAmounts[targetId];
      const targetBreakups = { ...(c.targetBreakups || {}) };
      delete targetBreakups[targetId];
      contributors[idx] = { ...c, targetIds, targetAmounts, targetBreakups };
      removedFrom.push(cid);
      updatedCount++;
    });

    const { error: updateError } = await supabase
      .from('pro_user_data')
      .update({ contributors, updated_at: new Date().toISOString() })
      .eq('user_id', req.proUserId);

    if (updateError) return res.status(500).json({ error: updateError.message });

    // Dual-write: remove each subscription from the new table too.
    for (const cid of removedFrom) {
      await mirrorDeleteSubscription(supabase, cid, targetId);
    }

    res.json({ success: true, updated: updatedCount });
  } catch (err) {
    console.error('Web unsubscribe contributors error:', err?.message || err);
    res.status(500).json({ error: 'Failed to remove subscribers from the goal.' });
  }
});

// ---------------------------------------------------------------
// WEB DELETE TARGET — removes a goal/pledge-category entirely, matching
// the app's own delete-goal behavior exactly (GoalsTab.handleDeleteGoal /
// PledgesTab.handleDeleteTarget): the target itself is removed, every
// contributor's reference to it is stripped, and everything tied to it
// (contributions for monthly/yearly, pledges for event) is removed too —
// a real delete, not an archive, same as the app. Fetches everything
// fresh immediately before writing, consistent with every other /web-*
// endpoint here.
// ---------------------------------------------------------------
// ---------------------------------------------------------------
// DELETE and MARK COMPLETE are two separate actions now, producing two
// separate (but equally read-only, equally visible) outcomes:
//   - /web-delete-target      -> status: 'deleted'   -> shows under
//     "Deleted Goals" in its tab
//   - /web-complete-target    -> status: 'completed' -> shows under
//     "Completed Goals" in its tab (same place goals that auto-complete
//     via 100% funding land)
// Neither one destroys anything underneath — contributors, contributions,
// and pledges tied to the goal are completely untouched either way, and
// every payment ever collected stays permanently visible in the read-only
// detail view. The only difference between the two is which heading the
// goal appears under, so a treasurer can tell "goals I closed out because
// they were done" from "goals I deleted for some other reason" at a
// glance.
// ---------------------------------------------------------------
router.post('/web-delete-target', requireProToken, async (req, res) => {
  const { targetId } = req.body;
  if (!targetId) return res.status(400).json({ error: 'targetId is required' });

  try {
    const { data: userData, error } = await supabase
      .from('pro_user_data')
      .select('targets')
      .eq('user_id', req.proUserId)
      .single();

    if (error || !userData) return res.status(404).json({ error: 'Could not find your data.' });

    const targets = userData.targets || [];
    const idx = targets.findIndex(t => t.id === targetId);
    if (idx === -1) return res.status(404).json({ error: 'Goal not found.' });

    targets[idx] = { ...targets[idx], status: 'deleted', deletedAt: new Date().toISOString() };

    const { error: updateError } = await supabase
      .from('pro_user_data')
      .update({ targets, updated_at: new Date().toISOString() })
      .eq('user_id', req.proUserId);

    if (updateError) return res.status(500).json({ error: updateError.message });

    // Dual-write: mirror the deleted status into the new table too.
    await mirrorArchiveTarget(supabase, targetId, 'deleted');

    res.json({ success: true });
  } catch (err) {
    console.error('Web delete target error:', err?.message || err);
    res.status(500).json({ error: 'Failed to delete goal.' });
  }
});

// --- Manual "Mark Complete" — the separate action from Delete above ---
router.post('/web-complete-target', requireProToken, async (req, res) => {
  const { targetId } = req.body;
  if (!targetId) return res.status(400).json({ error: 'targetId is required' });

  try {
    const { data: userData, error } = await supabase
      .from('pro_user_data')
      .select('targets')
      .eq('user_id', req.proUserId)
      .single();

    if (error || !userData) return res.status(404).json({ error: 'Could not find your data.' });

    const targets = userData.targets || [];
    const idx = targets.findIndex(t => t.id === targetId);
    if (idx === -1) return res.status(404).json({ error: 'Goal not found.' });

    targets[idx] = { ...targets[idx], status: 'completed', completedAt: new Date().toISOString() };

    const { error: updateError } = await supabase
      .from('pro_user_data')
      .update({ targets, updated_at: new Date().toISOString() })
      .eq('user_id', req.proUserId);

    if (updateError) return res.status(500).json({ error: updateError.message });

    // Dual-write: mirror the completed status into the new table too.
    await mirrorArchiveTarget(supabase, targetId, 'completed');

    res.json({ success: true });
  } catch (err) {
    console.error('Web complete target error:', err?.message || err);
    res.status(500).json({ error: 'Failed to mark goal complete.' });
  }
});


module.exports = router;

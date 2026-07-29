const express = require('express');
require('dotenv').config();

const supabase = require('../../lib/supabase');
const { requireProToken, requireProOrStaffToken } = require('../../middleware/auth');
const {
  mirrorTarget, mirrorArchiveTarget, mirrorSubscription, mirrorDeleteSubscription
} = require('../../utils/mirrorWrite');
const { periodKeyForDate, periodLabel } = require('../../utils/rolloverEngine');
const { nextId } = require('../../utils/idGen');

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
  const { name, category, targetAmount, totalInstallments } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  if (!['monthly', 'quarterly', 'yearly', 'event', 'installment'].includes(category)) {
    return res.status(400).json({ error: "category must be 'monthly', 'quarterly', 'yearly', 'event', or 'installment'" });
  }
  // Installment goals need a fixed number of periods to auto-stop after
  // (see utils/rolloverEngine.js) — every other category either rolls over
  // indefinitely (monthly/quarterly/yearly) or not at all (event).
  let installmentCount;
  if (category === 'installment') {
    installmentCount = Number(totalInstallments);
    if (!Number.isInteger(installmentCount) || installmentCount < 2) {
      return res.status(400).json({ error: 'totalInstallments must be a whole number of 2 or more.' });
    }
  }

  try {
    const { data: userData, error } = await supabase
      .from('pro_user_data')
      .select('targets')
      .eq('user_id', req.proUserId)
      .single();

    if (error || !userData) return res.status(404).json({ error: 'Could not find your data.' });

    const targets = userData.targets || [];

    // Monthly/quarterly/yearly/installment goals are dated from the moment
    // they're created (e.g. "Cleaning Charges — July 2026") and roll over
    // automatically at the end of their period — a new dated goal is
    // created, every subscriber carries over, and any unpaid balance is
    // added on top of their normal amount as an arrear (see
    // utils/rolloverEngine.js). This repeats every period until the
    // treasurer stops it via /web-stop-rollover (or, for installment goals,
    // automatically once totalInstallments periods have been created), or
    // manually completes/deletes the goal. Event goals don't roll over.
    const baseName = name.trim();
    let displayName = baseName;
    let rolloverFields = {};
    if (category !== 'event') {
      const periodKey = periodKeyForDate(new Date(), category);
      displayName = `${baseName} — ${periodLabel(periodKey, category)}`;
      rolloverFields = { rollover: true, rolloverBaseName: baseName, rolloverPeriodKey: periodKey };
      if (category === 'installment') {
        rolloverFields.totalInstallments = installmentCount;
        rolloverFields.installmentsPaid = 1;
      }
    }

    const newTarget = {
      // Prefixed with the owning pro user's own ID + a per-category code
      // (gm/gq/gy/ge/gi/...), so this can never collide with another user's
      // goal id (see utils/idGen.js).
      id: await nextId(supabase, req.proUserId, category),
      name: displayName,
      category,
      status: 'active',
      targetAmount: Number(targetAmount) || 0,
      ...rolloverFields
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
      // For rollover-eligible goals, also stash the subscribed amount under
      // the goal's stable base name — this is what the rollover engine reads
      // as "the normal per-period amount" for computing each new period's own
      // due line. targetAmounts itself can't be used for that: it gets
      // overwritten to reflect the true current due (arrears/credit-inclusive)
      // as payments and rollovers happen, so it drifts away from the
      // originally-subscribed recurring amount over time.
      let recurringAmounts = c.recurringAmounts;
      if (target.rolloverBaseName) {
        recurringAmounts = { ...(c.recurringAmounts || {}), [target.rolloverBaseName]: Number(sub.amount) || 0 };
      }
      contributors[idx] = { ...c, targetIds, targetAmounts, recurringAmounts };
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
      await mirrorSubscription(supabase, s.contributorId, targetId, s.amount, null, req.proUserId);
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

// ---------------------------------------------------------------
// WEB STOP ROLLOVER — turns off automatic rollover for one active
// monthly/yearly goal (see utils/rolloverEngine.js). The current period
// keeps running as normal; only the *next* automatic period-end
// continuation is prevented. The treasurer can still complete or delete
// the goal manually at any time, same as before.
// ---------------------------------------------------------------
router.post('/web-stop-rollover', requireProToken, async (req, res) => {
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

    targets[idx] = { ...targets[idx], rollover: false };

    const { error: updateError } = await supabase
      .from('pro_user_data')
      .update({ targets, updated_at: new Date().toISOString() })
      .eq('user_id', req.proUserId);

    if (updateError) return res.status(500).json({ error: updateError.message });

    // Dual-write: mirror the flag into the new table too.
    await mirrorTarget(supabase, req.proUserId, targets[idx]);

    res.json({ success: true });
  } catch (err) {
    console.error('Web stop rollover error:', err?.message || err);
    res.status(500).json({ error: 'Failed to stop rollover for this goal.' });
  }
});


module.exports = router;

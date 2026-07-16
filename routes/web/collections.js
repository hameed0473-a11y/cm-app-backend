const express = require('express');
require('dotenv').config();

const supabase = require('../../lib/supabase');
const { requireProToken } = require('../../middleware/auth');
const { getDefaultBreakup, getRemainingBreakup, breakupTotal } = require('../../utils/arrears');
const { getMaxReceipts, getReceiptUsage } = require('../../lib/pricing');
const { mirrorContribution, mirrorPledge, mirrorArchiveTarget } = require('../../utils/mirrorWrite');

const router = express.Router();

// Aggregate total/collected for a Monthly/Yearly goal across EVERY
// contributor subscribed to it — same calculation the dashboard itself
// uses (goalDetail), just server-side, so auto-completion can check
// "is this goal 100% funded" right after a payment lands.
function computeMonthlyYearlyTotals(target, contributors, contributions) {
  let total = 0;
  contributors.forEach(c => {
    if (!(c.targetIds || []).includes(target.id)) return;
    const fallbackAmount = c.targetAmounts?.[target.id] ?? 0;
    const breakup = c.targetBreakups?.[target.id] || getDefaultBreakup(target, fallbackAmount);
    total += breakupTotal(breakup);
  });
  const collected = contributions
    .filter(c => c.targetId === target.id && !c.deleted)
    .reduce((s, c) => s + c.amountPaid, 0);
  return { total, collected };
}

// Flips a target to status: 'completed' (still visible, read-only) if
// it isn't already — used by both the auto-detection below and the
// separate manual "mark complete" action in routes/web/goals.js.
async function markTargetCompletedIfNeeded(supabase, userId, targets, targetId) {
  const idx = targets.findIndex(t => t.id === targetId);
  if (idx === -1 || targets[idx].status !== 'active') return;
  targets[idx] = { ...targets[idx], status: 'completed', completedAt: new Date().toISOString() };
  const { error } = await supabase.from('pro_user_data').update({ targets }).eq('user_id', userId);
  if (error) { console.error('Auto-complete target update failed:', error.message); return; }
  await mirrorArchiveTarget(supabase, targetId, 'completed');
}

// ===============================================================
// PRO WEB DASHBOARD — payment collection (the one place receipts are
// actually generated, for both Monthly/Yearly contributions and
// Pledges) and payment deletion/reversal.
// ===============================================================

// ---------------------------------------------------------------
// WEB COLLECT PAYMENT — lets a Pro user record a cash/manual payment
// directly from the website dashboard. Uses the same "fetch fresh,
// then append just one record" pattern as the payment webhook,
// rather than overwriting the whole dataset — this is deliberate:
// the app is a second, independent writer to this same data, so a
// blind overwrite here could silently erase whatever the app synced
// most recently. Fetching immediately before writing narrows (though
// doesn't perfectly eliminate) that race window.
// ---------------------------------------------------------------
router.post('/web-collect-payment', requireProToken, async (req, res) => {
  const { contributorId, targetId, targetCategory, amount } = req.body;
  console.log('web-collect-payment called — user:', req.proUserId, 'contributor:', contributorId, 'target:', targetId, 'amount:', amount);
  if (!contributorId || !targetId || !amount) {
    return res.status(400).json({ error: 'contributorId, targetId, and amount are required' });
  }

  try {
    const { data: userData, error } = await supabase
      .from('pro_user_data')
      .select('*')
      .eq('user_id', req.proUserId)
      .single();

    if (error || !userData) return res.status(404).json({ error: 'Could not find your data.' });

    // RECEIPT LIMIT CHECK — see lib/pricing.js. NULL paid_subscriber_count
    // (unbilled/trial accounts) means no cap. Once billed, this is the
    // ONLY usage cap in the system — no separate subscriber-add or
    // goal-subscription limits anymore.
    const { data: proUserRow } = await supabase
      .from('pro_users')
      .select('paid_subscriber_count, receipts_per_subscriber, total_receipts_generated')
      .eq('id', req.proUserId)
      .single();
    const maxReceipts = getMaxReceipts(proUserRow?.paid_subscriber_count, proUserRow?.receipts_per_subscriber);
    const usageBeforeThis = getReceiptUsage(proUserRow?.total_receipts_generated, maxReceipts);

    if (usageBeforeThis.isBlocked) {
      return res.status(403).json({
        error: `You've reached your receipt limit of ${maxReceipts}. You can increase your limit by adding more subscribers.`,
        receiptLimitReached: true,
        receiptUsage: usageBeforeThis
      });
    }

    const receiptNo = `REC-${Date.now().toString().slice(-4)}${Math.floor(Math.random() * 10)}`;

    if (targetCategory === 'event') {
      const pledges = userData.pledges || [];
      const idx = pledges.findIndex(p => p.targetId === targetId && (p.contributorId === contributorId || p.id === contributorId));
      if (idx === -1) return res.status(404).json({ error: 'Pledge not found.' });

      const p = pledges[idx];
      // Guard against a race where this pledge was already fully paid (e.g. via
      // the mobile app, moments before this request landed) — reject rather
      // than silently recording a second payment on top of a settled pledge.
      const alreadyDue = p.promisedAmount - (p.amountPaid || 0);
      if (alreadyDue <= 0) {
        return res.status(409).json({ error: 'This pledge has already been fully collected — please refresh your screen.' });
      }

      const newAmountPaid = (p.amountPaid || 0) + Number(amount);
      pledges[idx] = {
        ...p,
        amountPaid: newAmountPaid,
        status: newAmountPaid >= p.promisedAmount ? 'fully_paid' : 'partially_paid',
        lastPaymentDate: new Date().toISOString(),
        lastReceiptNo: receiptNo
      };

      const { error: updateError } = await supabase
        .from('pro_user_data')
        .update({ pledges, updated_at: new Date().toISOString() })
        .eq('user_id', req.proUserId);
      if (updateError) return res.status(500).json({ error: updateError.message });

      // Dual-write: mirror the updated pledge into the new normalized table too.
      await mirrorPledge(supabase, req.proUserId, pledges[idx]);

      // Auto-complete: if every pledge for this goal is now fully paid,
      // mark the goal itself completed — still visible read-only in its
      // tab, not hidden the way archiving used to work.
      const targetPledges = pledges.filter(pl => pl.targetId === targetId);
      const allFullyPaid = targetPledges.length > 0 && targetPledges.every(pl => pl.status === 'fully_paid');
      if (allFullyPaid) {
        const targets = userData.targets || [];
        await markTargetCompletedIfNeeded(supabase, req.proUserId, targets, targetId);
      }
    } else {
      // Same guard for monthly/yearly goals — recompute what's actually still
      // due from the freshly-fetched data (same arrears-aware calculation the
      // app itself uses) rather than trusting the amount blindly. If someone
      // else (the app, or an online payment) already settled this due in the
      // moments since this screen last refreshed, reject instead of recording
      // a duplicate collection.
      const contributors = userData.contributors || [];
      const targets = userData.targets || [];
      const contributor = contributors.find(c => c.id === contributorId);
      const target = targets.find(t => t.id === targetId);

      if (contributor && target) {
        const fallbackAmount = contributor.targetAmounts?.[targetId] ?? 0;
        const originalBreakup = contributor.targetBreakups?.[targetId] || getDefaultBreakup(target, fallbackAmount);
        const totalPaidSoFar = (userData.contributions || [])
          .filter(c => c.contributorId === contributorId && c.targetId === targetId && !c.deleted)
          .reduce((s, c) => s + c.amountPaid, 0);
        const stillDue = breakupTotal(getRemainingBreakup(originalBreakup, totalPaidSoFar));

        if (stillDue <= 0) {
          return res.status(409).json({ error: 'This due has already been fully collected — please refresh your screen.' });
        }
      }

      const contributions = userData.contributions || [];
      const newContribution = {
        id: `REC-${Date.now()}`,
        contributorId,
        targetId,
        amountPaid: Number(amount),
        date: new Date().toISOString(),
        collectedBy: 'Web Dashboard',
        receiptNo
      };
      contributions.push(newContribution);

      const { error: updateError } = await supabase
        .from('pro_user_data')
        .update({ contributions, updated_at: new Date().toISOString() })
        .eq('user_id', req.proUserId);
      if (updateError) return res.status(500).json({ error: updateError.message });

      // Dual-write: mirror the new contribution into the new normalized table too.
      await mirrorContribution(supabase, req.proUserId, newContribution);

      // Auto-complete: if this goal is now 100% funded across every
      // subscribed contributor, mark it completed — still visible
      // read-only in its tab, not hidden.
      if (target) {
        const { total, collected } = computeMonthlyYearlyTotals(target, contributors, contributions);
        if (total > 0 && collected >= total) {
          const targets = userData.targets || [];
          await markTargetCompletedIfNeeded(supabase, req.proUserId, targets, targetId);
        }
      }
    }

    // Increment the receipt counter — this is the only place it moves.
    // Best-effort: if this update fails, don't fail the payment that was
    // already successfully recorded above; just log it, since an
    // undercounted usage number is far less harmful than losing a receipt
    // the treasurer already collected.
    const newTotal = (proUserRow?.total_receipts_generated || 0) + 1;
    const { error: counterError } = await supabase
      .from('pro_users')
      .update({ total_receipts_generated: newTotal })
      .eq('id', req.proUserId);
    if (counterError) console.error('Receipt counter increment failed:', counterError.message);

    const receiptUsage = getReceiptUsage(newTotal, maxReceipts);

    console.log('web-collect-payment success — user:', req.proUserId, 'receipt:', receiptNo);
    res.json({ success: true, receiptNo, receiptUsage });
  } catch (err) {
    console.error('Web collect payment error:', err?.message || err);
    res.status(500).json({ error: 'Failed to record payment.' });
  }
});

// ---------------------------------------------------------------
// WEB DELETE PAYMENT — soft-deletes a single collected contribution
// (monthly/yearly goals), matching the mobile app's own delete-payment
// behavior exactly: the contribution row is NOT removed, it's flagged
// `deleted: true` so it stays on record (still shown in the paid list,
// marked "Deleted") for the audit trail. The only effects are that every
// total now excludes it (because collected sums filter `!deleted`) and
// the subscriber's due reopens, moving them back to the Pending list.
//
// Same fetch-fresh-then-write-back safety pattern as every other /web-*
// endpoint — never overwrites the whole contributions array blindly, so a
// payment the app recorded moments earlier can't be lost by this write.
// ---------------------------------------------------------------
router.post('/web-delete-payment', requireProToken, async (req, res) => {
  const { contributionId } = req.body;
  if (!contributionId) return res.status(400).json({ error: 'contributionId is required' });

  try {
    const { data: userData, error } = await supabase
      .from('pro_user_data')
      .select('contributions')
      .eq('user_id', req.proUserId)
      .single();

    if (error || !userData) return res.status(404).json({ error: 'Could not find your data.' });

    const contributions = userData.contributions || [];
    const idx = contributions.findIndex(c => c.id === contributionId);
    if (idx === -1) return res.status(404).json({ error: 'Payment not found.' });

    // Idempotent: if it's already deleted (retried request, or the app deleted
    // it moments ago), report success rather than erroring — the desired end
    // state is already true.
    if (contributions[idx].deleted) {
      return res.json({ success: true, alreadyDeleted: true });
    }

    // SOFT delete — keep the record, just flag it. This is what makes the
    // payment remain visible as "Deleted" while dropping out of every total.
    contributions[idx] = {
      ...contributions[idx],
      deleted: true,
      deletedAt: new Date().toISOString()
    };

    const { error: updateError } = await supabase
      .from('pro_user_data')
      .update({ contributions, updated_at: new Date().toISOString() })
      .eq('user_id', req.proUserId);
    if (updateError) return res.status(500).json({ error: updateError.message });

    // Dual-write: mirror the now-deleted contribution into the new table too
    // (mirrorContribution writes `deleted: !!contribution.deleted`).
    await mirrorContribution(supabase, req.proUserId, contributions[idx]);

    res.json({ success: true });
  } catch (err) {
    console.error('Web delete payment error:', err?.message || err);
    res.status(500).json({ error: 'Failed to delete payment.' });
  }
});

// ===============================================================
// PAYMENT GATEWAY INTEGRATION — per Pro user, multiple providers.
// Lets a treasurer connect their OWN gateway(s) — Razorpay for Indian
// payers, Stripe (and later PayPal) for overseas members — so payments
// land in their account, not the platform's. Secrets are encrypted at
// rest; secrets are NEVER returned to the frontend.
// ===============================================================


module.exports = router;

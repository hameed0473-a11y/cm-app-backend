// ===================================================================
// Best-effort mirror writes into the new normalized tables, during the
// dual-write transition period.
//
// IMPORTANT: the OLD JSON columns on pro_user_data remain the sole
// source of truth right now. Every function here is purely additive —
// it NEVER throws, NEVER blocks, and NEVER affects the outcome of the
// real request. Any failure (e.g. the referenced contributor/target
// doesn't exist yet in the new tables because its own creation
// endpoint hasn't been converted yet) is caught and logged only.
//
// Once every write endpoint has been converted and verified, reads
// will flip over to these tables and this dual-write step goes away.
// ===================================================================

async function mirrorContribution(supabase, userId, contribution) {
  try {
    const { error } = await supabase.from('contributions').upsert([{
      id: contribution.id,
      user_id: userId,
      contributor_id: contribution.contributorId,
      target_id: contribution.targetId,
      amount_paid: contribution.amountPaid,
      paid_at: contribution.date ? new Date(contribution.date).toISOString() : new Date().toISOString(),
      collected_by: contribution.collectedBy || null,
      receipt_no: contribution.receiptNo || null,
      deleted: !!contribution.deleted
    }], { onConflict: 'id' });
    if (error) console.warn('[mirror] contribution upsert skipped:', contribution.id, '-', error.message);
  } catch (err) {
    console.warn('[mirror] contribution upsert threw:', contribution.id, '-', err?.message || err);
  }
}

async function mirrorPledge(supabase, userId, pledge) {
  try {
    const { error } = await supabase.from('pledges').upsert([{
      id: pledge.id,
      user_id: userId,
      target_id: pledge.targetId,
      contributor_id: pledge.contributorId || null,
      name: pledge.name,
      mobile: pledge.mobile,
      promised_amount: pledge.promisedAmount,
      amount_paid: pledge.amountPaid || 0,
      status: pledge.status || 'pending',
      created_at: pledge.createdAt ? new Date(pledge.createdAt).toISOString() : new Date().toISOString(),
      last_payment_date: pledge.lastPaymentDate ? new Date(pledge.lastPaymentDate).toISOString() : null,
      last_receipt_no: pledge.lastReceiptNo || null,
      deleted: !!pledge.deleted,
      deleted_at: pledge.deletedAt ? new Date(pledge.deletedAt).toISOString() : null,
      deleted_payments: pledge.deletedPayments || null
    }], { onConflict: 'id' });
    if (error) console.warn('[mirror] pledge upsert skipped:', pledge.id, '-', error.message);
  } catch (err) {
    console.warn('[mirror] pledge upsert threw:', pledge.id, '-', err?.message || err);
  }
}

async function mirrorContributor(supabase, userId, contributor) {
  try {
    const { error } = await supabase.from('contributors').upsert([{
      id: contributor.id,
      user_id: userId,
      name: contributor.name,
      mobile: contributor.mobile,
      address: contributor.address || null,
      type: contributor.type || null,
      created_at: contributor.createdAt ? new Date(contributor.createdAt).toISOString() : new Date().toISOString()
    }], { onConflict: 'id' });
    if (error) console.warn('[mirror] contributor upsert skipped:', contributor.id, '-', error.message);
  } catch (err) {
    console.warn('[mirror] contributor upsert threw:', contributor.id, '-', err?.message || err);
  }
}

async function mirrorTarget(supabase, userId, target) {
  try {
    const { error } = await supabase.from('targets').upsert([{
      id: target.id,
      user_id: userId,
      name: target.name,
      category: target.category,
      status: target.status || 'active',
      target_amount: target.targetAmount ?? 0,
      rollover: !!target.rollover
    }], { onConflict: 'id' });
    if (error) console.warn('[mirror] target upsert skipped:', target.id, '-', error.message);
  } catch (err) {
    console.warn('[mirror] target upsert threw:', target.id, '-', err?.message || err);
  }
}

// Lighter-weight version for the archive-goal path — only ever needs to flip
// the status field on an existing row, not the full target object.
async function mirrorArchiveTarget(supabase, targetId, status) {
  try {
    const { error } = await supabase.from('targets').update({ status }).eq('id', targetId);
    if (error) console.warn('[mirror] target status update skipped:', targetId, '-', error.message);
  } catch (err) {
    console.warn('[mirror] target status update threw:', targetId, '-', err?.message || err);
  }
}

async function mirrorSubscription(supabase, contributorId, targetId, expectedAmount, breakup) {
  try {
    const { error } = await supabase.from('contributor_subscriptions').upsert([{
      contributor_id: contributorId,
      target_id: targetId,
      expected_amount: expectedAmount || 0,
      breakup: breakup || null
    }], { onConflict: 'contributor_id,target_id' });
    if (error) console.warn('[mirror] subscription upsert skipped:', contributorId, targetId, '-', error.message);
  } catch (err) {
    console.warn('[mirror] subscription upsert threw:', contributorId, targetId, '-', err?.message || err);
  }
}

// Removing a subscriber from a goal — a real delete of the subscription row
// (not a soft-delete; there's no payment history living on this row itself,
// unlike pledges, so nothing is lost by actually removing it).
async function mirrorDeleteSubscription(supabase, contributorId, targetId) {
  try {
    const { error } = await supabase
      .from('contributor_subscriptions')
      .delete()
      .eq('contributor_id', contributorId)
      .eq('target_id', targetId);
    if (error) console.warn('[mirror] subscription delete skipped:', contributorId, targetId, '-', error.message);
  } catch (err) {
    console.warn('[mirror] subscription delete threw:', contributorId, targetId, '-', err?.message || err);
  }
}

// Mirrors an edit to an existing contributor's name/mobile.
async function mirrorEditContributor(supabase, contributorId, name, mobile, address) {
  try {
    const { error } = await supabase.from('contributors').update({ name, mobile, address: address || null }).eq('id', contributorId);
    if (error) console.warn('[mirror] contributor edit skipped:', contributorId, '-', error.message);
  } catch (err) {
    console.warn('[mirror] contributor edit threw:', contributorId, '-', err?.message || err);
  }
}

// Contributor deletion is a real DELETE here (not archive) — matching the
// schema's ON DELETE SET NULL on contributions/pledges, which already
// preserves payment history even when the contributor row itself is removed.
async function mirrorDeleteContributor(supabase, contributorId) {
  try {
    const { error } = await supabase.from('contributors').delete().eq('id', contributorId);
    if (error) console.warn('[mirror] contributor delete skipped:', contributorId, '-', error.message);
  } catch (err) {
    console.warn('[mirror] contributor delete threw:', contributorId, '-', err?.message || err);
  }
}

module.exports = {
  mirrorContribution,
  mirrorPledge,
  mirrorContributor,
  mirrorTarget,
  mirrorArchiveTarget,
  mirrorSubscription,
  mirrorDeleteSubscription,
  mirrorEditContributor,
  mirrorDeleteContributor,
  mirrorFullSyncBatch
};

// ---------------------------------------------------------------
// BATCH mirror for /pro/sync specifically. The app pushes its ENTIRE
// current state on every sync — mirroring that item-by-item (one
// network call per row) would mean hundreds of round trips per sync,
// reintroducing exactly the performance problem this whole project
// exists to fix. Instead, this does ONE upsert call per table,
// covering every row at once — same row-mapping logic as
// migrate-to-normalized.js, so a freshly synced account looks
// identical to one migrated by that script.
//
// Same rule as every other mirror function: never throws, never
// blocks, only logs. A single account's oversized/malformed sync
// should never take down the response to the app.
// ---------------------------------------------------------------
async function mirrorFullSyncBatch(supabase, userId, { contributors = [], targets = [], contributions = [], pledges = [] }) {
  try {
    const validTargetIds = new Set(targets.map(t => t.id));
    const validContributorIds = new Set(contributors.map(c => c.id));

    if (targets.length > 0) {
      const rows = targets.map(t => ({
        id: t.id, user_id: userId, name: t.name, category: t.category,
        status: t.status || 'active', target_amount: t.targetAmount ?? 0, rollover: !!t.rollover
      }));
      const { error } = await supabase.from('targets').upsert(rows, { onConflict: 'id' });
      if (error) console.warn('[mirror] sync targets batch skipped:', error.message);
    }

    if (contributors.length > 0) {
      const rows = contributors.map(c => ({
        id: c.id, user_id: userId, name: c.name, mobile: c.mobile, type: c.type || null,
        created_at: c.createdAt ? new Date(c.createdAt).toISOString() : new Date().toISOString()
      }));
      const { error } = await supabase.from('contributors').upsert(rows, { onConflict: 'id' });
      if (error) console.warn('[mirror] sync contributors batch skipped:', error.message);
    }

    const subscriptionRows = [];
    contributors.forEach(c => {
      (c.targetIds || []).forEach(targetId => {
        if (!validTargetIds.has(targetId)) return; // dangling reference — skip silently, same as migration script
        subscriptionRows.push({
          contributor_id: c.id, target_id: targetId,
          expected_amount: c.targetAmounts?.[targetId] ?? 0,
          breakup: c.targetBreakups?.[targetId] || null
        });
      });
    });
    if (subscriptionRows.length > 0) {
      const { error } = await supabase.from('contributor_subscriptions').upsert(subscriptionRows, { onConflict: 'contributor_id,target_id' });
      if (error) console.warn('[mirror] sync subscriptions batch skipped:', error.message);
    }

    const validContributions = contributions.filter(c => validTargetIds.has(c.targetId));
    if (validContributions.length > 0) {
      const rows = validContributions.map(c => ({
        id: c.id, user_id: userId,
        contributor_id: validContributorIds.has(c.contributorId) ? c.contributorId : null,
        target_id: c.targetId, amount_paid: c.amountPaid,
        paid_at: c.date ? new Date(c.date).toISOString() : new Date().toISOString(),
        collected_by: c.collectedBy || null, receipt_no: c.receiptNo || null, deleted: !!c.deleted
      }));
      const { error } = await supabase.from('contributions').upsert(rows, { onConflict: 'id' });
      if (error) console.warn('[mirror] sync contributions batch skipped:', error.message);
    }

    const validPledges = pledges.filter(p => validTargetIds.has(p.targetId));
    if (validPledges.length > 0) {
      const rows = validPledges.map(p => ({
        id: p.id, user_id: userId, target_id: p.targetId,
        contributor_id: (p.contributorId && validContributorIds.has(p.contributorId)) ? p.contributorId : null,
        name: p.name, mobile: p.mobile, promised_amount: p.promisedAmount, amount_paid: p.amountPaid || 0,
        status: p.status || 'pending',
        created_at: p.createdAt ? new Date(p.createdAt).toISOString() : new Date().toISOString(),
        last_payment_date: p.lastPaymentDate ? new Date(p.lastPaymentDate).toISOString() : null,
        last_receipt_no: p.lastReceiptNo || null,
        deleted: !!p.deleted,
        deleted_at: p.deletedAt ? new Date(p.deletedAt).toISOString() : null,
        deleted_payments: p.deletedPayments || null
      }));
      const { error } = await supabase.from('pledges').upsert(rows, { onConflict: 'id' });
      if (error) console.warn('[mirror] sync pledges batch skipped:', error.message);
    }
  } catch (err) {
    console.warn('[mirror] sync batch threw:', err?.message || err);
  }
}

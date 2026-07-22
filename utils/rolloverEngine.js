// ===================================================================
// AUTOMATIC MONTHLY/YEARLY GOAL ROLLOVER.
//
// Every monthly/yearly goal rolls over automatically once its period
// ends: a new goal is created for the next period (same base name,
// dated), every subscriber carries over, and anyone with an unpaid
// balance has it added on top of their normal per-period amount as a
// labeled arrear. This repeats indefinitely until the treasurer either
// stops it for that goal (rollover: false, via /web-stop-rollover) or
// manually completes/deletes the active goal — both remove it from
// consideration here since only status: 'active' goals are processed.
//
// Runs via two paths, both landing on processAllUsers() below:
//   1. An in-process daily scheduler (see server.js) — the normal path,
//      needs no external setup.
//   2. POST /api/auth/cron/run-rollovers — a manually/externally
//      triggerable fallback, protected by CRON_SECRET.
// ===================================================================

const supabase = require('../lib/supabase');
const { mirrorTarget, mirrorArchiveTarget, mirrorSubscription } = require('./mirrorWrite');

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function periodKeyForDate(date, category) {
  if (category === 'yearly') return String(date.getFullYear());
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function nextPeriodKey(key, category) {
  if (category === 'yearly') return String(Number(key) + 1);
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m, 1); // m is already 1-indexed here, so this lands on next month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function periodLabel(key, category) {
  if (category === 'yearly') return key;
  const [y, m] = key.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

// "YYYY-MM" and "YYYY" both sort correctly as plain strings.
function isPeriodBefore(a, b) {
  return a < b;
}

// Arrears-aware breakup math — kept identical to the app's own
// arrearsUtils.ts and the website's copy in ProDashboard.tsx, so a
// carried-forward balance always matches what every screen shows.
function getDefaultBreakup(targetName, amount) {
  return [{ label: `${targetName} due`, amount }];
}
function getRemainingBreakup(original, totalPaid) {
  let remainingPaid = Math.max(0, totalPaid);
  return original.map(item => {
    if (remainingPaid <= 0) return { ...item };
    const reduce = Math.min(item.amount, remainingPaid);
    remainingPaid -= reduce;
    return { ...item, amount: Math.round((item.amount - reduce) * 100) / 100 };
  });
}
function breakupTotal(breakup) {
  return breakup.reduce((s, i) => s + i.amount, 0);
}

// Processes rollovers for a single pro_user_data row. Mutates nothing
// outside its own copies; returns whether a write is needed and the
// updated arrays plus a list of best-effort mirror-write callbacks to
// run after the real write succeeds.
function processUserRow(row, today) {
  let targets = [...(row.targets || [])];
  let contributors = [...(row.contributors || [])];
  const contributions = row.contributions || [];
  const userId = row.user_id;

  let changed = false;
  let rolloverCount = 0;
  const afterWrite = [];

  // Snapshot the eligible starting set before we start pushing new targets
  // into `targets` mid-loop.
  const eligible = targets.filter(t =>
    (t.category === 'monthly' || t.category === 'yearly') &&
    t.status === 'active' &&
    t.rollover !== false
  );

  for (const startTarget of eligible) {
    const category = startTarget.category;
    const currentPeriod = periodKeyForDate(today, category);

    // Backfill goals created before this feature existed — start tracking
    // from the current period without assuming it needs to roll over
    // immediately (it may have been created any time during this period).
    if (!startTarget.rolloverPeriodKey) {
      const idx = targets.findIndex(t => t.id === startTarget.id);
      targets[idx] = {
        ...targets[idx],
        rolloverPeriodKey: currentPeriod,
        rolloverBaseName: targets[idx].rolloverBaseName || targets[idx].name
      };
      changed = true;
      continue;
    }

    // Chain through every period this goal has missed, one step at a
    // time, so a gap of several periods (e.g. this ran late) still
    // carries arrears through each step correctly instead of skipping
    // straight to the current period.
    let working = targets.find(t => t.id === startTarget.id);
    while (working && isPeriodBefore(working.rolloverPeriodKey, currentPeriod)) {
      const nextKey = nextPeriodKey(working.rolloverPeriodKey, category);
      const baseName = working.rolloverBaseName || working.name;

      // Idempotency guard — never create the same period twice, even if
      // this runs more than once around a boundary.
      const already = targets.find(t =>
        t.category === category && t.rolloverBaseName === baseName && t.rolloverPeriodKey === nextKey
      );
      if (already) { working = already; continue; }

      const newTargetId = `target-${category}-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 1000)}`;
      const newTarget = {
        id: newTargetId,
        name: `${baseName} — ${periodLabel(nextKey, category)}`,
        category,
        status: 'active',
        targetAmount: working.targetAmount || 0,
        rollover: true,
        rolloverBaseName: baseName,
        rolloverPeriodKey: nextKey
      };
      targets.push(newTarget);
      afterWrite.push(() => mirrorTarget(supabase, userId, newTarget));

      const oldId = working.id;
      const oldName = working.name;
      const oldAmount = working.targetAmount || 0;
      const oldIdx = targets.findIndex(t => t.id === oldId);
      targets[oldIdx] = { ...targets[oldIdx], status: 'completed', completedAt: new Date().toISOString() };
      afterWrite.push(() => mirrorArchiveTarget(supabase, oldId, 'completed'));

      // Carry every subscriber over, adding any unpaid balance on top of
      // their normal per-period amount as a labeled arrear.
      contributors = contributors.map(c => {
        if (!(c.targetIds || []).includes(oldId)) return c;

        const fallbackAmount = c.targetAmounts?.[oldId] ?? oldAmount;
        const originalBreakup = c.targetBreakups?.[oldId] || getDefaultBreakup(oldName, fallbackAmount);
        const totalPaid = contributions
          .filter(ct => ct.contributorId === c.id && ct.targetId === oldId && !ct.deleted)
          .reduce((s, ct) => s + ct.amountPaid, 0);
        const remaining = getRemainingBreakup(originalBreakup, totalPaid).filter(item => item.amount > 0.001);

        const newDueItem = { label: `${periodLabel(nextKey, category)} due`, amount: fallbackAmount };
        const newBreakup = [...remaining, newDueItem];
        const newAmount = breakupTotal(newBreakup);

        const nextTargetIds = [...(c.targetIds || [])];
        if (!nextTargetIds.includes(newTargetId)) nextTargetIds.push(newTargetId);

        afterWrite.push(() => mirrorSubscription(supabase, c.id, newTargetId, newAmount, newBreakup));

        return {
          ...c,
          targetIds: nextTargetIds,
          targetAmounts: { ...(c.targetAmounts || {}), [newTargetId]: newAmount },
          targetBreakups: { ...(c.targetBreakups || {}), [newTargetId]: newBreakup }
        };
      });

      changed = true;
      rolloverCount++;
      working = newTarget;
    }
  }

  return { changed, targets, contributors, rolloverCount, afterWrite };
}

async function runRolloverForAllUsers() {
  const today = new Date();
  const summary = { usersChecked: 0, usersUpdated: 0, rolloversCreated: 0, errors: [] };

  const { data: rows, error } = await supabase
    .from('pro_user_data')
    .select('user_id, targets, contributors, contributions');

  if (error) {
    console.error('[rollover] could not load pro_user_data:', error.message);
    summary.errors.push(error.message);
    return summary;
  }

  for (const row of rows || []) {
    summary.usersChecked++;
    try {
      const result = processUserRow(row, today);
      if (!result.changed) continue;

      const { error: updateError } = await supabase
        .from('pro_user_data')
        .update({ targets: result.targets, contributors: result.contributors, updated_at: new Date().toISOString() })
        .eq('user_id', row.user_id);

      if (updateError) {
        console.error(`[rollover] write failed for ${row.user_id}:`, updateError.message);
        summary.errors.push(`${row.user_id}: ${updateError.message}`);
        continue;
      }

      summary.usersUpdated++;
      summary.rolloversCreated += result.rolloverCount;

      // Best-effort mirror writes — never block or fail the real result.
      for (const write of result.afterWrite) {
        write().catch(() => {});
      }
    } catch (err) {
      console.error(`[rollover] error processing ${row.user_id}:`, err?.message || err);
      summary.errors.push(`${row.user_id}: ${err?.message || err}`);
    }
  }

  console.log(`[rollover] checked ${summary.usersChecked} users, updated ${summary.usersUpdated}, created ${summary.rolloversCreated} new goal(s).`);
  return summary;
}

module.exports = {
  runRolloverForAllUsers,
  // exported for tests / reuse
  periodKeyForDate,
  nextPeriodKey,
  periodLabel,
  isPeriodBefore,
  processUserRow
};

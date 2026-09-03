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
const { nextId } = require('./idGen');

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

// Quarterly uses calendar quarters (Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec),
// keyed "YYYY-Qn" — deliberately distinct from the "YYYY-MM" shape monthly/
// installment goals use, so isPeriodBefore's plain string comparison still
// sorts correctly within a category (never compared across categories).
function periodKeyForDate(date, category) {
  if (category === 'yearly') return String(date.getFullYear());
  if (category === 'quarterly') {
    const quarter = Math.floor(date.getMonth() / 3) + 1;
    return `${date.getFullYear()}-Q${quarter}`;
  }
  // 'monthly' and 'installment' (which auto-stops after N monthly periods,
  // see the installmentsPaid/totalInstallments handling below) share this
  // same "YYYY-MM" period shape.
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function nextPeriodKey(key, category) {
  if (category === 'yearly') return String(Number(key) + 1);
  if (category === 'quarterly') {
    const [y, q] = key.split('-Q').map(Number);
    return q >= 4 ? `${y + 1}-Q1` : `${y}-Q${q + 1}`;
  }
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m, 1); // m is already 1-indexed here, so this lands on next month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function periodLabel(key, category) {
  if (category === 'yearly') return key;
  if (category === 'quarterly') {
    const [y, q] = key.split('-Q');
    return `Q${q} ${y}`;
  }
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
// A breakup may contain at most one negative line — a banked "Advance
// credit" from a past overpayment (see /web-collect-payment). It's applied
// automatically to whatever's still due, oldest item first, in a second
// pass after real cash payments. Kept identical to utils/arrears.js.
function getRemainingBreakup(original, totalPaid) {
  const round2 = n => Math.round(n * 100) / 100;
  const creditIdx = original.findIndex(i => i.amount < 0);
  const creditLabel = creditIdx !== -1 ? original[creditIdx].label : 'Advance credit';
  const startingCredit = creditIdx !== -1 ? -original[creditIdx].amount : 0;
  const dueItems = original.filter((_, i) => i !== creditIdx);

  let remainingPaid = Math.max(0, totalPaid);
  let result = dueItems.map(item => {
    if (remainingPaid <= 0) return { ...item };
    const reduce = Math.min(item.amount, remainingPaid);
    remainingPaid -= reduce;
    return { ...item, amount: round2(item.amount - reduce) };
  });

  let remainingCredit = startingCredit;
  result = result.map(item => {
    if (remainingCredit <= 0 || item.amount <= 0) return item;
    const reduce = Math.min(item.amount, remainingCredit);
    remainingCredit -= reduce;
    return { ...item, amount: round2(item.amount - reduce) };
  });

  if (creditIdx === -1) return result;
  return [{ label: creditLabel, amount: round2(-remainingCredit) }, ...result];
}
function breakupTotal(breakup) {
  return breakup.reduce((s, i) => s + i.amount, 0);
}

// Processes rollovers for a single pro_user_data row. Mutates nothing
// outside its own copies; returns whether a write is needed and the
// updated arrays plus a list of best-effort mirror-write callbacks to
// run after the real write succeeds.
async function processUserRow(row, today) {
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
    (t.category === 'monthly' || t.category === 'yearly' || t.category === 'quarterly' || t.category === 'installment') &&
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

      // Prefixed with the owning pro user's own ID (see utils/idGen.js) —
      // can never collide with another user's goal id.
      const newTargetId = await nextId(supabase, userId, category);
      // Installment goals are otherwise identical to monthly (same "YYYY-MM"
      // period shape, see periodKeyForDate above) but carry a fixed
      // totalInstallments count and auto-stop rolling over once that many
      // periods have been created — the "recurring but self-terminating"
      // behavior, as opposed to monthly/yearly/quarterly which roll over
      // indefinitely until the treasurer stops them.
      const isInstallment = category === 'installment';
      const installmentsPaid = isInstallment ? (working.installmentsPaid || 0) + 1 : undefined;
      const totalInstallments = isInstallment ? working.totalInstallments : undefined;
      const isVariable = isInstallment && working.installmentType === 'variable';
      const installmentFields = isInstallment
        ? {
            installmentsPaid, totalInstallments, installmentType: working.installmentType || 'fixed',
            rollover: totalInstallments ? installmentsPaid < totalInstallments : true,
            // Variable installments keep last period's amount as a safe
            // default (so collection isn't blocked if the treasurer hasn't
            // updated it yet) but flag the new period as awaiting a fresh
            // figure — surfaced as a dashboard reminder (see
            // routes/web/goals.js's /web-set-installment-amount) until the
            // treasurer confirms/changes it for this period.
            ...(isVariable ? { awaitingAmount: true } : {})
          }
        : { rollover: true };
      const newTarget = {
        id: newTargetId,
        name: `${baseName} — ${periodLabel(nextKey, category)}`,
        category,
        status: 'active',
        targetAmount: working.targetAmount || 0,
        rolloverBaseName: baseName,
        rolloverPeriodKey: nextKey,
        ...installmentFields
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

        // The stable "normal" per-period amount, NOT the true-current-due
        // value: prefer recurringAmounts (keyed by the goal's stable base
        // name, set at subscribe-time and kept accurate here) over
        // targetAmounts, which drifts to reflect arrears/credit-inclusive
        // totals as payments and rollovers happen and would otherwise cause
        // that drifted value to compound into every following period.
        const recurringAmount = c.recurringAmounts?.[baseName];
        const fallbackAmount = recurringAmount ?? c.targetAmounts?.[oldId] ?? oldAmount;
        const originalBreakup = c.targetBreakups?.[oldId] || getDefaultBreakup(oldName, fallbackAmount);
        const totalPaid = contributions
          .filter(ct => ct.contributorId === c.id && ct.targetId === oldId && !ct.deleted)
          .reduce((s, ct) => s + ct.amountPaid, 0);
        // Keep unresolved arrears (positive) AND any leftover advance credit
        // (negative) — only drop exactly-zero lines. Dropping negative
        // items here would silently erase banked credit at every rollover.
        const remaining = getRemainingBreakup(originalBreakup, totalPaid).filter(item => Math.abs(item.amount) > 0.001);

        const newDueItem = { label: `${periodLabel(nextKey, category)} due`, amount: fallbackAmount };
        const newBreakup = [...remaining, newDueItem];
        const newAmount = breakupTotal(newBreakup);

        const nextTargetIds = [...(c.targetIds || [])];
        if (!nextTargetIds.includes(newTargetId)) nextTargetIds.push(newTargetId);

        afterWrite.push(() => mirrorSubscription(supabase, c.id, newTargetId, newAmount, newBreakup, userId));

        return {
          ...c,
          targetIds: nextTargetIds,
          targetAmounts: { ...(c.targetAmounts || {}), [newTargetId]: newAmount },
          targetBreakups: { ...(c.targetBreakups || {}), [newTargetId]: newBreakup },
          recurringAmounts: { ...(c.recurringAmounts || {}), [baseName]: fallbackAmount }
        };
      });

      changed = true;
      rolloverCount++;
      working = newTarget;

      // Stop chaining once an installment goal has hit its cap — even if
      // the cron ran late enough that currentPeriod is still further
      // ahead, a capped-out installment goal must not keep generating
      // more periods past totalInstallments.
      if (working.rollover === false) break;
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
      const result = await processUserRow(row, today);
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

      // Best-effort mirror writes — never fail the real result if one of
      // these has a problem. Run strictly in push order (not concurrently):
      // a new target's row must exist before any mirrorSubscription for it
      // runs, since contributor_subscriptions.target_id has a foreign key
      // to targets.id — firing them all at once let some subscription
      // writes race ahead of their own target's insert and silently fail.
      for (const write of result.afterWrite) {
        try { await write(); } catch { /* already logged inside each mirror* helper */ }
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
  processUserRow,
  // exported for routes/web/goals.js's /web-set-installment-amount, which
  // needs the same breakup-total math to recompute a contributor's due
  // after swapping in a variable installment's freshly-entered amount.
  breakupTotal
};

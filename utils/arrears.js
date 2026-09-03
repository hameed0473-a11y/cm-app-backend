// ---------------------------------------------------------------
// Arrears-aware due calculation — ported from the app's own
// arrearsUtils.ts so amounts here always match what the app itself
// would show, oldest arrear cleared first. Moved unchanged from
// routes/auth.js. Used by pro.js (/pro/lookup-dues and
// /pro/create-payment-link-public).
// ---------------------------------------------------------------
function getDefaultBreakup(target, amount) {
  return [{ label: `${target.name} due`, amount }];
}

// A breakup may contain at most one negative line — a banked "Advance
// credit" from a past overpayment (see /web-collect-payment). It's applied
// automatically to whatever's still due, oldest item first, in a second
// pass after real cash payments — no new cash is needed to "unlock" it, it
// just keeps reducing future dues (including across rollovers) until used
// up. Contributors who never overpaid have no credit line, so this is a
// no-op for them and behaves exactly as before.
function getRemainingBreakup(original, totalPaid) {
  const round2 = n => Math.round(n * 100) / 100;
  const creditIdx = original.findIndex(i => i.amount < 0);
  const creditLabel = creditIdx !== -1 ? original[creditIdx].label : 'Advance credit';
  const startingCredit = creditIdx !== -1 ? -original[creditIdx].amount : 0;
  const dueItems = original.filter((_, i) => i !== creditIdx);

  // Pass 1 — reduce real dues using actual cash paid, oldest first.
  let remainingPaid = Math.max(0, totalPaid);
  let result = dueItems.map(item => {
    if (remainingPaid <= 0) return { ...item };
    const reduce = Math.min(item.amount, remainingPaid);
    remainingPaid -= reduce;
    return { ...item, amount: round2(item.amount - reduce) };
  });

  // Pass 2 — reduce whatever's left using banked credit, oldest first.
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

module.exports = { getDefaultBreakup, getRemainingBreakup, breakupTotal };

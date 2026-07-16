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

module.exports = { getDefaultBreakup, getRemainingBreakup, breakupTotal };

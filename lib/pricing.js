// ---------------------------------------------------------------
// Pro Dashboard subscription pricing — per-subscriber/contributor
// annual rate, in one of two fixed buckets based on the treasurer's
// selected collection currency: INR gets the India rate, every other
// currency (USD/GBP/EUR) gets the international rate.
//
// The two rates are stored in platform_pricing (a single-row table,
// id=1) and editable from the admin dashboard's Platform Settings ->
// Pricing card — no code change or redeploy needed to change them.
// DEFAULT_RATES below is only a fallback for the (should-never-happen)
// case where that row is missing or the query fails, so pricing never
// hard-crashes.
//
// This module ONLY computes what's owed — there is no automatic
// charging wired up yet. web-login returns this alongside a 403 once
// the trial/subscription has expired, and web-dashboard-data returns
// it during the active trial so the frontend can show the "here's
// what you'll pay" pricing notice at first login.
// ---------------------------------------------------------------

const supabase = require('./supabase');

const DEFAULT_RATES = { INR: 50, USD: 2 };

async function getCurrentRates() {
  try {
    const { data, error } = await supabase
      .from('platform_pricing')
      .select('inr_rate, intl_rate')
      .eq('id', 1)
      .single();
    if (error || !data) return DEFAULT_RATES;
    return {
      INR: Number(data.inr_rate) || DEFAULT_RATES.INR,
      USD: Number(data.intl_rate) || DEFAULT_RATES.USD
    };
  } catch (err) {
    console.error('getCurrentRates failed, using defaults:', err?.message || err);
    return DEFAULT_RATES;
  }
}

// Any non-INR collection currency (USD/GBP/EUR) maps to the international
// rate — matches "India pricing only for INR, otherwise international
// pricing" as specified.
async function getPricingPlan(currency) {
  const rates = await getCurrentRates();
  return currency === 'INR'
    ? { currency: 'INR', rate: rates.INR, symbol: 'Rs.', label: `Rs. ${rates.INR}/year per subscriber, inclusive of all taxes` }
    : { currency: 'USD', rate: rates.USD, symbol: '$', label: `USD $${rates.USD}/year per subscriber, inclusive of all taxes` };
}

// Counts UNIQUE people being billed, not rows in one array. Contributors
// and event/pledge subscribers are stored in two separate arrays
// (pro_user_data.contributors vs pro_user_data.pledges), and a pledge can
// be created with just a name+mobile with NO link back to `contributors`
// (the manual "Add pledge" form inside an Event goal does this whenever
// the person isn't already an existing contributor). Counting
// contributors.length alone would let someone dodge billing entirely by
// only ever using pledges. This unions both by mobile number instead, so
// every distinct person is counted exactly once regardless of which
// array they live in. Deleted/reversed pledges don't count.
function countUniqueSubscribers(contributors, pledges) {
  const mobiles = new Set();
  (contributors || []).forEach(c => {
    if (c && c.mobile) mobiles.add(String(c.mobile).trim());
  });
  (pledges || []).forEach(p => {
    if (p && p.mobile && !p.deleted) mobiles.add(String(p.mobile).trim());
  });
  return mobiles.size;
}

async function computeAmountDue(subscriberCount, currency) {
  const plan = await getPricingPlan(currency);
  const count = Math.max(0, Number(subscriberCount) || 0);
  const amount = Math.round(plan.rate * count * 100) / 100;
  return {
    currency: plan.currency,
    rate: plan.rate,
    symbol: plan.symbol,
    label: plan.label,
    subscriberCount: count,
    amount
  };
}

// ---------------------------------------------------------------
// RECEIPT LIMIT — replaces an earlier, more complicated approach (a
// separate "unique subscriber add" cap plus a "total goal-subscription
// slot" cap). That was abandoned as too complex to reason about and,
// worse, doesn't even map cleanly onto the data: a pledge's payment
// history isn't fully retained (each installment overwrites the same
// pledge's lastReceiptNo — there's no per-payment log to count
// retroactively), so deriving a slot/receipt count from existing arrays
// is inherently lossy for pledges.
//
// Instead: a single running counter, pro_users.total_receipts_generated,
// incremented by exactly 1 every time /web-collect-payment successfully
// creates a receipt (Monthly/Yearly contribution OR a pledge payment —
// both go through that one endpoint). The cap is simply
// paid_subscriber_count × receiptsPerSubscriber (default 100, its own
// adjustable column — pro_users.receipts_per_subscriber — rather than a
// hardcoded constant, same reasoning as max_slot_multiplier before it).
// NULL paid_subscriber_count = unbilled/trial = no cap, same convention
// as everywhere else in this file.
// ---------------------------------------------------------------
function getMaxReceipts(paidSubscriberCount, receiptsPerSubscriber) {
  if (paidSubscriberCount == null) return null;
  const perSub = Number(receiptsPerSubscriber) || 100;
  return Math.max(0, Number(paidSubscriberCount) || 0) * perSub;
}

// Bundles the numbers the frontend needs to show either nothing (no cap
// yet), a 90%+ usage warning banner, or a hard "limit reached" block.
function getReceiptUsage(totalReceiptsGenerated, maxReceipts) {
  const total = Math.max(0, Number(totalReceiptsGenerated) || 0);
  if (maxReceipts == null) {
    return { total, max: null, remaining: null, percentUsed: null, isWarning: false, isBlocked: false };
  }
  const remaining = Math.max(0, maxReceipts - total);
  const percentUsed = maxReceipts > 0 ? Math.round((total / maxReceipts) * 100) : 100;
  return {
    total,
    max: maxReceipts,
    remaining,
    percentUsed,
    isWarning: percentUsed >= 90,
    isBlocked: total >= maxReceipts
  };
}

module.exports = {
  getPricingPlan,
  computeAmountDue,
  countUniqueSubscribers,
  getMaxReceipts,
  getReceiptUsage,
  getCurrentRates
};

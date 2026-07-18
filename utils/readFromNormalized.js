// ===================================================================
// Reconstructs the SAME nested JSON shape the app and website already
// expect (contributors with embedded targetIds/targetAmounts/
// targetBreakups, etc.) by querying the new normalized tables instead
// of reading the old pro_user_data JSON columns.
//
// This is what eventually replaces reading from the old columns —
// but for now it's used in SHADOW-READ mode only: called alongside
// the old read, compared, logged, and never actually returned to the
// client until we're confident it matches real usage exactly.
// ===================================================================

async function fetchNormalizedUserData(supabase, userId) {
  const [
    { data: targetsRows, error: targetsErr },
    { data: contributorsRows, error: contributorsErr },
    { data: contributionsRows, error: contributionsErr },
    { data: pledgesRows, error: pledgesErr }
  ] = await Promise.all([
    supabase.from('targets').select('*').eq('user_id', userId),
    supabase.from('contributors').select('*').eq('user_id', userId),
    supabase.from('contributions').select('*').eq('user_id', userId),
    supabase.from('pledges').select('*').eq('user_id', userId)
  ]);

  const firstError = targetsErr || contributorsErr || contributionsErr || pledgesErr;
  if (firstError) {
    throw new Error(`fetchNormalizedUserData failed: ${firstError.message}`);
  }

  // Subscriptions link to contributors, not directly to user_id, so fetch
  // them by this account's own contributor ids (queried above) rather than
  // relying on a nested-join filter — simpler and easier to verify correct.
  const contributorIds = (contributorsRows || []).map(c => c.id);
  const { data: subsRows, error: subsErr } = await supabase
    .from('contributor_subscriptions')
    .select('*')
    .in('contributor_id', contributorIds.length > 0 ? contributorIds : ['__none__']);

  if (subsErr) throw new Error(`fetchNormalizedUserData (subscriptions) failed: ${subsErr.message}`);

  // Group subscriptions by contributor, so they can be embedded back onto
  // each contributor object exactly like the old targetIds/targetAmounts/
  // targetBreakups shape.
  const subsByContributor = new Map();
  (subsRows || []).forEach(s => {
    if (!subsByContributor.has(s.contributor_id)) subsByContributor.set(s.contributor_id, []);
    subsByContributor.get(s.contributor_id).push(s);
  });

  const contributors = (contributorsRows || []).map(c => {
    const subs = subsByContributor.get(c.id) || [];
    const targetIds = subs.map(s => s.target_id);
    const targetAmounts = {};
    const targetBreakups = {};
    subs.forEach(s => {
      targetAmounts[s.target_id] = Number(s.expected_amount) || 0;
      if (s.breakup) targetBreakups[s.target_id] = s.breakup;
    });
    return {
      id: c.id,
      name: c.name,
      mobile: c.mobile,
      address: c.address || undefined,
      type: c.type || undefined,
      createdAt: c.created_at ? c.created_at.slice(0, 10) : undefined,
      targetIds,
      targetAmounts,
      targetBreakups
    };
  });

  const targets = (targetsRows || []).map(t => ({
    id: t.id,
    name: t.name,
    category: t.category,
    status: t.status,
    targetAmount: Number(t.target_amount) || 0,
    ...(t.category !== 'event' ? { rollover: !!t.rollover } : {})
  }));

  const contributions = (contributionsRows || []).map(c => ({
    id: c.id,
    contributorId: c.contributor_id,
    targetId: c.target_id,
    amountPaid: Number(c.amount_paid),
    date: c.paid_at,
    collectedBy: c.collected_by || undefined,
    collectedById: c.collected_by_id || undefined,
    receiptNo: c.receipt_no || undefined,
    deleted: c.deleted || undefined
  }));

  const pledges = (pledgesRows || []).map(p => ({
    id: p.id,
    targetId: p.target_id,
    targetName: targets.find(t => t.id === p.target_id)?.name || undefined,
    name: p.name,
    mobile: p.mobile,
    promisedAmount: Number(p.promised_amount),
    amountPaid: Number(p.amount_paid) || 0,
    status: p.status,
    createdAt: p.created_at,
    contributorId: p.contributor_id || undefined,
    lastPaymentDate: p.last_payment_date || undefined,
    lastReceiptNo: p.last_receipt_no || undefined,
    collectedBy: p.collected_by || undefined,
    collectedById: p.collected_by_id || undefined,
    deleted: p.deleted || undefined,
    deletedAt: p.deleted_at || undefined,
    deletedPayments: p.deleted_payments || undefined
  }));

  return { contributors, targets, contributions, pledges };
}

// ---------------------------------------------------------------
// Compares old (authoritative) vs new (reconstructed) data and returns
// a short list of human-readable differences. Deliberately coarse
// (counts + spot-checks a few key aggregates) rather than a deep
// field-by-field diff — the goal is "does this look wrong enough to
// investigate", not a byte-perfect audit on every request.
//
// IMPORTANT: the new tables enforce real foreign keys, so they never
// contain a pledge/subscription/contribution that points at a target
// which doesn't exist. The old JSON has no such enforcement and can
// carry old orphaned entries (e.g. a pledge left over from a goal
// deleted through some other path, long before this project existed).
// Those are EXPECTED to be absent from the new tables — that's the new
// tables being more correct, not a bug — so this function filters
// orphaned entries out of the OLD side first, comparing "old data that
// could possibly have migrated" against "what actually did", rather
// than flagging the same known orphans as a mismatch forever.
// ---------------------------------------------------------------
function compareUserData(oldData, newData) {
  const diffs = [];

  const oldT = oldData.targets || [];
  const newT = newData.targets || [];
  const validOldTargetIds = new Set(oldT.map(t => t.id));
  if (oldT.length !== newT.length) diffs.push(`targets count: old=${oldT.length} new=${newT.length}`);

  const oldC = oldData.contributors || [];
  const newC = newData.contributors || [];
  if (oldC.length !== newC.length) diffs.push(`contributors count: old=${oldC.length} new=${newC.length}`);

  // Only count a contribution as "should have migrated" if its target
  // actually exists — same rule the migration script itself applies.
  const oldContrib = (oldData.contributions || []).filter(c => !c.deleted && validOldTargetIds.has(c.targetId));
  const newContrib = (newData.contributions || []).filter(c => !c.deleted);
  if (oldContrib.length !== newContrib.length) diffs.push(`contributions count: old=${oldContrib.length} new=${newContrib.length}`);

  const oldTotal = oldContrib.reduce((s, c) => s + (c.amountPaid || 0), 0);
  const newTotal = newContrib.reduce((s, c) => s + (c.amountPaid || 0), 0);
  if (Math.abs(oldTotal - newTotal) > 0.01) diffs.push(`total collected: old=${oldTotal} new=${newTotal}`);

  // Same rule for pledges — only ones pointing at a real target "should" migrate.
  const oldPValid = (oldData.pledges || []).filter(p => validOldTargetIds.has(p.targetId));
  const newP = newData.pledges || [];
  if (oldPValid.length !== newP.length) diffs.push(`pledges count: old=${oldPValid.length} new=${newP.length} (excluding known-orphaned pledges already absent from old targets)`);

  // Spot-check: every old contributor's subscription set should match,
  // but only for target ids that actually exist — a contributor's
  // targetIds pointing at a long-gone target is the same known-orphan
  // situation, not a real mismatch.
  oldC.forEach(oc => {
    const nc = newC.find(c => c.id === oc.id);
    if (!nc) { diffs.push(`contributor ${oc.id} ("${oc.name}") missing from new tables`); return; }
    const oldIds = new Set((oc.targetIds || []).filter(id => validOldTargetIds.has(id)));
    const newIds = new Set(nc.targetIds || []);
    if (oldIds.size !== newIds.size || [...oldIds].some(id => !newIds.has(id))) {
      diffs.push(`contributor ${oc.id} subscription mismatch: old=[${[...oldIds]}] new=[${[...newIds]}]`);
    }
  });

  return diffs;
}

// Runs the shadow-read comparison and only ever logs — never throws,
// never affects the response already being sent to the client.
async function shadowReadCheck(supabase, userId, oldData) {
  try {
    const newData = await fetchNormalizedUserData(supabase, userId);
    const diffs = compareUserData(oldData, newData);
    if (diffs.length > 0) {
      console.warn(`[shadow-read] MISMATCH for user ${userId}:`);
      diffs.forEach(d => console.warn(`  - ${d}`));
    } else {
      console.log(`[shadow-read] OK for user ${userId} — new tables match old data.`);
    }
  } catch (err) {
    console.warn(`[shadow-read] check failed for user ${userId}:`, err?.message || err);
  }
}

module.exports = { fetchNormalizedUserData, compareUserData, shadowReadCheck };

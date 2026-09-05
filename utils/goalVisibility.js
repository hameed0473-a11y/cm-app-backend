// ===================================================================
// Goal-category visibility filter.
//
// Hides specific goal categories from what's handed back to clients
// (web dashboard + mobile app) WITHOUT touching anything else: the
// rows stay in the database exactly as they are, the rollover engine
// keeps advancing them to new periods and compounding arrears same as
// any other goal, every write endpoint (create/collect/subscribe/...)
// keeps working on them unchanged. This only filters what comes back
// out of the three "here's your data" reads — /web-dashboard-data,
// /pro/login, /pro/sync (GET) — so a hidden category simply never
// shows up when someone opens the app.
//
// To hide a category again later, add it back to HIDDEN_CATEGORIES
// below — nothing else in the codebase needs to change. Currently
// empty: every goal category (including quarterly) is visible again.
// ===================================================================

const HIDDEN_CATEGORIES = [];

// Returns a NEW data object ({ contributors, targets, contributions,
// pledges }) with every hidden-category target removed, plus anything
// that only exists to support those targets: contributions/pledges
// recorded against them, and the corresponding entries inside each
// contributor's targetIds/targetAmounts/targetBreakups. Never mutates
// the object passed in — callers that still need the FULL data (the
// shadow-read drift check against the old JSON, or a subscriber-count/
// pricing calculation that should keep counting real subscribers even
// on a hidden goal) should keep using the original, unfiltered object
// and only pass a filtered copy to the client-facing response.
//
// `hiddenCategories` defaults to the live HIDDEN_CATEGORIES list above
// but can be overridden — mainly so tests can exercise the filtering
// logic itself without depending on whatever categories happen to be
// hidden in production at any given time.
function hideConfiguredCategories(data, hiddenCategories = HIDDEN_CATEGORIES) {
  if (!data) return data;

  const hiddenTargetIds = new Set(
    (data.targets || [])
      .filter(t => hiddenCategories.includes(t.category))
      .map(t => t.id)
  );
  if (hiddenTargetIds.size === 0) return data;

  const targets = (data.targets || []).filter(t => !hiddenTargetIds.has(t.id));

  const contributors = (data.contributors || []).map(c => {
    if (!(c.targetIds || []).some(id => hiddenTargetIds.has(id))) return c;
    const targetIds = (c.targetIds || []).filter(id => !hiddenTargetIds.has(id));
    const targetAmounts = { ...(c.targetAmounts || {}) };
    const targetBreakups = { ...(c.targetBreakups || {}) };
    hiddenTargetIds.forEach(id => {
      delete targetAmounts[id];
      delete targetBreakups[id];
    });
    return { ...c, targetIds, targetAmounts, targetBreakups };
  });

  const contributions = (data.contributions || []).filter(c => !hiddenTargetIds.has(c.targetId));
  const pledges = (data.pledges || []).filter(p => !hiddenTargetIds.has(p.targetId));

  return { ...data, targets, contributors, contributions, pledges };
}

module.exports = { hideConfiguredCategories, HIDDEN_CATEGORIES };

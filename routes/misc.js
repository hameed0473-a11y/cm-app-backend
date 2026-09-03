const express = require('express');

const supabase = require('../lib/supabase');

const router = express.Router();

// ===============================================================
// VISITOR COUNTER
// ===============================================================

// POST /visitor — increments count and returns the new total
// Called once on every landing page load (fire-and-forget from frontend)
router.post('/visitor', async (req, res) => {
  try {
    // Try to increment existing row (id = 1)
    const { data: existing } = await supabase
      .from('site_stats')
      .select('count')
      .eq('id', 1)
      .single();

    if (existing) {
      const newCount = (existing.count || 0) + 1;
      await supabase
        .from('site_stats')
        .update({ count: newCount, last_visited_at: new Date().toISOString() })
        .eq('id', 1);
      return res.json({ success: true, count: newCount });
    } else {
      // First ever visit — create the row
      await supabase
        .from('site_stats')
        .insert([{ id: 1, count: 1, last_visited_at: new Date().toISOString() }]);
      return res.json({ success: true, count: 1 });
    }
  } catch (err) {
    console.error('Visitor counter error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /visitor — fetch current count (optional, for admin dashboard use)
router.get('/visitor', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('site_stats')
      .select('count, last_visited_at')
      .eq('id', 1)
      .single();

    if (error || !data) return res.json({ success: true, count: 0 });
    res.json({ success: true, count: data.count, lastVisitedAt: data.last_visited_at });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

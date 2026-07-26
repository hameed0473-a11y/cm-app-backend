const express = require('express');
require('dotenv').config();

const supabase = require('../lib/supabase');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ===============================================================
// ADMIN — AI ASSISTANT ESCALATIONS. Every message the local parser
// doesn't recognize gets logged (see routes/web/assistant.js), whether
// or not it actually reached Claude — along with Claude's own reply text
// and any tool it decided to call, so this view shows not just what was
// asked but how well Claude already handled it. That's what makes it
// possible to judge whether a recurring phrasing is worth turning into a
// new predefined local-parser task (see utils/assistantLocalIntent.js),
// instead of paying to escalate the same kind of question indefinitely.
// ===============================================================
router.get('/admin-assistant-escalations', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('assistant_escalations')
      .select('message, user_id, had_api_key, assistant_reply, action_type, action_params, created_at')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) return res.status(500).json({ error: error.message });

    // Grouped by a loosely-normalized message (lowercased, punctuation and
    // extra whitespace stripped) so near-duplicate phrasings of the same
    // recurring question collapse into one count instead of 500 separate
    // one-off rows — the whole point is spotting patterns quickly. Each
    // group keeps its most recent example reply/action so a reviewer can
    // judge Claude's answer quality without opening every individual row.
    const groups = new Map();
    (data || []).forEach(row => {
      const key = row.message.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
      if (!groups.has(key)) {
        groups.set(key, {
          message: row.message, count: 0, lastSeen: row.created_at,
          exampleReply: row.assistant_reply, exampleActionType: row.action_type, exampleActionParams: row.action_params
        });
      }
      const g = groups.get(key);
      g.count++;
      if (row.created_at > g.lastSeen) {
        g.lastSeen = row.created_at;
        g.exampleReply = row.assistant_reply;
        g.exampleActionType = row.action_type;
        g.exampleActionParams = row.action_params;
      }
    });

    const grouped = Array.from(groups.values()).sort((a, b) => b.count - a.count);

    res.json({ success: true, total: data?.length || 0, grouped, recent: data || [] });
  } catch (err) {
    console.error('admin-assistant-escalations error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

module.exports = router;

const express = require('express');
require('dotenv').config();

const supabase = require('../lib/supabase');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ===============================================================
// ADMIN — SUPPORT TICKETS
// Lists every ticket raised from the Pro Dashboard (routes/web/tickets.js)
// and lets the admin mark one solved/pending.
// ===============================================================

// --- List all tickets (newest first) ---
router.get('/admin-tickets', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('support_tickets')
      .select('id, user_id, name, mobile, category, description, status, admin_remarks, created_at, resolved_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('admin-tickets error:', error.message);
      return res.status(500).json({ error: 'Could not load tickets.' });
    }

    res.json({ success: true, tickets: data || [] });
  } catch (err) {
    console.error('admin-tickets error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// --- Mark a ticket solved or pending. Remarks are REQUIRED when marking
// solved — the treasurer sees these (via /web-my-tickets), so a ticket
// can't be closed with no explanation of what was done. ---
router.post('/admin-resolve-ticket', requireAdmin, async (req, res) => {
  const ticketId = String(req.body.ticketId || '');
  const status = String(req.body.status || '').toLowerCase();
  const remarks = String(req.body.remarks || '').trim();

  if (!ticketId) return res.status(400).json({ error: 'ticketId is required' });
  if (!['pending', 'solved'].includes(status)) {
    return res.status(400).json({ error: 'status must be "pending" or "solved".' });
  }
  if (status === 'solved' && !remarks) {
    return res.status(400).json({ error: 'Please enter remarks before marking this ticket solved.' });
  }

  try {
    const { error } = await supabase
      .from('support_tickets')
      .update({
        status,
        // Remarks are saved regardless of which way the status moves, so
        // reopening a ticket doesn't silently drop what was already
        // written — only re-closing it re-enforces the requirement.
        ...(remarks ? { admin_remarks: remarks } : {}),
        resolved_at: status === 'solved' ? new Date().toISOString() : null
      })
      .eq('id', ticketId);

    if (error) {
      console.error('admin-resolve-ticket error:', error.message);
      return res.status(500).json({ error: 'Could not update the ticket.' });
    }

    res.json({ success: true, ticketId, status, remarks: remarks || null });
  } catch (err) {
    console.error('admin-resolve-ticket error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

module.exports = router;

const express = require('express');
require('dotenv').config();

const supabase = require('../../lib/supabase');
const { requireProToken } = require('../../middleware/auth');

const router = express.Router();

// ===============================================================
// PRO WEB DASHBOARD — support tickets. A treasurer raises a ticket
// (category + description) from the dashboard; it's routed to the
// admin dashboard for resolution (see routes/adminTickets.js).
// ===============================================================

const CATEGORIES = ['billing', 'collection', 'receipt_pdf', 'import_subscribers', 'other'];

// --- Raise a new ticket ---
router.post('/web-raise-ticket', requireProToken, async (req, res) => {
  const category = String(req.body.category || '').toLowerCase();
  const description = String(req.body.description || '').trim();

  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Please choose a valid category.' });
  }
  if (!description) {
    return res.status(400).json({ error: 'Please describe the issue.' });
  }
  if (description.length > 4000) {
    return res.status(400).json({ error: 'Description is too long (max 4000 characters).' });
  }

  try {
    const { data: proUser } = await supabase
      .from('pro_users')
      .select('name, mobile')
      .eq('id', req.proUserId)
      .single();

    const ticket = {
      id: `TICKET-${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 10)}`,
      user_id: req.proUserId,
      name: proUser?.name || null,
      mobile: proUser?.mobile || null,
      category,
      description,
      status: 'pending',
      created_at: new Date().toISOString()
    };

    const { error } = await supabase.from('support_tickets').insert([ticket]);
    if (error) {
      console.error('web-raise-ticket insert error:', error.message);
      return res.status(500).json({ error: 'Could not submit your ticket. Please try again.' });
    }

    res.json({ success: true, ticket });
  } catch (err) {
    console.error('web-raise-ticket error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// --- List this treasurer's own tickets (newest first) ---
router.get('/web-my-tickets', requireProToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('support_tickets')
      .select('id, category, description, status, admin_remarks, created_at, resolved_at, reopened_at')
      .eq('user_id', req.proUserId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('web-my-tickets error:', error.message);
      return res.status(500).json({ error: 'Could not load your tickets.' });
    }

    res.json({ success: true, tickets: data || [] });
  } catch (err) {
    console.error('web-my-tickets error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// --- Reopen a ticket the treasurer previously had marked solved. Only
// the treasurer who raised it can reopen it, and only from 'solved' —
// this is deliberately their own action, separate from the admin's
// Mark Solved/Pending toggle in routes/adminTickets.js. admin_remarks
// from the earlier resolution is kept (not cleared) so the history of
// what was done stays visible; reopened_at is set so the admin can see
// this ticket has been reopened, not brand new. ---
router.post('/web-reopen-ticket', requireProToken, async (req, res) => {
  const { ticketId } = req.body;
  if (!ticketId) return res.status(400).json({ error: 'ticketId is required' });

  try {
    const { data: ticket, error: fetchError } = await supabase
      .from('support_tickets')
      .select('id, user_id, status')
      .eq('id', ticketId)
      .single();

    if (fetchError || !ticket) return res.status(404).json({ error: 'Ticket not found.' });
    if (ticket.user_id !== req.proUserId) return res.status(403).json({ error: 'You can only reopen your own tickets.' });
    if (ticket.status !== 'solved') return res.status(400).json({ error: 'Only solved tickets can be reopened.' });

    const { error } = await supabase
      .from('support_tickets')
      .update({ status: 'pending', resolved_at: null, reopened_at: new Date().toISOString() })
      .eq('id', ticketId);

    if (error) {
      console.error('web-reopen-ticket error:', error.message);
      return res.status(500).json({ error: 'Could not reopen this ticket.' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('web-reopen-ticket error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

module.exports = router;

const express = require('express');
require('dotenv').config();

const supabase = require('../../lib/supabase');
const { requireProToken } = require('../../middleware/auth');

const router = express.Router();

// ===============================================================
// PRO WEB DASHBOARD — expense tracking ("Payments" under Accounting &
// Statistics). Separate concern from receipts (money collected FROM
// subscribers) — this is money the treasurer pays OUT, for their own
// record-keeping. Stored in its own dedicated normalized table from the
// start (not the JSONB blob), avoiding the dual-write complexity that's
// bitten this project twice already for other features.
// ===============================================================

const EXPENSE_CATEGORIES = [
  'Utility Bills', 'Staff Salaries', 'Maintenance', 'Cleaning', 'Office Expenses',
  'Event Expenses', 'Construction & Renovation', 'Equipment Purchases', 'Charity Payments', 'Miscellaneous'
];

// --- Add an expense ---
router.post('/web-add-expense', requireProToken, async (req, res) => {
  const category = String(req.body.category || '').trim();
  const amount = Number(req.body.amount);
  const description = String(req.body.description || '').trim();
  const expenseDate = String(req.body.expenseDate || '').trim() || new Date().toISOString().slice(0, 10);

  if (!EXPENSE_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Please choose a valid category.' });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Enter a valid amount greater than 0.' });
  }

  try {
    const expense = {
      id: `EXP-${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 10)}`,
      user_id: req.proUserId,
      category,
      amount,
      description: description || null,
      expense_date: expenseDate,
      created_at: new Date().toISOString()
    };

    const { error } = await supabase.from('expenses').insert([expense]);
    if (error) {
      console.error('web-add-expense error:', error.message);
      return res.status(500).json({ error: 'Could not save this expense.' });
    }

    res.json({ success: true, expense });
  } catch (err) {
    console.error('web-add-expense error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// --- List all expenses (newest first) ---
router.get('/web-expenses', requireProToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('expenses')
      .select('id, category, amount, description, expense_date, created_at')
      .eq('user_id', req.proUserId)
      .order('expense_date', { ascending: false });

    if (error) {
      console.error('web-expenses error:', error.message);
      return res.status(500).json({ error: 'Could not load expenses.' });
    }

    res.json({ success: true, expenses: data || [] });
  } catch (err) {
    console.error('web-expenses error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// --- Delete an expense (hard delete — this is the treasurer's own
// record-keeping, not a subscriber-facing financial obligation, so
// unlike payments received there's no audit-trail requirement here) ---
router.post('/web-delete-expense', requireProToken, async (req, res) => {
  const { expenseId } = req.body;
  if (!expenseId) return res.status(400).json({ error: 'expenseId is required' });

  try {
    const { error } = await supabase
      .from('expenses')
      .delete()
      .eq('id', expenseId)
      .eq('user_id', req.proUserId);

    if (error) {
      console.error('web-delete-expense error:', error.message);
      return res.status(500).json({ error: 'Could not delete this expense.' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('web-delete-expense error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

module.exports = router;

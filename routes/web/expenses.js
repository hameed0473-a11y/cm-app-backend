const express = require('express');
require('dotenv').config();

const supabase = require('../../lib/supabase');
const { requireProToken } = require('../../middleware/auth');
const { encrypt, decrypt } = require('../../utils/cryptoVault');
const { maskAccountNumber } = require('../../utils/gatewayValidation');

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
  // Snapshotted by name, not a foreign key to payees.id — so an expense's
  // record of who it was paid to survives even if that payee is later
  // renamed or deleted, same reasoning used elsewhere in this app for
  // "who collected this receipt" snapshots.
  const payeeName = String(req.body.payeeName || '').trim();

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
      payee_name: payeeName || null,
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
      .select('id, category, amount, description, payee_name, expense_date, created_at')
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

// ===============================================================
// PAYEES — who money gets paid out to (vendors, staff, contractors,
// etc). Kept separate from `contributors` (who money is collected
// FROM) since these are conceptually opposite directions of money
// flow. An expense links to a payee by NAME (snapshot), not a foreign
// key — see the comment on /web-add-expense above.
// ===============================================================

// --- Add a payee (starts with exactly one category — more can be
// linked afterward via /web-link-payee-category) ---
router.post('/web-add-payee', requireProToken, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const mobile = String(req.body.mobile || '').trim();
  const category = String(req.body.category || '').trim();
  const bankAccountNumber = String(req.body.bankAccountNumber || '').trim();
  const bankName = String(req.body.bankName || '').trim();
  const ifscCode = String(req.body.ifscCode || '').trim();
  const merchantId = String(req.body.merchantId || '').trim();

  if (!name) return res.status(400).json({ error: 'Payee name is required.' });
  if (!mobile) return res.status(400).json({ error: 'Mobile number is required.' });
  if (!category) return res.status(400).json({ error: 'Please choose a category.' });

  try {
    const payee = {
      id: `PAYEE-${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 10)}`,
      user_id: req.proUserId,
      name,
      mobile,
      categories: [category],
      // Encrypted at rest, same scheme already used for the platform's
      // own bank details and every gateway secret in this app — never
      // stored or returned in plain text.
      bank_account_number_enc: bankAccountNumber ? encrypt(bankAccountNumber) : null,
      bank_name: bankName || null,
      ifsc_code: ifscCode || null,
      merchant_id: merchantId || null,
      created_at: new Date().toISOString()
    };

    const { error } = await supabase.from('payees').insert([payee]);
    if (error) {
      console.error('web-add-payee error:', error.message);
      return res.status(500).json({ error: 'Could not save this payee.' });
    }

    res.json({
      success: true,
      payee: {
        id: payee.id, name, mobile, categories: payee.categories,
        bankAccountMasked: maskAccountNumber(bankAccountNumber),
        bankName: payee.bank_name, ifscCode: payee.ifsc_code, merchantId: payee.merchant_id
      }
    });
  } catch (err) {
    console.error('web-add-payee error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// --- List all payees — bank account is always masked (last 4 digits),
// the actual number is never returned to the browser. ---
router.get('/web-payees', requireProToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payees')
      .select('id, name, mobile, categories, bank_account_number_enc, bank_name, ifsc_code, merchant_id, created_at')
      .eq('user_id', req.proUserId)
      .order('name', { ascending: true });

    if (error) {
      console.error('web-payees error:', error.message);
      return res.status(500).json({ error: 'Could not load payees.' });
    }

    const payees = (data || []).map(p => ({
      id: p.id,
      name: p.name,
      mobile: p.mobile,
      categories: p.categories || [],
      bankAccountMasked: p.bank_account_number_enc ? maskAccountNumber(decrypt(p.bank_account_number_enc)) : null,
      bankName: p.bank_name,
      ifscCode: p.ifsc_code,
      merchantId: p.merchant_id
    }));

    res.json({ success: true, payees });
  } catch (err) {
    console.error('web-payees error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// --- Link an existing payee to an ADDITIONAL category — e.g. a payee
// originally added under "Staff Salaries" can also be linked to
// "Utility Bills", so they show up in the payee dropdown for either
// category when recording an expense. No-ops (still succeeds) if
// they're already linked to it. ---
router.post('/web-link-payee-category', requireProToken, async (req, res) => {
  const { payeeId } = req.body;
  const category = String(req.body.category || '').trim();
  if (!payeeId) return res.status(400).json({ error: 'payeeId is required' });
  if (!category) return res.status(400).json({ error: 'Please choose a category.' });

  try {
    const { data: payee, error: fetchError } = await supabase
      .from('payees')
      .select('categories')
      .eq('id', payeeId)
      .eq('user_id', req.proUserId)
      .single();

    if (fetchError || !payee) return res.status(404).json({ error: 'Payee not found.' });

    const categories = payee.categories || [];
    if (!categories.includes(category)) categories.push(category);

    const { error } = await supabase.from('payees').update({ categories }).eq('id', payeeId);
    if (error) {
      console.error('web-link-payee-category error:', error.message);
      return res.status(500).json({ error: 'Could not link this category.' });
    }

    res.json({ success: true, categories });
  } catch (err) {
    console.error('web-link-payee-category error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// --- Remove one of a payee's linked categories (the reverse of above —
// won't let the last remaining category be removed, since every payee
// needs at least one to ever show up in the expense form) ---
router.post('/web-unlink-payee-category', requireProToken, async (req, res) => {
  const { payeeId } = req.body;
  const category = String(req.body.category || '').trim();
  if (!payeeId) return res.status(400).json({ error: 'payeeId is required' });
  if (!category) return res.status(400).json({ error: 'category is required' });

  try {
    const { data: payee, error: fetchError } = await supabase
      .from('payees')
      .select('categories')
      .eq('id', payeeId)
      .eq('user_id', req.proUserId)
      .single();

    if (fetchError || !payee) return res.status(404).json({ error: 'Payee not found.' });

    const categories = (payee.categories || []).filter(c => c !== category);
    if (categories.length === 0) {
      return res.status(400).json({ error: 'A payee needs at least one category — link a different one before removing this.' });
    }

    const { error } = await supabase.from('payees').update({ categories }).eq('id', payeeId);
    if (error) {
      console.error('web-unlink-payee-category error:', error.message);
      return res.status(500).json({ error: 'Could not remove this category.' });
    }

    res.json({ success: true, categories });
  } catch (err) {
    console.error('web-unlink-payee-category error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// --- Delete a payee (does NOT touch any expense already logged against
// their name — those keep their snapshotted payee_name regardless) ---
router.post('/web-delete-payee', requireProToken, async (req, res) => {
  const { payeeId } = req.body;
  if (!payeeId) return res.status(400).json({ error: 'payeeId is required' });

  try {
    const { error } = await supabase
      .from('payees')
      .delete()
      .eq('id', payeeId)
      .eq('user_id', req.proUserId);

    if (error) {
      console.error('web-delete-payee error:', error.message);
      return res.status(500).json({ error: 'Could not delete this payee.' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('web-delete-payee error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

module.exports = router;

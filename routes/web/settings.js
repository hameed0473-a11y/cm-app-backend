const express = require('express');
require('dotenv').config();

const bcrypt = require('bcryptjs');
const supabase = require('../../lib/supabase');
const { requireProToken, requireProWebToken } = require('../../middleware/auth');
const { encrypt } = require('../../utils/cryptoVault');

const router = express.Router();

// ===============================================================
// PRO WEB DASHBOARD — payment gateway integrations (Razorpay/Stripe/
// PayPal), collection currency, and onboarding profile (account type/
// category/currency).
// ===============================================================

const { modeFromKey, listConnected, getUserCurrency, SUPPORTED_CURRENCIES } = require('../../lib/gateways');
const { maskKeyId, validateProvider } = require('../../utils/gatewayValidation');
const SAVE_PROVIDERS = ['razorpay', 'stripe', 'paypal'];

// --- Save / update a connected gateway ---
router.post('/web-save-integration', requireProToken, async (req, res) => {
  const provider = String(req.body.provider || 'razorpay').toLowerCase();
  const { keyId, keySecret, webhookSecret } = req.body;
  if (!SAVE_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: 'Unsupported provider.' });
  }

  const v = validateProvider(provider, keyId, keySecret, req.body.mode);
  if (v.error) return res.status(400).json({ error: v.error });

  try {
    const row = {
      user_id: req.proUserId,
      provider,
      key_id: v.keyId,
      key_secret_enc: encrypt(v.secret),
      // webhook secret optional — only overwrite when provided so re-saving keys
      // without re-entering it doesn't wipe it.
      ...(webhookSecret ? { webhook_secret_enc: encrypt(String(webhookSecret).trim()) } : {}),
      mode: v.mode,
      connected: true,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from('pro_integrations')
      .upsert(row, { onConflict: 'user_id,provider' });

    if (error) {
      console.error('web-save-integration upsert error:', error.message);
      return res.status(500).json({ error: 'Could not save your gateway details.' });
    }

    res.json({ success: true, provider, connected: true, keyIdMasked: maskKeyId(v.keyId), mode: v.mode });
  } catch (err) {
    console.error('web-save-integration error:', err?.message || err);
    res.status(500).json({ error: 'Could not save your gateway details.' });
  }
});

// --- Read status for ALL connected gateways (never returns secrets) ---
router.get('/web-integration-status', requireProToken, async (req, res) => {
  try {
    const connected = await listConnected(req.proUserId);
    const currency = await getUserCurrency(req.proUserId);
    res.json({
      success: true,
      currency,
      supportedCurrencies: SUPPORTED_CURRENCIES,
      // convenient booleans + a keyed map the frontend can render per provider
      providers: connected.map(c => ({
        provider: c.provider,
        keyIdMasked: maskKeyId(c.keyId),
        mode: c.mode,
        hasWebhookSecret: c.hasWebhookSecret,
        updatedAt: c.updatedAt
      })),
      // backward-compatible fields for the original Razorpay-only UI
      connected: connected.some(c => c.provider === 'razorpay'),
      keyIdMasked: maskKeyId((connected.find(c => c.provider === 'razorpay') || {}).keyId),
      mode: (connected.find(c => c.provider === 'razorpay') || {}).mode
    });
  } catch (err) {
    console.error('web-integration-status error:', err?.message || err);
    res.status(500).json({ error: 'Could not load integration status.' });
  }
});

// --- Set the treasurer's collection currency (used by Stripe/PayPal) ---
router.post('/web-set-currency', requireProToken, async (req, res) => {
  const currency = String(req.body.currency || '').toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    return res.status(400).json({ error: 'Unsupported currency.' });
  }
  try {
    const { error } = await supabase
      .from('pro_users')
      .update({ currency })
      .eq('id', req.proUserId);
    if (error) {
      console.error('web-set-currency error:', error.message);
      return res.status(500).json({ error: 'Could not save currency.' });
    }
    res.json({ success: true, currency });
  } catch (err) {
    console.error('web-set-currency error:', err?.message || err);
    res.status(500).json({ error: 'Could not save currency.' });
  }
});

// --- Disconnect one gateway ---
router.post('/web-remove-integration', requireProToken, async (req, res) => {
  const provider = String(req.body.provider || 'razorpay').toLowerCase();
  try {
    const { error } = await supabase
      .from('pro_integrations')
      .update({ connected: false, key_secret_enc: null, webhook_secret_enc: null, updated_at: new Date().toISOString() })
      .eq('user_id', req.proUserId)
      .eq('provider', provider);
    if (error) {
      console.error('web-remove-integration error:', error.message);
      return res.status(500).json({ error: 'Could not disconnect.' });
    }
    res.json({ success: true, provider, connected: false });
  } catch (err) {
    console.error('web-remove-integration error:', err?.message || err);
    res.status(500).json({ error: 'Could not disconnect.' });
  }
});

// --- Save onboarding profile (account type / category / currency) ---
router.post('/web-set-profile', requireProToken, async (req, res) => {
  const accountType = String(req.body.accountType || '').toLowerCase();
  const category = req.body.category != null && String(req.body.category).trim() !== ''
    ? String(req.body.category).trim() : null;
  const currency = String(req.body.currency || 'INR').toUpperCase();

  if (!['individual', 'organization'].includes(accountType)) {
    return res.status(400).json({ error: 'Please choose Individual or Organization.' });
  }
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    return res.status(400).json({ error: 'Unsupported currency.' });
  }
  try {
    const { error } = await supabase
      .from('pro_users')
      .update({ account_type: accountType, category, currency })
      .eq('id', req.proUserId);
    if (error) {
      console.error('web-set-profile error:', error.message);
      return res.status(500).json({ error: 'Could not save your profile.' });
    }
    res.json({ success: true, accountType, category, currency });
  } catch (err) {
    console.error('web-set-profile error:', err?.message || err);
    res.status(500).json({ error: 'Could not save your profile.' });
  }
});


// ===============================================================
// STAFF ACCOUNTS — owner-only. A staff account is a limited-access
// login (see requireProOrStaffToken in middleware/auth.js) that can
// only read the dashboard, add contributors, subscribe contributors
// to a goal, and collect payments — never delete a payment or a goal,
// never touch settings/billing/integrations/staff management itself.
//
// requireProWebToken (not requireProToken) on purpose: managing staff
// is an owner-web-dashboard action only, and it also automatically
// rejects any pro_staff token, so a staff account can never manage
// other staff or itself.
// ===============================================================

router.post('/web-add-staff', requireProWebToken, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const mobile = String(req.body.mobile || '').trim();
  const password = req.body.password || '';

  if (!name || !mobile || !password) {
    return res.status(400).json({ error: 'name, mobile, and password are all required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    // Mobile numbers are unique across owner and staff logins, since both
    // share the same /web-login form — check both tables before inserting.
    const { data: existingOwner } = await supabase.from('users').select('id').eq('mobile', mobile).single();
    if (existingOwner) {
      return res.status(400).json({ error: 'This mobile number is already registered to an account.' });
    }
    const { data: existingStaff } = await supabase.from('staff_users').select('id').eq('mobile', mobile).single();
    if (existingStaff) {
      return res.status(400).json({ error: 'This mobile number is already registered to a staff account.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const { data: newStaff, error } = await supabase
      .from('staff_users')
      .insert([{ owner_user_id: req.proUserId, name, mobile, password: hashedPassword, status: 'active' }])
      .select('id, name, mobile, status, created_at')
      .single();

    if (error) {
      console.error('web-add-staff error:', error.message);
      return res.status(500).json({ error: 'Could not create the staff account.' });
    }

    res.json({ success: true, staff: newStaff });
  } catch (err) {
    console.error('web-add-staff error:', err?.message || err);
    res.status(500).json({ error: 'Could not create the staff account.' });
  }
});

router.get('/web-list-staff', requireProWebToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('staff_users')
      .select('id, name, mobile, status, created_at, last_login_at')
      .eq('owner_user_id', req.proUserId)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: 'Could not load staff accounts.' });
    res.json({ success: true, staff: data || [] });
  } catch (err) {
    console.error('web-list-staff error:', err?.message || err);
    res.status(500).json({ error: 'Could not load staff accounts.' });
  }
});

router.post('/web-toggle-staff', requireProWebToken, async (req, res) => {
  const { staffId, status } = req.body;
  if (!staffId || !['active', 'disabled'].includes(status)) {
    return res.status(400).json({ error: 'staffId and a valid status are required.' });
  }
  try {
    const { data, error } = await supabase
      .from('staff_users')
      .update({ status })
      .eq('id', staffId)
      .eq('owner_user_id', req.proUserId)
      .select('id')
      .single();

    if (error || !data) return res.status(404).json({ error: 'Staff account not found.' });
    res.json({ success: true, staffId, status });
  } catch (err) {
    console.error('web-toggle-staff error:', err?.message || err);
    res.status(500).json({ error: 'Could not update the staff account.' });
  }
});

router.post('/web-remove-staff', requireProWebToken, async (req, res) => {
  const { staffId } = req.body;
  if (!staffId) return res.status(400).json({ error: 'staffId is required.' });
  try {
    const { error } = await supabase
      .from('staff_users')
      .delete()
      .eq('id', staffId)
      .eq('owner_user_id', req.proUserId);

    if (error) return res.status(500).json({ error: 'Could not remove the staff account.' });
    res.json({ success: true });
  } catch (err) {
    console.error('web-remove-staff error:', err?.message || err);
    res.status(500).json({ error: 'Could not remove the staff account.' });
  }
});

module.exports = router;

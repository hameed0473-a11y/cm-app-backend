const express = require('express');
require('dotenv').config();

const supabase = require('../../lib/supabase');
const { requireProToken } = require('../../middleware/auth');
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


module.exports = router;

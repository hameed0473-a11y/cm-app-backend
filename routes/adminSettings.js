const express = require('express');
require('dotenv').config();

const supabase = require('../lib/supabase');
const { requireAdmin } = require('../middleware/auth');
const { encrypt, decrypt } = require('../utils/cryptoVault');
const { maskKeyId, validateProvider, maskAccountNumber } = require('../utils/gatewayValidation');
const { getCurrentRates } = require('../lib/pricing');

const router = express.Router();

// ===============================================================
// ADMIN — PLATFORM PAYMENT SETTINGS
//
// These are YOUR OWN business credentials (the platform's), completely
// separate from the per-treasurer gateway keys in pro_integrations —
// those are what a treasurer connects to collect money FROM their own
// contributors; this is what the platform itself would eventually use
// to charge treasurers for their subscription (Part B — not wired up
// to any real charging yet, same as the rest of the billing work so
// far. This just gives you somewhere safe to store the credentials
// ahead of that).
//
// Mirrors the exact same encrypt-before-storing, never-return-secrets
// pattern already used for pro_integrations — just at the platform
// level (one row per provider, no user_id) instead of per-treasurer.
// ===============================================================

const SAVE_PROVIDERS = ['razorpay', 'stripe', 'paypal'];

// --- Read status for everything (gateways + bank details) — never returns secrets ---
router.get('/admin-platform-settings', requireAdmin, async (req, res) => {
  try {
    const { data: integrations, error: intError } = await supabase
      .from('platform_integrations')
      .select('provider, key_id, webhook_secret_enc, mode, connected, updated_at');

    if (intError) {
      console.error('admin-platform-settings integrations error:', intError.message);
      return res.status(500).json({ error: 'Could not load gateway settings.' });
    }

    const byProvider = {};
    SAVE_PROVIDERS.forEach(p => {
      const row = (integrations || []).find(r => r.provider === p);
      byProvider[p] = {
        connected: !!row?.connected,
        keyIdMasked: maskKeyId(row?.key_id),
        mode: row?.mode || null,
        hasWebhookSecret: !!row?.webhook_secret_enc,
        updatedAt: row?.updated_at || null
      };
    });

    const { data: bank, error: bankError } = await supabase
      .from('platform_bank_details')
      .select('account_holder, account_number_enc, ifsc_or_routing, bank_name, updated_at')
      .eq('id', 1)
      .maybeSingle();

    if (bankError) {
      console.error('admin-platform-settings bank error:', bankError.message);
      return res.status(500).json({ error: 'Could not load bank details.' });
    }

    const rates = await getCurrentRates();

    const { data: pricingRow } = await supabase
      .from('platform_pricing')
      .select('receipts_per_subscriber')
      .eq('id', 1)
      .maybeSingle();

    res.json({
      success: true,
      integrations: byProvider,
      pricing: {
        inrRate: rates.INR,
        intlRate: rates.USD,
        // Default cap applied to every treasurer's pro_users row when this
        // is saved below — see the comment on /admin-save-pricing. Falls
        // back to the same 100 lib/pricing.js's getMaxReceipts() uses when
        // a treasurer's own column is unset.
        receiptsPerSubscriber: pricingRow?.receipts_per_subscriber ?? 100
      },
      bank: {
        accountHolder: bank?.account_holder || '',
        accountNumberMasked: bank?.account_number_enc ? maskAccountNumber(decrypt(bank.account_number_enc)) : '',
        hasAccountNumber: !!bank?.account_number_enc,
        ifscOrRouting: bank?.ifsc_or_routing || '',
        bankName: bank?.bank_name || '',
        updatedAt: bank?.updated_at || null
      }
    });
  } catch (err) {
    console.error('admin-platform-settings error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// --- Save / update one platform gateway ---
router.post('/admin-save-integration', requireAdmin, async (req, res) => {
  const provider = String(req.body.provider || '').toLowerCase();
  const { keyId, keySecret, webhookSecret } = req.body;
  if (!SAVE_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: 'Unsupported provider.' });
  }

  const v = validateProvider(provider, keyId, keySecret, req.body.mode);
  if (v.error) return res.status(400).json({ error: v.error });

  try {
    const row = {
      provider,
      key_id: v.keyId,
      key_secret_enc: encrypt(v.secret),
      // Optional — only overwrite when provided so re-saving keys without
      // re-entering the webhook secret doesn't wipe it.
      ...(webhookSecret ? { webhook_secret_enc: encrypt(String(webhookSecret).trim()) } : {}),
      mode: v.mode,
      connected: true,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from('platform_integrations')
      .upsert(row, { onConflict: 'provider' });

    if (error) {
      console.error('admin-save-integration upsert error:', error.message);
      return res.status(500).json({ error: 'Could not save these gateway details.' });
    }

    res.json({ success: true, provider, connected: true, keyIdMasked: maskKeyId(v.keyId), mode: v.mode });
  } catch (err) {
    console.error('admin-save-integration error:', err?.message || err);
    res.status(500).json({ error: 'Could not save these gateway details.' });
  }
});

// --- Disconnect one platform gateway ---
router.post('/admin-remove-integration', requireAdmin, async (req, res) => {
  const provider = String(req.body.provider || '').toLowerCase();
  if (!SAVE_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: 'Unsupported provider.' });
  }
  try {
    const { error } = await supabase
      .from('platform_integrations')
      .update({ connected: false, key_secret_enc: null, webhook_secret_enc: null, updated_at: new Date().toISOString() })
      .eq('provider', provider);
    if (error) {
      console.error('admin-remove-integration error:', error.message);
      return res.status(500).json({ error: 'Could not disconnect.' });
    }
    res.json({ success: true, provider, connected: false });
  } catch (err) {
    console.error('admin-remove-integration error:', err?.message || err);
    res.status(500).json({ error: 'Could not disconnect.' });
  }
});

// --- Save platform bank/settlement details ---
router.post('/admin-save-bank-details', requireAdmin, async (req, res) => {
  const accountHolder = String(req.body.accountHolder || '').trim();
  const accountNumber = String(req.body.accountNumber || '').trim();
  const ifscOrRouting = String(req.body.ifscOrRouting || '').trim();
  const bankName = String(req.body.bankName || '').trim();

  if (!accountHolder || !accountNumber || !ifscOrRouting || !bankName) {
    return res.status(400).json({ error: 'All bank detail fields are required.' });
  }

  try {
    const row = {
      id: 1,
      account_holder: accountHolder,
      account_number_enc: encrypt(accountNumber),
      ifsc_or_routing: ifscOrRouting,
      bank_name: bankName,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from('platform_bank_details')
      .upsert(row, { onConflict: 'id' });

    if (error) {
      console.error('admin-save-bank-details error:', error.message);
      return res.status(500).json({ error: 'Could not save bank details.' });
    }

    res.json({
      success: true,
      accountHolder,
      accountNumberMasked: maskAccountNumber(accountNumber),
      ifscOrRouting,
      bankName
    });
  } catch (err) {
    console.error('admin-save-bank-details error:', err?.message || err);
    res.status(500).json({ error: 'Could not save bank details.' });
  }
});

// --- Save the per-subscriber pricing rates (INR + international), and
// optionally the default receipts-per-subscriber cap ---
// Rate changes take effect immediately for every NEW pricing calculation
// (the trial pop-up, the renewal/upgrade screens, the trial-expired
// screen) — no redeploy needed. Does NOT retroactively change what
// anyone already paid or was already billed for; it only affects
// amounts computed going forward.
//
// receiptsPerSubscriber is optional and, unlike the rates, is NOT purely
// forward-looking: lib/pricing.js's getMaxReceipts() reads it straight off
// each treasurer's own pro_users.receipts_per_subscriber column (falling
// back to 100 only when that column is NULL), so saving a new value here
// also bulk-updates every existing treasurer's column — same behavior
// this previously lived under on the Aftech website's admin panel, now
// consolidated into this one endpoint. Omit the field to change only the
// rates and leave every treasurer's current cap untouched.
router.post('/admin-save-pricing', requireAdmin, async (req, res) => {
  const inrRate = Number(req.body.inrRate);
  const intlRate = Number(req.body.intlRate);
  const receiptsPerSubscriberProvided = req.body.receiptsPerSubscriber !== undefined && req.body.receiptsPerSubscriber !== null && req.body.receiptsPerSubscriber !== '';
  const receiptsPerSubscriber = receiptsPerSubscriberProvided ? Number(req.body.receiptsPerSubscriber) : null;

  if (!Number.isFinite(inrRate) || inrRate <= 0) {
    return res.status(400).json({ error: 'Enter a valid India (INR) rate greater than 0.' });
  }
  if (!Number.isFinite(intlRate) || intlRate <= 0) {
    return res.status(400).json({ error: 'Enter a valid international rate greater than 0.' });
  }
  if (receiptsPerSubscriberProvided && (!Number.isFinite(receiptsPerSubscriber) || receiptsPerSubscriber <= 0)) {
    return res.status(400).json({ error: 'Enter a valid receipts-per-subscriber cap greater than 0.' });
  }

  try {
    const pricingRow = { id: 1, inr_rate: inrRate, intl_rate: intlRate, updated_at: new Date().toISOString() };
    if (receiptsPerSubscriberProvided) pricingRow.receipts_per_subscriber = receiptsPerSubscriber;

    const { error } = await supabase
      .from('platform_pricing')
      .upsert(pricingRow, { onConflict: 'id' });

    if (error) {
      console.error('admin-save-pricing error:', error.message);
      return res.status(500).json({ error: 'Could not save pricing.' });
    }

    if (receiptsPerSubscriberProvided) {
      const { error: bulkError } = await supabase
        .from('pro_users')
        .update({ receipts_per_subscriber: receiptsPerSubscriber })
        .not('id', 'is', null);
      if (bulkError) {
        // Rates already saved successfully — report the partial failure
        // rather than a blanket error, same as the panel this replaces did.
        console.error('admin-save-pricing bulk receipts-cap update error:', bulkError.message);
        return res.json({ success: true, inrRate, intlRate, receiptsPerSubscriber, capUpdateFailed: true });
      }
    }

    res.json({ success: true, inrRate, intlRate, ...(receiptsPerSubscriberProvided ? { receiptsPerSubscriber } : {}) });
  } catch (err) {
    console.error('admin-save-pricing error:', err?.message || err);
    res.status(500).json({ error: 'Could not save pricing.' });
  }
});

module.exports = router;

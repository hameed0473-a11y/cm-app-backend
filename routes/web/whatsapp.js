const express = require('express');
require('dotenv').config();

const supabase = require('../../lib/supabase');
const { requireProToken } = require('../../middleware/auth');
const { encrypt, decrypt } = require('../../utils/cryptoVault');
const { maskKeyId } = require('../../utils/gatewayValidation');

const router = express.Router();

// ===============================================================
// PRO WEB DASHBOARD — WhatsApp Business API integration (Meta Cloud
// API). This is BYO: the treasurer must already have their own Meta
// WhatsApp Business API account and an APPROVED message template —
// getting that set up (business verification + template review) is
// entirely on them, not something this handles. This only stores their
// credentials (encrypted, same as the payment gateway keys) and sends
// using their own account once connected.
//
// Template contract: whatever template the treasurer has approved MUST
// have exactly 3 body variables, in this order:
//   {{1}} = contributor name
//   {{2}} = amount due (already formatted with currency symbol)
//   {{3}} = goal/pledge name
// This isn't a Meta requirement — it's what this integration knows how
// to fill in. A differently-shaped template won't map correctly.
// ===============================================================

// A bare 10-digit number is assumed Indian (91) — same convention
// already used by utils/reminders.ts for the wa.me links.
function toWhatsAppNumber(mobile) {
  const digits = String(mobile || '').replace(/\D/g, '');
  return digits.length === 10 ? `91${digits}` : digits;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Space out consecutive sends and back off on Meta's rate-limit response
// (HTTP 429 / error subcode 131056) instead of bursting the whole list
// through in a tight loop, which is what actually trips the throttle.
const BULK_SEND_DELAY_MS = 300;
const RATE_LIMIT_BACKOFFS_MS = [1000, 2000];

function isRateLimited(status, json) {
  if (status === 429) return true;
  const code = json?.error?.code;
  const subcode = json?.error?.error_subcode;
  return code === 130429 || code === 4 || subcode === 131056;
}

async function sendWhatsAppTemplate(integration, accessToken, toNumber, r) {
  const resp = await fetch(`https://graph.facebook.com/v19.0/${integration.phone_number_id}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'template',
      template: {
        name: integration.template_name,
        language: { code: integration.template_language || 'en_US' },
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: String(r.name || '') },
            { type: 'text', text: String(r.amount || '') },
            { type: 'text', text: String(r.goalName || '') }
          ]
        }]
      }
    })
  });
  const json = await resp.json().catch(() => ({}));
  return { resp, json };
}

// --- Save / update WhatsApp Business API credentials ---
router.post('/web-save-whatsapp-integration', requireProToken, async (req, res) => {
  const phoneNumberId = String(req.body.phoneNumberId || '').trim();
  const accessToken = String(req.body.accessToken || '').trim();
  const templateName = String(req.body.templateName || '').trim();
  const templateLanguage = String(req.body.templateLanguage || 'en_US').trim();

  if (!phoneNumberId || !accessToken || !templateName) {
    return res.status(400).json({ error: 'Phone Number ID, Access Token, and Template Name are all required.' });
  }

  try {
    const row = {
      user_id: req.proUserId,
      phone_number_id: phoneNumberId,
      access_token_enc: encrypt(accessToken),
      template_name: templateName,
      template_language: templateLanguage || 'en_US',
      connected: true,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from('whatsapp_integrations')
      .upsert(row, { onConflict: 'user_id' });

    if (error) {
      console.error('web-save-whatsapp-integration error:', error.message);
      return res.status(500).json({ error: 'Could not save these details.' });
    }

    res.json({
      success: true,
      connected: true,
      phoneNumberIdMasked: maskKeyId(phoneNumberId),
      templateName,
      templateLanguage
    });
  } catch (err) {
    console.error('web-save-whatsapp-integration error:', err?.message || err);
    res.status(500).json({ error: 'Could not save these details.' });
  }
});

// --- Read status (never returns the access token) ---
router.get('/web-whatsapp-integration-status', requireProToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('whatsapp_integrations')
      .select('phone_number_id, template_name, template_language, connected, updated_at')
      .eq('user_id', req.proUserId)
      .single();

    if (error || !data || !data.connected) {
      return res.json({ success: true, connected: false });
    }

    res.json({
      success: true,
      connected: true,
      phoneNumberIdMasked: maskKeyId(data.phone_number_id),
      templateName: data.template_name,
      templateLanguage: data.template_language,
      updatedAt: data.updated_at
    });
  } catch (err) {
    console.error('web-whatsapp-integration-status error:', err?.message || err);
    res.status(500).json({ error: 'Could not load WhatsApp integration status.' });
  }
});

// --- Disconnect ---
router.post('/web-remove-whatsapp-integration', requireProToken, async (req, res) => {
  try {
    const { error } = await supabase
      .from('whatsapp_integrations')
      .update({ connected: false, access_token_enc: null, updated_at: new Date().toISOString() })
      .eq('user_id', req.proUserId);

    if (error) {
      console.error('web-remove-whatsapp-integration error:', error.message);
      return res.status(500).json({ error: 'Could not disconnect.' });
    }
    res.json({ success: true, connected: false });
  } catch (err) {
    console.error('web-remove-whatsapp-integration error:', err?.message || err);
    res.status(500).json({ error: 'Could not disconnect.' });
  }
});

// --- Send bulk reminders via the treasurer's own WhatsApp Business API ---
// This is what makes it a TRUE one-click send — the loop happens here,
// server-side, using their Meta credentials, not in the browser.
router.post('/web-send-whatsapp-bulk', requireProToken, async (req, res) => {
  const recipients = Array.isArray(req.body.recipients) ? req.body.recipients : [];
  if (!recipients.length) return res.status(400).json({ error: 'recipients (a non-empty array) is required' });

  try {
    const { data: integration, error } = await supabase
      .from('whatsapp_integrations')
      .select('phone_number_id, access_token_enc, template_name, template_language, connected')
      .eq('user_id', req.proUserId)
      .single();

    if (error || !integration || !integration.connected) {
      return res.status(400).json({ error: 'WhatsApp Business API is not connected. Set it up in Settings first.' });
    }

    const accessToken = decrypt(integration.access_token_enc);
    if (!accessToken) {
      return res.status(500).json({ error: 'Could not read your saved WhatsApp credentials. Please reconnect in Settings.' });
    }

    const results = [];
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      const toNumber = toWhatsAppNumber(r.mobile);
      if (!toNumber) {
        results.push({ mobile: r.mobile, success: false, error: 'Invalid mobile number' });
        continue;
      }

      try {
        let resp, json;
        let attempt = 0;
        while (true) {
          ({ resp, json } = await sendWhatsAppTemplate(integration, accessToken, toNumber, r));
          if (resp.ok || !isRateLimited(resp.status, json) || attempt >= RATE_LIMIT_BACKOFFS_MS.length) break;
          await sleep(RATE_LIMIT_BACKOFFS_MS[attempt]);
          attempt++;
        }
        if (!resp.ok) {
          results.push({ mobile: r.mobile, success: false, error: json?.error?.message || `HTTP ${resp.status}` });
        } else {
          results.push({ mobile: r.mobile, success: true });
        }
      } catch (sendErr) {
        results.push({ mobile: r.mobile, success: false, error: sendErr?.message || 'Send failed' });
      }

      if (i < recipients.length - 1) await sleep(BULK_SEND_DELAY_MS);
    }

    const sentCount = results.filter(r => r.success).length;
    res.json({ success: true, sentCount, totalCount: recipients.length, results });
  } catch (err) {
    console.error('web-send-whatsapp-bulk error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

module.exports = router;

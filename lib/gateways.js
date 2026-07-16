const Razorpay = require('razorpay');
const Stripe = require('stripe');
require('dotenv').config();

const supabase = require('./supabase');
const { decrypt } = require('../utils/cryptoVault');

// ===================================================================
// Provider-agnostic payment gateway layer.
//
// A treasurer can connect more than one gateway (Razorpay for Indian
// payers, Stripe/PayPal for overseas members). Each is one row in
// pro_integrations keyed by (user_id, provider). This module hides the
// per-provider API differences behind a small common interface:
//
//   listConnected(userId)                       -> [{provider, ...}]
//   resolveProvider(userId, requested)          -> provider string | null
//   createContributionLink(userId, provider, o) -> {provider, id, url}
//   fetchLinkDetails(userId, provider, id)      -> {status, amountPaise}
//   getWebhookSecret(userId, provider)          -> string | null
//
// PayPal is intentionally not implemented yet (next phase); its cases
// below throw a clear "not supported yet" so nothing silently misfires.
// ===================================================================

const SUPPORTED = ['razorpay', 'stripe', 'paypal'];

// Currencies a treasurer can collect in (all 2-decimal, so amount*100 = minor
// units holds). Kept deliberately to major, widely-supported ones; zero-decimal
// currencies (JPY, KRW, …) are excluded for now because they'd need different
// amount math. Razorpay always uses INR regardless of this list.
const SUPPORTED_CURRENCIES = ['INR', 'USD', 'GBP', 'EUR', 'AUD', 'CAD', 'SGD', 'AED', 'NZD', 'CHF', 'ZAR', 'MYR', 'SAR', 'HKD'];

// The treasurer's chosen collection currency (defaults to INR).
async function getUserCurrency(userId) {
  if (!userId) return 'INR';
  const { data } = await supabase.from('pro_users').select('currency').eq('id', userId).single();
  const c = (data?.currency || 'INR').toUpperCase();
  return SUPPORTED_CURRENCIES.includes(c) ? c : 'INR';
}

function modeFromKey(provider, keyId) {
  const k = String(keyId || '');
  if (provider === 'razorpay') {
    if (k.startsWith('rzp_live_')) return 'live';
    if (k.startsWith('rzp_test_')) return 'test';
  }
  if (provider === 'stripe') {
    if (k.includes('_live_')) return 'live';
    if (k.includes('_test_')) return 'test';
  }
  return 'unknown';
}

async function _row(userId, provider) {
  const { data, error } = await supabase
    .from('pro_integrations')
    .select('provider, key_id, key_secret_enc, webhook_secret_enc, connected, mode')
    .eq('user_id', userId)
    .eq('provider', provider)
    .single();
  if (error || !data || !data.connected) return null;
  return data;
}

// All connected gateways for a user (no secrets).
async function listConnected(userId) {
  if (!userId) return [];
  const { data, error } = await supabase
    .from('pro_integrations')
    .select('provider, key_id, mode, connected, webhook_secret_enc, updated_at')
    .eq('user_id', userId)
    .eq('connected', true);
  if (error || !data) return [];
  return data.map(r => ({
    provider: r.provider,
    keyId: r.key_id,
    mode: r.mode || modeFromKey(r.provider, r.key_id),
    hasWebhookSecret: !!r.webhook_secret_enc,
    updatedAt: r.updated_at
  }));
}

// Which provider to actually use for a link. If the caller named one and it's
// connected, use it; otherwise fall back to the first connected gateway,
// preferring Razorpay (the domestic default).
async function resolveProvider(userId, requested) {
  const connected = await listConnected(userId);
  if (!connected.length) return null;
  if (requested && connected.some(c => c.provider === requested)) return requested;
  const pref = connected.find(c => c.provider === 'razorpay') || connected[0];
  return pref.provider;
}

async function getWebhookSecret(userId, provider) {
  const row = await _row(userId, provider);
  if (!row || !row.webhook_secret_enc) return null;
  return decrypt(row.webhook_secret_enc);
}

// Build the provider SDK client from the user's stored (decrypted) secret.
async function _client(userId, provider) {
  const row = await _row(userId, provider);
  if (!row || !row.key_secret_enc) return null;
  const secret = decrypt(row.key_secret_enc);
  if (!secret) return null;
  if (provider === 'razorpay') {
    return new Razorpay({ key_id: row.key_id, key_secret: secret });
  }
  if (provider === 'stripe') {
    return Stripe(secret); // row.key_id holds the publishable key (not needed server-side)
  }
  return null;
}

// ---- PayPal (REST, no SDK) ----------------------------------------
// PayPal uses OAuth2 + Orders v2. Creds live in the same pro_integrations
// row (provider='paypal'): key_id = client_id, key_secret_enc = client
// secret, webhook_secret_enc = webhook id, mode = 'sandbox' | 'live'.
function paypalBase(mode) {
  return mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

async function _paypalCreds(userId) {
  const row = await _row(userId, 'paypal');
  if (!row || !row.key_id || !row.key_secret_enc) return null;
  const secret = decrypt(row.key_secret_enc);
  if (!secret) return null;
  return {
    clientId: row.key_id,
    secret,
    webhookId: row.webhook_secret_enc ? decrypt(row.webhook_secret_enc) : null,
    mode: row.mode === 'live' ? 'live' : 'sandbox'
  };
}

async function _paypalToken(creds) {
  const res = await fetch(`${paypalBase(creds.mode)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${creds.clientId}:${creds.secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error(`paypal_auth_failed_${res.status}`);
  const json = await res.json();
  return json.access_token;
}

// Server-side capture an approved order (called from the webhook). Returns the
// captured major-unit amount as a number, or null.
async function capturePaypalOrder(userId, orderId) {
  const creds = await _paypalCreds(userId);
  if (!creds) return null;
  const token = await _paypalToken(creds);
  const res = await fetch(`${paypalBase(creds.mode)}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && json?.name !== 'ORDER_ALREADY_CAPTURED') {
    console.error('PayPal capture failed:', res.status, json?.name);
    return null;
  }
  const cap = json?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value;
  return cap != null ? parseFloat(cap) : null;
}

// Verify a PayPal webhook via PayPal's verify-webhook-signature API using the
// treasurer's stored webhook id. Returns true only on SUCCESS.
async function verifyPaypalWebhook(userId, headers, eventBody) {
  const creds = await _paypalCreds(userId);
  if (!creds || !creds.webhookId) return false;
  const token = await _paypalToken(creds);
  const res = await fetch(`${paypalBase(creds.mode)}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transmission_id: headers['paypal-transmission-id'],
      transmission_time: headers['paypal-transmission-time'],
      cert_url: headers['paypal-cert-url'],
      auth_algo: headers['paypal-auth-algo'],
      transmission_sig: headers['paypal-transmission-sig'],
      webhook_id: creds.webhookId,
      webhook_event: eventBody
    })
  });
  if (!res.ok) return false;
  const json = await res.json().catch(() => ({}));
  return json.verification_status === 'SUCCESS';
}

// Create a payment link/session for one subscriber's due.
// opts: { amountPaise, description, notes }
// Currency is resolved automatically: Razorpay is always INR; Stripe uses the
// treasurer's chosen collection currency.
// Returns { provider, id, url } — url is what the subscriber opens to pay.
async function createContributionLink(userId, provider, opts) {
  const { amountPaise, description, notes } = opts;

  if (provider === 'paypal') {
    const creds = await _paypalCreds(userId);
    if (!creds) throw new Error('gateway_not_connected');
    const currency = await getUserCurrency(userId);
    const token = await _paypalToken(creds);
    const res = await fetch(`${paypalBase(creds.mode)}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          description: (description || 'Contribution').slice(0, 127),
          amount: { currency_code: currency, value: (amountPaise / 100).toFixed(2) }
        }],
        application_context: {
          brand_name: 'Contributions Manager',
          user_action: 'PAY_NOW',
          return_url: 'https://aftechs.in/pay-success',
          cancel_url: 'https://aftechs.in/pay-cancelled'
        }
      })
    });
    const order = await res.json().catch(() => ({}));
    if (!res.ok || !order.id) throw new Error(`paypal_order_failed_${res.status}`);
    const approve = (order.links || []).find(l => l.rel === 'approve' || l.rel === 'payer-action');
    return { provider, id: order.id, url: approve?.href };
  }

  const client = await _client(userId, provider);
  if (!client) throw new Error('gateway_not_connected');

  if (provider === 'razorpay') {
    const link = await client.paymentLink.create({
      amount: amountPaise,
      currency: 'INR', // Razorpay only settles INR
      accept_partial: false,
      description,
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes
    });
    return { provider, id: link.id, url: link.short_url };
  }

  if (provider === 'stripe') {
    const currency = await getUserCurrency(userId); // treasurer's chosen currency
    const session = await client.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: currency.toLowerCase(),
          product_data: { name: description || 'Contribution' },
          unit_amount: amountPaise
        },
        quantity: 1
      }],
      // Stripe metadata values must be strings.
      metadata: Object.fromEntries(Object.entries(notes || {}).map(([k, v]) => [k, String(v ?? '')])),
      success_url: 'https://aftechs.in/pay-success',
      cancel_url: 'https://aftechs.in/pay-cancelled'
    });
    return { provider, id: session.id, url: session.url };
  }

  throw new Error('provider_not_supported');
}

// Fetch link/session status for the public landing page.
async function fetchLinkDetails(userId, provider, linkId) {
  if (provider === 'paypal') {
    const creds = await _paypalCreds(userId);
    if (!creds) return null;
    const token = await _paypalToken(creds);
    const res = await fetch(`${paypalBase(creds.mode)}/v2/checkout/orders/${linkId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const order = await res.json().catch(() => ({}));
    const pu = order.purchase_units?.[0];
    const approve = (order.links || []).find(l => l.rel === 'approve' || l.rel === 'payer-action');
    return {
      provider,
      notes: {},
      amountPaise: Math.round(parseFloat(pu?.amount?.value || '0') * 100),
      status: order.status === 'COMPLETED' ? 'paid' : (order.status || 'created').toLowerCase(),
      url: approve?.href
    };
  }

  const client = await _client(userId, provider);
  if (!client) return null;

  if (provider === 'razorpay') {
    const link = await client.paymentLink.fetch(linkId);
    return {
      provider,
      notes: link.notes || {},
      amountPaise: link.amount,
      status: link.status,          // created | paid | cancelled | expired
      url: link.short_url
    };
  }
  if (provider === 'stripe') {
    const s = await client.checkout.sessions.retrieve(linkId);
    return {
      provider,
      notes: s.metadata || {},
      amountPaise: s.amount_total,
      status: s.payment_status === 'paid' ? 'paid' : (s.status || 'created'),
      url: s.url
    };
  }
  return null;
}

module.exports = {
  SUPPORTED,
  SUPPORTED_CURRENCIES,
  modeFromKey,
  listConnected,
  resolveProvider,
  getWebhookSecret,
  getUserCurrency,
  createContributionLink,
  fetchLinkDetails,
  capturePaypalOrder,
  verifyPaypalWebhook
};

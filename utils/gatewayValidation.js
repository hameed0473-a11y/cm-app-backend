const { modeFromKey } = require('../lib/gateways');

// ---------------------------------------------------------------
// Shared gateway-key validation and masking — used by both the
// per-treasurer integration endpoints (routes/web/settings.js) and the
// platform-admin integration endpoints (routes/adminSettings.js), so
// the same key-format rules and masking apply in both places instead
// of two copies drifting apart.
// ---------------------------------------------------------------

function maskKeyId(keyId) {
  if (!keyId || keyId.length < 8) return keyId || '';
  return `${keyId.slice(0, 8)}••••${keyId.slice(-4)}`;
}

// Per-provider validation of what was pasted in. `mode` is only used by
// PayPal (its keys don't encode sandbox/live). Returns { error } or
// { keyId, secret, mode }.
function validateProvider(provider, keyId, keySecret, mode) {
  const id = String(keyId || '').trim();
  const secret = String(keySecret || '').trim();
  if (provider === 'razorpay') {
    if (!id || !secret) return { error: 'Enter both the Razorpay Key ID and Key Secret.' };
    if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(id)) {
      return { error: 'That doesn\'t look like a Razorpay Key ID — it should start with rzp_test_ or rzp_live_.' };
    }
    return { keyId: id, secret, mode: modeFromKey('razorpay', id) };
  }
  if (provider === 'stripe') {
    if (!secret) return { error: 'Enter your Stripe Secret key (starts with sk_test_ or sk_live_).' };
    if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(secret)) {
      return { error: 'That doesn\'t look like a Stripe Secret key — it should start with sk_test_ or sk_live_.' };
    }
    return { keyId: id || null, secret, mode: modeFromKey('stripe', secret) };
  }
  if (provider === 'paypal') {
    if (!id || !secret) return { error: 'Enter both your PayPal Client ID and Secret.' };
    const m = mode === 'live' ? 'live' : 'sandbox';
    return { keyId: id, secret, mode: m };
  }
  return { error: 'Unsupported provider.' };
}

// Shows only the last 4 characters/digits — used for bank account
// numbers in the admin platform-settings view, same spirit as
// maskKeyId above but without needing the first-8-chars prefix (a bank
// account number has no meaningful "prefix" the way rzp_live_ does).
function maskAccountNumber(accountNumber) {
  const s = String(accountNumber || '');
  if (s.length <= 4) return s ? '••••' : '';
  return `••••${s.slice(-4)}`;
}

module.exports = { maskKeyId, validateProvider, maskAccountNumber };

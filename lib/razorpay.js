const Razorpay = require('razorpay');
require('dotenv').config();

const supabase = require('./supabase');
const { decrypt } = require('../utils/cryptoVault');

// ---------------------------------------------------------------
// Platform Razorpay client — used ONLY for AFTech's own subscription
// payments (Lite/Pro plan purchases). Contribution/pledge payments a
// treasurer collects from subscribers must go through that treasurer's
// OWN gateway instead (see getRazorpayForUser below), so the money
// lands in their account, not the platform's.
// ---------------------------------------------------------------
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Fetches a Pro user's stored integration row (raw). Internal helper.
async function _getIntegration(userId) {
  if (!userId) return null;
  const { data, error } = await supabase
    .from('pro_integrations')
    .select('key_id, key_secret_enc, webhook_secret_enc, connected, mode')
    .eq('user_id', userId)
    .single();
  if (error || !data) return null;
  return data;
}

// Returns a Razorpay client built from the Pro user's OWN credentials,
// or null if they haven't connected a gateway yet. Callers should treat
// null as "ask the user to connect their gateway in Integrations".
async function getRazorpayForUser(userId) {
  const row = await _getIntegration(userId);
  if (!row || !row.connected || !row.key_id || !row.key_secret_enc) return null;
  const secret = decrypt(row.key_secret_enc);
  if (!secret) return null;
  try {
    return new Razorpay({ key_id: row.key_id, key_secret: secret });
  } catch (e) {
    console.error('getRazorpayForUser: failed to build client for', userId, e?.message || e);
    return null;
  }
}

// Returns the Pro user's webhook secret (decrypted) or null. Used to verify
// webhook signatures for that specific user's Razorpay account.
async function getWebhookSecretForUser(userId) {
  const row = await _getIntegration(userId);
  if (!row || !row.connected || !row.webhook_secret_enc) return null;
  return decrypt(row.webhook_secret_enc);
}

module.exports = razorpay;
module.exports.platform = razorpay;
module.exports.getRazorpayForUser = getRazorpayForUser;
module.exports.getWebhookSecretForUser = getWebhookSecretForUser;

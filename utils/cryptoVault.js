const crypto = require('crypto');
require('dotenv').config();

// ===================================================================
// Small symmetric vault for secrets we must store but never expose —
// specifically each Pro user's Razorpay key_secret and webhook_secret.
//
// Values are encrypted with AES-256-GCM before they touch the database,
// so even someone with read access to Supabase can't read the raw keys.
//
// Key source (in order of preference):
//   1. INTEGRATION_ENC_KEY  (set this in Render — a long random string)
//   2. JWT_SECRET           (already present; used as a fallback so the
//                            feature works even before you add #1)
// Either way we hash it to a fixed 32-byte key with SHA-256.
// ===================================================================

function getKey() {
  const material = process.env.INTEGRATION_ENC_KEY || process.env.JWT_SECRET;
  if (!material) {
    throw new Error('No encryption key available — set INTEGRATION_ENC_KEY (or JWT_SECRET) in the environment.');
  }
  return crypto.createHash('sha256').update(String(material)).digest(); // 32 bytes
}

// Returns a compact "iv:tag:ciphertext" base64 bundle, or null for empty input.
function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return null;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

// Reverses encrypt(). Returns null on any tampering/format error rather than throwing,
// so a corrupt row can't crash a payment flow.
function decrypt(bundle) {
  if (!bundle || typeof bundle !== 'string') return null;
  try {
    const [ivB64, tagB64, dataB64] = bundle.split(':');
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const key = getKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return dec.toString('utf8');
  } catch (e) {
    console.error('cryptoVault.decrypt failed:', e?.message || e);
    return null;
  }
}

module.exports = { encrypt, decrypt };

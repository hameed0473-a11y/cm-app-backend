const express = require('express');
const bcrypt = require('bcryptjs');

const supabase = require('../lib/supabase');
const { rateLimit } = require('../middleware/rateLimit');
const { checkBruteForce } = require('../middleware/bruteForce');
const { issueProAppToken } = require('../middleware/auth');

const router = express.Router();

// ===============================================================
// MPIN ENDPOINTS
// ===============================================================

// SET MPIN
router.post('/set-mpin', async (req, res) => {
  const { mobile, mpin } = req.body;
  if (!mobile || !mpin) return res.status(400).json({ error: 'mobile and mpin are required' });
  if (!/^\d{4}$/.test(mpin)) return res.status(400).json({ error: 'MPIN must be exactly 4 digits' });

  try {
    const hashedMpin = await bcrypt.hash(mpin, 10);
    const { error } = await supabase.from('users').update({ mpin: hashedMpin }).eq('mobile', mobile);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// VERIFY MPIN
router.post('/verify-mpin', rateLimit(10, 60000), async (req, res) => {
  const { mobile, mpin } = req.body;
  if (!mobile || !mpin) return res.status(400).json({ error: 'mobile and mpin are required' });

  const mpinBruteCheck = checkBruteForce(`mpin:${mobile}`, 5, 30 * 60000);
  if (mpinBruteCheck.blocked) {
    return res.status(429).json({ error: mpinBruteCheck.message });
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .select('mpin, tier, subscription_expires_at, device_id')
      .eq('mobile', mobile)
      .single();

    if (error || !data) return res.status(404).json({ error: 'User not found' });
    if (!data.mpin) return res.status(400).json({ error: 'MPIN not set for this user' });

    const isMatch = await bcrypt.compare(mpin, data.mpin);
    if (!isMatch) return res.status(401).json({ error: 'Incorrect MPIN. Please try again.' });

    const isActive = data.tier === 'lite' &&
      data.subscription_expires_at &&
      new Date(data.subscription_expires_at) > new Date();

    const resolvedTier = isActive ? 'lite' : (data.tier || 'basic');

    let proSyncToken;
    let proUserId;
    if (resolvedTier === 'pro') {
      const { data: proUser } = await supabase
        .from('pro_users')
        .select('id, mobile')
        .eq('mobile', mobile)
        .single();
      if (proUser) {
        proSyncToken = issueProAppToken(proUser.id, proUser.mobile);
        proUserId = proUser.id;
      }
    }

    res.json({
      success: true,
      tier: resolvedTier,
      device_id: data.device_id,
      proSyncToken,
      proUserId
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===============================================================
// DEVICE ID ENDPOINT
// ===============================================================

router.post('/update-device', async (req, res) => {
  const { mobile, device_id } = req.body;
  if (!mobile || !device_id) return res.status(400).json({ error: 'mobile and device_id are required' });

  try {
    const { error } = await supabase.from('users').update({ device_id }).eq('mobile', mobile);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// CHECK DEVICE — returns whether this is a new/unknown device
router.get('/check-device', async (req, res) => {
  const { mobile, device_id } = req.query;
  if (!mobile || !device_id) {
    return res.status(400).json({ error: 'mobile and device_id required' });
  }
  try {
    // Check both Basic users table and Pro users table
    let storedDeviceId = null;

    // Check Basic/Lite users first
    const { data: basicUser } = await supabase
      .from('users')
      .select('device_id')
      .eq('mobile', mobile)
      .single();

    if (basicUser?.device_id) {
      storedDeviceId = basicUser.device_id;
    }

    // Also check Pro users
    if (!storedDeviceId) {
      const { data: proUser } = await supabase
        .from('pro_users')
        .select('device_id')
        .eq('mobile', mobile)
        .single();
      if (proUser?.device_id) {
        storedDeviceId = proUser.device_id;
      }
    }

    // No device_id stored yet = first login on any device = not "new device"
    if (!storedDeviceId) {
      return res.json({ isNewDevice: false });
    }

    // Device ID exists and doesn't match = new device
    const isNewDevice = storedDeviceId !== device_id;
    res.json({ isNewDevice });
  } catch (err) {
    res.json({ isNewDevice: false });
  }
});

// ===============================================================
// DEVICE KEY ENDPOINTS
// Run this SQL first:
// ALTER TABLE users ADD COLUMN IF NOT EXISTS device_key TEXT;
// ALTER TABLE pro_users ADD COLUMN IF NOT EXISTS device_key TEXT;
// ===============================================================

// SAVE DEVICE KEY — called after OTP verified
router.post('/save-device-key', async (req, res) => {
  const { mobile, device_key } = req.body;
  if (!mobile || !device_key) {
    return res.status(400).json({ error: 'mobile and device_key required' });
  }
  try {
    // Update in Basic/Lite users table
    await supabase.from('users')
      .update({ device_key })
      .eq('mobile', mobile);

    // Also update in Pro users table
    await supabase.from('pro_users')
      .update({ device_key })
      .eq('mobile', mobile);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// VERIFY DEVICE KEY — called on every login
router.post('/verify-device-key', async (req, res) => {
  const { mobile, device_key } = req.body;
  if (!mobile || !device_key) {
    return res.status(400).json({ valid: false });
  }
  try {
    // Check Basic/Lite users first
    const { data: basicUser } = await supabase
      .from('users')
      .select('device_key')
      .eq('mobile', mobile)
      .single();

    if (basicUser?.device_key && basicUser.device_key === device_key) {
      return res.json({ valid: true });
    }

    // Check Pro users
    const { data: proUser } = await supabase
      .from('pro_users')
      .select('device_key')
      .eq('mobile', mobile)
      .single();

    if (proUser?.device_key && proUser.device_key === device_key) {
      return res.json({ valid: true });
    }

    // No match
    res.json({ valid: false });
  } catch (err) {
    res.json({ valid: false });
  }
});

module.exports = router;

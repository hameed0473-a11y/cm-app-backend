const express = require('express');
const bcrypt = require('bcryptjs');

const supabase = require('../lib/supabase');
const { issueProAppToken } = require('../middleware/auth');

const router = express.Router();

// ===============================================================
// MPIN ENDPOINTS
// ===============================================================

// SET MPIN — called after first login to create a 4-digit quick-login PIN
router.post('/set-mpin', async (req, res) => {
  const { mobile, mpin } = req.body;
  if (!mobile || !mpin) {
    return res.status(400).json({ error: 'mobile and mpin are required' });
  }
  if (!/^\d{4}$/.test(mpin)) {
    return res.status(400).json({ error: 'MPIN must be exactly 4 digits' });
  }
  try {
    const { data: user, error: findErr } = await supabase
      .from('pro_users')
      .select('id')
      .eq('mobile', mobile.trim())
      .single();

    if (findErr || !user) {
      return res.status(404).json({ error: 'No account found with this mobile number.' });
    }

    const hashedMpin = await bcrypt.hash(mpin, 10);
    const { error: updateErr } = await supabase
      .from('pro_users')
      .update({ mpin: hashedMpin })
      .eq('mobile', mobile.trim());

    if (updateErr) return res.status(500).json({ error: 'Failed to save MPIN. Please try again.' });

    res.json({ success: true });
  } catch (err) {
    console.error('set-mpin error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// VERIFY MPIN — called on quick re-login; returns a proSyncToken on success
router.post('/verify-mpin', async (req, res) => {
  const { mobile, mpin } = req.body;
  if (!mobile || !mpin) {
    return res.status(400).json({ success: false, error: 'mobile and mpin are required' });
  }
  try {
    const { data: user, error: findErr } = await supabase
      .from('pro_users')
      .select('id, mobile, mpin, subscription_expires_at')
      .eq('mobile', mobile.trim())
      .single();

    if (findErr || !user) {
      return res.status(404).json({ success: false, error: 'No account found with this mobile number.' });
    }

    if (!user.mpin) {
      return res.status(400).json({ success: false, error: 'MPIN not set. Please log in with your password first.' });
    }

    const isMatch = await bcrypt.compare(mpin, user.mpin);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: 'Incorrect MPIN.' });
    }

    const isExpired = user.subscription_expires_at &&
      new Date(user.subscription_expires_at) < new Date();
    if (isExpired) {
      return res.status(403).json({ success: false, error: 'Your subscription has expired. Please renew to continue.', code: 'SUBSCRIPTION_EXPIRED' });
    }

    res.json({ success: true, proSyncToken: issueProAppToken(user.id, user.mobile) });
  } catch (err) {
    console.error('verify-mpin error:', err?.message || err);
    res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  }
});

// ===============================================================
// DEVICE ID / DEVICE KEY ENDPOINTS
// ===============================================================

// CHECK DEVICE — returns whether this is a new/unknown device
router.get('/check-device', async (req, res) => {
  const { mobile, device_id } = req.query;
  if (!mobile || !device_id) {
    return res.status(400).json({ error: 'mobile and device_id required' });
  }
  try {
    const { data: proUser } = await supabase
      .from('pro_users')
      .select('device_id')
      .eq('mobile', mobile)
      .single();

    const storedDeviceId = proUser?.device_id || null;

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

// SAVE DEVICE KEY — called after OTP verified
router.post('/save-device-key', async (req, res) => {
  const { mobile, device_key } = req.body;
  if (!mobile || !device_key) {
    return res.status(400).json({ error: 'mobile and device_key required' });
  }
  try {
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
    const { data: proUser } = await supabase
      .from('pro_users')
      .select('device_key')
      .eq('mobile', mobile)
      .single();

    res.json({ valid: !!(proUser?.device_key && proUser.device_key === device_key) });
  } catch (err) {
    res.json({ valid: false });
  }
});

module.exports = router;

const express = require('express');

const supabase = require('../lib/supabase');

const router = express.Router();

// ===============================================================
// DEVICE ID / DEVICE KEY ENDPOINTS — pro users only. There's no
// basic/lite tier anymore, so these only ever check pro_users.
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

// ===============================================================
// DEVICE KEY ENDPOINTS
// ===============================================================

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

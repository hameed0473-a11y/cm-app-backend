const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const supabase = require('../lib/supabase');
const { rateLimit } = require('../middleware/rateLimit');
const { requireAdmin, issueProAppToken } = require('../middleware/auth');

const router = express.Router();

// ===============================================================
// BASIC / LITE USER ENDPOINTS (tracking & subscription)
// ===============================================================

// REGISTER (Basic/Lite tracking)
router.post('/register', async (req, res) => {
  const { username, mobile, email, password, countryCode, appId } = req.body;

  if (!username || !mobile || !email || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password.trim(), 10);

    const { data, error } = await supabase
      .from('users')
      .insert([{
        username,
        mobile,
        email,
        password: hashedPassword,
        login_count: 0,
        registration_date: new Date().toISOString(),
        is_paid: false,
        country_code: countryCode || null,
        app_id: appId || null
      }])
      .select();

    if (error) return res.status(400).json({ error: error.message });

    // Never send the password (hashed or not) back to the client.
    const { password: _omit, ...safeUser } = data[0];

    res.status(201).json({
      message: 'User registered successfully',
      user: safeUser
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// LOGIN (admin dashboard login — email based)
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !data) return res.status(400).json({ error: 'Invalid email or password' });

    // Support both bcrypt and plain text passwords
    let isMatch = false;
    if (data.password && data.password.startsWith('$2')) {
      isMatch = await bcrypt.compare(password, data.password);
    } else {
      isMatch = data.password === password;
    }

    if (!isMatch) return res.status(400).json({ error: 'Invalid email or password' });

    await supabase
      .from('users')
      .update({ login_count: (data.login_count || 0) + 1 })
      .eq('id', data.id);

    const token = jwt.sign(
      { id: data.id, email: data.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: { id: data.id, username: data.username, email: data.email, mobile: data.mobile, is_paid: data.is_paid }
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// VERIFY PASSWORD — used when user reinstalls app and logs in fresh
router.post('/verify-password', rateLimit(10, 60000), async (req, res) => {
  const { mobile, password } = req.body;

  if (!mobile || !password) return res.status(400).json({ error: 'mobile and password required' });

  try {
    const { data, error } = await supabase
      .from('users')
      .select('username, mobile, email, password, mpin, tier, subscription_expires_at, country_code')
      .eq('mobile', mobile)
      .single();

    if (error || !data) return res.status(404).json({ error: 'No account found with this mobile number.' });

    // Support both bcrypt and plain text passwords
    let isMatch = false;
    if (data.password && data.password.startsWith('$2')) {
      isMatch = await bcrypt.compare(password, data.password);
    } else {
      isMatch = data.password === password;
    }

    if (!isMatch) return res.status(401).json({ error: 'Incorrect password. Please try again.' });

    const isLiteActive = data.tier === 'lite' &&
      data.subscription_expires_at &&
      new Date(data.subscription_expires_at) > new Date();

    const resolvedTier = isLiteActive ? 'lite' : (data.tier || 'basic');

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
      user: {
        username: data.username,
        mobile: data.mobile,
        email: data.email,
        tier: resolvedTier,
        country_code: data.country_code,
        has_mpin: !!data.mpin
      },
      proSyncToken,
      // The app needs this to correctly identify itself in later /pro/sync
      // calls — without it, a rebuilt local profile (new device/reinstall)
      // has no way to know the real cloud account id and would otherwise
      // have to fabricate a placeholder, which /pro/sync's ownership check
      // would then correctly (but unhelpfully) reject as a mismatch.
      proUserId
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// ADMIN LOGIN
router.post('/admin-login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  const validUsername = username === process.env.ADMIN_USERNAME;
  const validPassword = password === process.env.ADMIN_PASSWORD;

  if (!validUsername || !validPassword) return res.status(401).json({ error: 'Invalid username or password' });

  const token = jwt.sign({ username, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '12h' });

  res.json({ message: 'Admin login successful', token });
});

// GET ALL REGISTERED USERS (admin only)
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, mobile, email, login_count, registration_date, is_paid, interested_in_pro, country_code, app_id, last_login, tier, subscription_expires_at')
      .order('registration_date', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET PROFILE
router.get('/profile', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { data, error } = await supabase
      .from('users')
      .select('id, username, email, mobile, login_count, registration_date, is_paid, country_code, app_id, last_login, tier, subscription_expires_at')
      .eq('id', decoded.id)
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json({ user: data });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// MARK INTERESTED IN PRO
router.post('/interested', async (req, res) => {
  const { mobile } = req.body;
  if (!mobile) return res.status(400).json({ error: 'Mobile number is required' });

  try {
    const { data, error } = await supabase
      .from('users')
      .update({ interested_in_pro: true })
      .eq('mobile', mobile)
      .select();

    if (error) return res.status(400).json({ error: error.message });
    if (!data || data.length === 0) return res.status(404).json({ error: 'No user found with this mobile number' });

    const { password: _omit, ...safeUser } = data[0];
    res.json({ message: 'Marked as interested in Pro', user: safeUser });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const supabase = require('../../lib/supabase');
const { rateLimit } = require('../../middleware/rateLimit');
const { checkBruteForce } = require('../../middleware/bruteForce');
const { createAndSendEmailOtp, wasOtpVerified } = require('../../utils/otpAuth');
const { computeAmountDue, countUniqueSubscribers } = require('../../lib/pricing');
const { issueStaffToken } = require('../../middleware/auth');

const router = express.Router();

// ===============================================================
// PRO WEB DASHBOARD — account creation, login, email OTP verification,
// and new-device re-verification. Split out of the original web.js
// (everything here was previously part of that single file).
// ===============================================================

// Masks an email for display on the OTP screen, e.g. "jo**@gmail.com".
function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!user || !domain) return email || '';
  const visible = user.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}

// ---------------------------------------------------------------
// WEB LOGIN — Pro subscribers only. Verifies mobile + password against
// the same `users` table the app itself uses, then cross-checks the
// `pro_users` table directly (not the mirrored users.tier column —
// same reasoning as the verify-mpin fix from before) to confirm this
// is genuinely an active Pro subscriber before issuing a token.
// ---------------------------------------------------------------
router.post('/web-login', rateLimit(10, 15 * 60000), async (req, res) => {
  const { mobile, password, deviceId } = req.body;
  if (!mobile || !password) {
    return res.status(400).json({ error: 'mobile and password are required' });
  }

  const bruteCheck = checkBruteForce(`web-login:${mobile}`, 5, 30 * 60000);
  if (bruteCheck.blocked) {
    return res.status(429).json({ error: bruteCheck.message });
  }

  try {
    const { data: proUser, error } = await supabase
      .from('pro_users')
      .select('id, name, mobile, email, password, device_id, currency, subscription_expires_at, otp_exempt')
      .eq('mobile', mobile)
      .single();

    if (error || !proUser) {
      return res.status(404).json({ error: 'No account found for this mobile number' });
    }
    if (!proUser.password) {
      return res.status(400).json({ error: 'Password not set for this account' });
    }

    let isMatch = false;
    if (proUser.password.startsWith('$2')) {
      isMatch = await bcrypt.compare(password, proUser.password);
    } else {
      isMatch = proUser.password === password;
    }
    if (!isMatch) {
      return res.status(401).json({ error: 'Incorrect mobile number or password' });
    }

    const isProActive =
      (!proUser.subscription_expires_at || new Date(proUser.subscription_expires_at) > new Date());

    if (!isProActive) {
      // Trial/subscription has ended — compute what renewal would cost so
      // the frontend can show a proper pricing breakdown instead of a bare
      // error string. No charge is actually collected here (see lib/pricing.js).
      let subscriberCount = 0;
      try {
        const { data: udata } = await supabase
          .from('pro_user_data')
          .select('contributors, pledges')
          .eq('user_id', proUser?.id)
          .single();
        subscriberCount = countUniqueSubscribers(udata?.contributors, udata?.pledges);
      } catch { /* default to 0 if this lookup fails — never block the response on it */ }

      const pricing = await computeAmountDue(subscriberCount, proUser?.currency);

      return res.status(403).json({
        error: 'Your 30-day free trial has ended. Renew to keep using the Pro Dashboard.',
        trialExpired: true,
        pricing
      });
    }

    // NEW DEVICE CHECK — no device_id stored yet means this is the first
    // ever web login for this account, so it's trusted (and saved) below.
    // A stored device_id that doesn't match the one this browser is
    // sending means an unrecognized device/browser — don't issue a token
    // yet, gate behind an email OTP first (finished by /web-login-verify).
    //
    // otp_exempt is a per-account escape hatch (default false for every
    // normal account — see the otp_exempt migration) reserved for demo/
    // investor-style accounts that need to log in from many devices/
    // browsers without tripping the email-OTP challenge each time. It
    // deliberately only widens what counts as a "known device" here —
    // every other account's behavior, and every other auth path, is
    // untouched.
    const storedDeviceId = proUser.device_id;
    const isKnownDevice = !storedDeviceId || storedDeviceId === deviceId || !!proUser.otp_exempt;

    if (!isKnownDevice) {
      let otpRecord;
      try {
        otpRecord = await createAndSendEmailOtp(proUser.email, {
          heading: 'We noticed a login from a new device — verify it’s you'
        });
      } catch (otpErr) {
        console.error('web-login otp send error:', otpErr?.message || otpErr);
        return res.status(500).json({ error: 'Could not send a verification email. Please try again.' });
      }

      return res.json({
        success: false,
        otpRequired: true,
        stateId: otpRecord.id.toString(),
        mobile: proUser.mobile,
        maskedEmail: maskEmail(proUser.email)
      });
    }

    // Known device, or first-ever web login — save the device_id if this
    // was the first time, then issue the token as before.
    if (!storedDeviceId && deviceId) {
      await supabase.from('pro_users').update({ device_id: deviceId }).eq('id', proUser.id);
    }

    const token = jwt.sign(
      { type: 'pro_web', userId: proUser.id, mobile: proUser.mobile },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      role: 'owner',
      user: { name: proUser.name, mobile: proUser.mobile }
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------
// WEB REGISTER — lets a brand-new user create a Pro account directly
// from the website login page and land straight in the dashboard.
// Every registered user is Pro by default — there's no separate
// basic/lite tier anymore, so this only ever creates a pro_users row
// (password included) plus its empty cloud data row, and returns the
// same web token /web-login issues — so the new user is logged in
// immediately. Access is a genuine 30-day free trial (expiry set 30
// days out) — after that, web-login blocks and returns the
// per-subscriber renewal pricing from lib/pricing.js instead of a token.
// ---------------------------------------------------------------
router.post('/web-register', rateLimit(5, 30 * 60000), async (req, res) => {
  const name = (req.body.name || '').trim();
  const mobile = (req.body.mobile || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const countryCode = req.body.countryCode || null;
  const currency = (req.body.currency || 'INR').toUpperCase();

  if (!name || !mobile || !email || !password) {
    return res.status(400).json({ error: 'Name, mobile, email and password are all required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  try {
    // Reject if this mobile already has a Pro account. Uses limit(1) instead
    // of single() — single() errors out (and silently yields null data, since
    // that error goes unchecked) when more than one row matches, which would
    // let the duplicate check no-op for any mobile/email that already has
    // more than one existing row.
    const { data: existingProRows } = await supabase
      .from('pro_users').select('id').eq('mobile', mobile).limit(1);
    if (existingProRows && existingProRows.length > 0) {
      return res.status(400).json({ error: 'An account with this mobile number already exists. Please log in instead.' });
    }

    // Reject if this email already has a Pro account under a different
    // mobile number — otherwise the same person (or anyone else) could
    // register unlimited accounts by reusing one email with a new mobile
    // each time.
    const { data: existingEmailRows } = await supabase
      .from('pro_users').select('id').eq('email', email).limit(1);
    if (existingEmailRows && existingEmailRows.length > 0) {
      return res.status(400).json({ error: 'An account with this email address already exists. Please log in instead.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const now = new Date().toISOString();
    // 30-day free trial — after this, web-login's isProActive check blocks
    // access and returns pricing info instead of a token (see above).
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const newUserId = `pro-${Date.now().toString().slice(-8)}`;

    // 1) pro_users — the source of truth for web access.
    const { data: newPro, error: proError } = await supabase
      .from('pro_users')
      .insert([{
        id: newUserId,
        name,
        mobile,
        email,
        password: hashedPassword,
        country_code: countryCode,
        currency,
        tier: 'pro',
        joined_at: now,
        last_login_at: now,
        subscription_expires_at: expiresAt
      }])
      .select()
      .single();

    if (proError) {
      if ((proError.message || '').toLowerCase().includes('duplicate')) {
        return res.status(400).json({ error: 'An account with these details already exists. Please log in.' });
      }
      console.error('web-register pro_users error:', proError.message);
      return res.status(500).json({ error: 'Could not create your account. Please try again.' });
    }

    // 2) Seed empty cloud data.
    const { error: dataError } = await supabase.from('pro_user_data').insert([{
      user_id: newUserId, contributors: [], targets: [], contributions: [], pledges: [], updated_at: now
    }]);
    if (dataError) {
      await supabase.from('pro_users').delete().eq('id', newUserId);
      console.error('web-register pro_user_data error:', dataError.message);
      return res.status(500).json({ error: 'Could not set up your data. Please try again.' });
    }

    // 4) Require email verification before the account is usable. The
    // account already exists at this point (pro_users, users,
    // pro_user_data) — it's just gated behind email_verified=false until
    // /web-register-verify confirms the OTP and issues the real token.
    let otpRecord;
    try {
      otpRecord = await createAndSendEmailOtp(email, {
        heading: 'Welcome! Verify your email to finish creating your account'
      });
    } catch (otpErr) {
      console.error('web-register otp send error:', otpErr?.message || otpErr);
      // Don't fail the whole registration for this — the account already
      // exists, so let the person retry sending the code from the OTP screen.
    }

    res.json({
      success: true,
      otpRequired: true,
      stateId: otpRecord ? otpRecord.id.toString() : null,
      mobile,
      email
    });
  } catch (err) {
    console.error('web-register error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ---------------------------------------------------------------
// WEB REGISTER — VERIFY EMAIL OTP. Completes registration: confirms
// the OTP sent to this email was actually verified (via
// /verify-email-otp), flips pro_users.email_verified to true, and
// only then issues the web token — so a brand-new account never gets
// a working session until its email is confirmed.
// ---------------------------------------------------------------
router.post('/web-register-verify', rateLimit(10, 15 * 60000), async (req, res) => {
  const { mobile, stateId } = req.body;
  if (!mobile || !stateId) {
    return res.status(400).json({ error: 'mobile and stateId are required' });
  }

  try {
    const { data: proUser, error } = await supabase
      .from('pro_users')
      .select('id, mobile, name, email, email_verified')
      .eq('mobile', mobile)
      .single();

    if (error || !proUser) return res.status(404).json({ error: 'Account not found.' });

    if (!proUser.email_verified) {
      const verified = await wasOtpVerified(stateId, proUser.email);
      if (!verified) {
        return res.status(400).json({ error: 'Please verify the code sent to your email first.' });
      }
      await supabase.from('pro_users').update({ email_verified: true }).eq('id', proUser.id);
    }

    const token = jwt.sign(
      { type: 'pro_web', userId: proUser.id, mobile: proUser.mobile },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ success: true, token, role: 'owner', user: { name: proUser.name, mobile: proUser.mobile } });
  } catch (err) {
    console.error('web-register-verify error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ---------------------------------------------------------------
// WEB LOGIN — VERIFY EMAIL OTP (new device). Confirms the OTP sent
// during /web-login's new-device challenge was actually verified,
// trusts this device going forward (saves deviceId onto pro_users),
// and issues the same web token /web-login would have issued
// directly on a known device.
// ---------------------------------------------------------------
router.post('/web-login-verify', rateLimit(10, 15 * 60000), async (req, res) => {
  const { mobile, deviceId, stateId } = req.body;
  if (!mobile || !stateId) {
    return res.status(400).json({ error: 'mobile and stateId are required' });
  }

  try {
    const { data: proUser, error } = await supabase
      .from('pro_users')
      .select('id, name, mobile, email')
      .eq('mobile', mobile)
      .single();

    if (error || !proUser) return res.status(404).json({ error: 'Account not found.' });

    const verified = await wasOtpVerified(stateId, proUser.email);
    if (!verified) {
      return res.status(400).json({ error: 'Please verify the code sent to your email first.' });
    }

    if (deviceId) {
      await supabase.from('pro_users').update({ device_id: deviceId }).eq('id', proUser.id);
    }

    const token = jwt.sign(
      { type: 'pro_web', userId: proUser.id, mobile: proUser.mobile },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ success: true, token, role: 'owner', user: { name: proUser.name || '', mobile: proUser.mobile } });
  } catch (err) {
    console.error('web-login-verify error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ---------------------------------------------------------------
// STAFF LOGIN — deliberately a separate endpoint/screen from the
// owner's /web-login, not a shared mobile-number form. Staff never
// have a mobile-based identity here at all: they log in with a fixed,
// system-generated id ("<owner's pro_users.id>.<2-digit sequence>",
// e.g. "pro-12345678.01") assigned when the owner created their
// account (see /web-add-staff in routes/web/settings.js), plus the
// password set for them at that time. No device/email-OTP challenge —
// that flow protects the owner's billing/settings surface, which
// staff can never reach anyway.
// ---------------------------------------------------------------
router.post('/web-staff-login', rateLimit(10, 15 * 60000), async (req, res) => {
  const staffUserId = String(req.body.staffUserId || '').trim();
  const password = req.body.password || '';
  if (!staffUserId || !password) {
    return res.status(400).json({ error: 'Staff ID and password are required' });
  }

  const bruteCheck = checkBruteForce(`staff-login:${staffUserId}`, 5, 30 * 60000);
  if (bruteCheck.blocked) {
    return res.status(429).json({ error: bruteCheck.message });
  }

  try {
    const { data: staff, error } = await supabase
      .from('staff_users')
      .select('id, owner_user_id, name, email, staff_user_id, password, status')
      .eq('staff_user_id', staffUserId)
      .single();

    if (error || !staff) {
      return res.status(404).json({ error: 'No staff account found for this ID' });
    }
    if (staff.status !== 'active') {
      return res.status(403).json({ error: 'This staff account has been disabled. Contact your admin.' });
    }

    const isMatch = staff.password.startsWith('$2')
      ? await bcrypt.compare(password, staff.password)
      : staff.password === password;
    if (!isMatch) {
      return res.status(401).json({ error: 'Incorrect Staff ID or password' });
    }

    // The mobile app (unlike the website) needs the owner's id/mobile up
    // front to seed its local session — it has no separate "load dashboard"
    // step before this, so hand both back here rather than making the
    // client make a second round trip just to learn who its owner is.
    // Also carries subscription_expires_at so a staff login can be blocked
    // the same way /web-login and /pro/login already block the owner —
    // without this, a staff account kept working past the owner's
    // trial/subscription expiry (the only place that was ever enforced
    // downstream was /pro/sync's read/write, and only after a token had
    // already been issued).
    const { data: owner } = await supabase
      .from('pro_users')
      .select('id, mobile, subscription_expires_at')
      .eq('id', staff.owner_user_id)
      .single();

    const isOwnerExpired = owner?.subscription_expires_at &&
      new Date(owner.subscription_expires_at) < new Date();

    if (isOwnerExpired) {
      return res.status(403).json({
        error: 'Your admin’s Pro subscription has expired. Ask them to renew from the web dashboard.',
        code: 'SUBSCRIPTION_EXPIRED'
      });
    }

    await supabase.from('staff_users').update({ last_login_at: new Date().toISOString() }).eq('id', staff.id);

    const token = issueStaffToken(staff.id, staff.owner_user_id, staff.staff_user_id, staff.name);
    res.json({
      success: true,
      token,
      role: 'staff',
      user: { name: staff.name, email: staff.email, staffUserId: staff.staff_user_id },
      ownerUserId: owner?.id || staff.owner_user_id,
      ownerMobile: owner?.mobile || null
    });
  } catch (err) {
    console.error('web-staff-login error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});


module.exports = router;

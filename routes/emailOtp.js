const express = require('express');

const supabase = require('../lib/supabase');
const { rateLimit } = require('../middleware/rateLimit');
const { checkBruteForce, recordFailedAttempt, clearBruteForce } = require('../middleware/bruteForce');
const { sanitize } = require('../utils/sanitize');
const { sendEmailViaResend, generateOtp } = require('../utils/email');

const router = express.Router();

// ===============================================================
// EMAIL OTP ENDPOINTS (Resend + Supabase)
// ===============================================================

// SEND EMAIL OTP via Resend
router.post('/send-email-otp', rateLimit(10, 10 * 60000), async (req, res) => {
  const { email } = req.body;
  console.log('send-email-otp called for:', email);
  if (!email) return res.status(400).json({ error: 'Email is required' });
  // NOTE: sanitizedEmail is computed (same as the original code) but not
  // currently used below — the queries and email send still use the raw
  // `email` value, exactly as before this split.
  const sanitizedEmail = sanitize(email);

  try {
    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 minutes

    // Delete any existing unused OTPs for this email
    await supabase
      .from('email_otps')
      .delete()
      .eq('email', email)
      .eq('used', false);

    // Store new OTP in Supabase
    const { data: otpRecord, error: insertError } = await supabase
      .from('email_otps')
      .insert([{ email, otp, expires_at: expiresAt, used: false }])
      .select()
      .single();

    if (insertError) {
      console.error('OTP insert error:', insertError);
      return res.status(500).json({ error: 'Failed to generate OTP. Please try again.' });
    }

    // Send OTP email via Resend
    await sendEmailViaResend(
      email,
      'Your Verification Code — Contributions Manager',
      `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #059669; margin-bottom: 8px;">Contributions Manager</h2>
          <p style="color: #374151; font-size: 15px;">Your verification code is:</p>
          <div style="background: #f0fdf4; border: 2px solid #10b981; border-radius: 12px; padding: 20px; text-align: center; margin: 20px 0;">
            <span style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #065f46;">${otp}</span>
          </div>
          <p style="color: #6b7280; font-size: 13px;">This code expires in <strong>5 minutes</strong>.</p>
          <p style="color: #6b7280; font-size: 13px;">If you did not request this, please ignore this email.</p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;"/>
          <p style="color: #9ca3af; font-size: 11px;">AFTechs · Contributions Manager App</p>
        </div>
      `
    );

    console.log('OTP email sent to:', email);
    res.json({ success: true, stateId: otpRecord.id.toString() });
  } catch (err) {
    console.error('Send OTP error:', err);
    res.status(500).json({ error: 'Failed to send OTP email. Please try again.' });
  }
});

// VERIFY EMAIL OTP
router.post('/verify-email-otp', rateLimit(10, 10 * 60000), async (req, res) => {
  const { stateId, otp } = req.body;

  if (!stateId || !otp) {
    return res.status(400).json({ error: 'stateId and otp are required' });
  }

  const parsedId = parseInt(stateId);
  if (isNaN(parsedId)) {
    return res.status(400).json({ error: 'Invalid session. Please request a new OTP.' });
  }

  // Brute force check on OTP
  const otpKey = `otp:${parsedId}`;
  const bruteCheck = checkBruteForce(otpKey, 5, 15 * 60000);
  if (bruteCheck.blocked) {
    return res.status(429).json({ error: bruteCheck.message });
  }

  try {
    const { data: otpRecord, error } = await supabase
      .from('email_otps')
      .select('*')
      .eq('id', parsedId)
      .eq('used', false)
      .single();

    if (error || !otpRecord) {
      return res.status(400).json({ error: 'OTP expired or invalid. Please request a new one.' });
    }

    // Check expiry
    if (new Date(otpRecord.expires_at) < new Date()) {
      await supabase.from('email_otps').delete().eq('id', parseInt(stateId));
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    // Check OTP value

    if (String(otpRecord.otp).trim() !== String(otp).trim()) {
      recordFailedAttempt(otpKey, 5, 15 * 60000);
      return res.status(401).json({ error: 'Incorrect OTP. Please try again.' });
    }
    clearBruteForce(otpKey);

    // Mark as used
    await supabase
      .from('email_otps')
      .update({ used: true })
      .eq('id', parseInt(stateId));

    res.json({ success: true, authenticated: true });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: 'OTP verification failed. Please try again.' });
  }
});

module.exports = router;

const supabase = require('../lib/supabase');
const { sendEmailViaResend, generateOtp } = require('./email');

// ---------------------------------------------------------------
// Shared OTP helpers used to gate web-register / web-login behind an
// email verification step. Mirrors the exact same email_otps table +
// send pattern as routes/emailOtp.js's /send-email-otp — kept as a
// separate helper (rather than importing that router) so web.js can
// call it directly as a function instead of round-tripping through
// another route.
// ---------------------------------------------------------------

// Creates + stores + emails a fresh OTP for `email`. Returns the
// inserted email_otps row (id is used as the `stateId` the frontend
// already knows how to pass to /verify-email-otp).
async function createAndSendEmailOtp(email, { heading = 'Your verification code' } = {}) {
  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 minutes

  // Same "clear any unused OTP for this email first" behavior as /send-email-otp.
  await supabase.from('email_otps').delete().eq('email', email).eq('used', false);

  const { data: otpRecord, error } = await supabase
    .from('email_otps')
    .insert([{ email, otp, expires_at: expiresAt, used: false }])
    .select()
    .single();

  if (error) throw error;

  await sendEmailViaResend(
    email,
    'Your Verification Code — Contributions Manager',
    `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #059669; margin-bottom: 8px;">Contributions Manager</h2>
        <p style="color: #374151; font-size: 15px;">${heading}. Your verification code is:</p>
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

  return otpRecord; // { id, email, otp, expires_at, used }
}

// Confirms that the OTP identified by `stateId` was already verified
// (i.e. POST /verify-email-otp was called and succeeded, which flips
// `used` to true) AND was issued for `expectedEmail`. This deliberately
// does NOT re-check the OTP digits — /verify-email-otp already did that
// — it just confirms that step actually happened for the right account,
// so web-register-verify / web-login-verify can't be called on their own
// to skip verification.
async function wasOtpVerified(stateId, expectedEmail) {
  const parsedId = parseInt(stateId);
  if (isNaN(parsedId)) return false;

  const { data, error } = await supabase
    .from('email_otps')
    .select('email, used')
    .eq('id', parsedId)
    .single();

  if (error || !data) return false;
  if (!data.used) return false;
  if (data.email !== expectedEmail) return false;

  return true;
}

module.exports = { createAndSendEmailOtp, wasOtpVerified };

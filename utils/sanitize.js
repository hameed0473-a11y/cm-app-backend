// Input sanitizer — strip dangerous characters.
// Moved unchanged from routes/auth.js. (Only call site today is
// emailOtp.js's send-email-otp — see note there.)
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[<>"'%;()&+]/g, '').trim();
}

module.exports = { sanitize };

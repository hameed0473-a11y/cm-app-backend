require('dotenv').config();

// Resend email via HTTP API (works on Render — no SMTP port blocking).
// Moved unchanged from routes/auth.js.
async function sendEmailViaResend(to, subject, html) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
    },
    body: JSON.stringify({
      from: 'Contributions Manager <noreply@mail.aftechs.in>',
      to: [to],
      subject,
      html
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Email send failed');
  return data;
}

// Helper: generate 6-digit OTP. Moved unchanged from routes/auth.js.
function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

module.exports = { sendEmailViaResend, generateOtp };

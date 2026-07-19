const express = require('express');

const supabase = require('../lib/supabase');
const { rateLimit } = require('../middleware/rateLimit');
const { sendEmailViaResend } = require('../utils/email');

const router = express.Router();

// ===============================================================
// WEBSITE CONTACT FORM — "Tell us your requirement" on the landing
// page. Public, unauthenticated, like /visitor. Stores the inquiry
// (durable record, visible to nobody but us — no admin UI reads this
// table yet) and best-effort emails admin@aftechs.in; a failed email
// never fails the request since the row is already saved.
// ===============================================================

const PROJECT_TYPES = ['mobile', 'web', 'both', 'other'];

router.post('/contact-inquiry', rateLimit(5, 10 * 60000), async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim();
  const mobile = String(req.body.mobile || '').trim();
  const requirement = String(req.body.requirement || '').trim();
  const projectType = PROJECT_TYPES.includes(req.body.projectType) ? req.body.projectType : 'other';

  if (!name || !requirement) {
    return res.status(400).json({ error: 'Name and a short description of your requirement are required.' });
  }
  if (!email && !mobile) {
    return res.status(400).json({ error: 'Please share an email or mobile number so we can reach you.' });
  }

  try {
    const { error } = await supabase
      .from('contact_inquiries')
      .insert([{ name, email: email || null, mobile: mobile || null, project_type: projectType, requirement }]);
    if (error) return res.status(500).json({ error: 'Could not save your request. Please try again.' });

    try {
      await sendEmailViaResend(
        'admin@aftechs.in',
        `New project inquiry — ${name}`,
        `<p><strong>Name:</strong> ${name}</p>
         <p><strong>Email:</strong> ${email || '—'}</p>
         <p><strong>Mobile:</strong> ${mobile || '—'}</p>
         <p><strong>Project type:</strong> ${projectType}</p>
         <p><strong>Requirement:</strong><br>${requirement.replace(/\n/g, '<br>')}</p>`
      );
    } catch (emailErr) {
      console.error('contact-inquiry notification email failed:', emailErr?.message || emailErr);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('contact-inquiry error:', err?.message || err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

module.exports = router;

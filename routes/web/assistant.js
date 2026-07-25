const express = require('express');
require('dotenv').config();

const { requireProOrStaffToken } = require('../../middleware/auth');
const { rateLimit } = require('../../middleware/rateLimit');

const router = express.Router();

const ANTHROPIC_MODEL = process.env.ASSISTANT_MODEL || 'claude-haiku-4-5-20251001';
const MAX_HISTORY_TURNS = 10;
const MAX_MESSAGE_LEN = 2000;

// ---------------------------------------------------------------
// AI DASHBOARD ASSISTANT — phase 1: voice/text Q&A only, no write
// actions. Knows the dashboard's own layout and setup steps so it can
// walk a user through things like linking a payment gateway or
// creating a goal, without touching any data itself. Kept short/plain
// since replies are read aloud via the browser's speech synthesis.
// ---------------------------------------------------------------
const SYSTEM_PROMPT = `You are the built-in voice/text help assistant inside the AFTech Contributions Manager (CM) Pro web dashboard, used by treasurers/collectors to manage community contributions, goals, subscribers, expenses and payments.

Dashboard layout (left sidebar):
- Overview: summary stats (total collected, subscribers, active goals, event pledges).
- Goals and Pledges: create/manage monthly, yearly or one-off pledge goals.
- Subscribers: list and manage contributors, add/edit/delete them.
- Subscriber Details: search a subscriber by mobile number to see their goals and dues.
- Pending: subscribers/goals with outstanding dues.
- Accounting: track payees and expenses separately from contribution goals.
- Integrations: connect payment gateways and WhatsApp.
- Billing: manage the Pro subscription/renewal.
- Support: raise/view support tickets.
- Staff: add staff accounts with limited access.

How to create a goal: Sidebar -> "Goals and Pledges" -> click "New Goal" for a monthly or yearly goal (auto-renews each period) or "New Pledge Goal" for a one-off event (no renewal) -> enter a name and optional target amount -> Create.

How to collect a payment: open the relevant goal or subscriber (or use the Pending tab) -> "Collect Payment" -> enter the amount -> Save. A receipt can then be shared via WhatsApp or SMS.

How to add a subscriber/contributor: Sidebar -> Subscribers -> add a contributor with name and mobile number, then open a goal and use "Add Subscribers" to subscribe them to it.

How to link a bank/payment gateway: Sidebar -> Integrations -> Payment Gateways tab -> choose Razorpay (India, INR) or Stripe.
  Razorpay: In the Razorpay Dashboard go to Settings -> API Keys -> Generate Key, then paste the Key ID and Key Secret into the dashboard. Then in Razorpay go to Settings -> Webhooks -> Add New Webhook, use the Webhook URL shown in the dashboard, set a Webhook Secret (any strong text) and paste that same secret into the dashboard too. Start with Test keys, run one payment end-to-end, then switch to Live keys.
  Stripe: In the Stripe Dashboard go to Developers -> API keys, copy the Secret key and paste it in. Then Developers -> Webhooks -> Add endpoint, use the Webhook URL shown, and paste the Signing secret into the Webhook Secret field. Test in Test mode first, then switch to Live.

WhatsApp integration: Integrations -> WhatsApp tab -> connect it to send payment reminders and receipts in bulk.

Rules for your replies:
- Only answer questions about how to use this AFTech CM dashboard.
- You cannot perform actions yet (cannot create goals, collect payments, etc. yourself) - only explain the exact steps/buttons the user should use themselves.
- Keep answers short and conversational (usually under 60 words) since they may be read aloud by voice, unless the user explicitly asks for more detail.
- If a question is unrelated to this app, say briefly that you can only help with the AFTech CM dashboard.`;

router.post('/assistant-chat', rateLimit(20, 60 * 1000), requireProOrStaffToken, async (req, res) => {
  const { message, history } = req.body;

  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  if (message.length > MAX_MESSAGE_LEN) {
    return res.status(400).json({ error: 'message is too long' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'The AI assistant is not set up yet. Please try again later.' });
  }

  const priorTurns = Array.isArray(history)
    ? history
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length <= MAX_MESSAGE_LEN)
        .slice(-MAX_HISTORY_TURNS)
        .map(m => ({ role: m.role, content: m.content }))
    : [];

  const messages = [...priorTurns, { role: 'user', content: message.trim() }];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Assistant API error:', data?.error || data);
      return res.status(502).json({ error: 'The assistant is temporarily unavailable. Please try again.' });
    }

    const reply = Array.isArray(data.content)
      ? data.content.map(block => block.text || '').join('').trim()
      : '';

    res.json({ success: true, reply: reply || "Sorry, I couldn't come up with an answer to that." });
  } catch (err) {
    console.error('Assistant request failed:', err.message);
    res.status(502).json({ error: 'The assistant is temporarily unavailable. Please try again.' });
  }
});

module.exports = router;

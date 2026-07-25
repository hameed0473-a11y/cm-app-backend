const express = require('express');
require('dotenv').config();

const { requireProOrStaffToken } = require('../../middleware/auth');
const { rateLimit } = require('../../middleware/rateLimit');
const { parseLocalIntent } = require('../../utils/assistantLocalIntent');

const router = express.Router();

const ANTHROPIC_MODEL = process.env.ASSISTANT_MODEL || 'claude-haiku-4-5-20251001';
const MAX_HISTORY_TURNS = 10;
const MAX_MESSAGE_LEN = 2000;

// ---------------------------------------------------------------
// AI DASHBOARD ASSISTANT — HYBRID ROUTING. Every message is tried
// against the free, local, rule-based parser (utils/assistantLocalIntent.js)
// first. If it confidently recognizes the message as one of the
// predefined actions, a delete/remove refusal, or a FAQ topic, that
// answer is returned immediately and Claude is never called — free,
// deterministic, and identical whether or not ANTHROPIC_API_KEY is set.
// Claude is only ever billed for the messages the local parser genuinely
// doesn't recognize (open-ended questions, unusual phrasing) — "only
// contact the AI when the question is difficult".
//
// The AI never touches the database itself — it only returns a
// structured {type, params} action for one of the three predefined
// tools below. The frontend resolves that action against the account's
// real goals/subscribers and always confirms with the user before
// calling the existing write endpoints. There is deliberately no
// delete-type tool — see the local parser's safety gate, which refuses
// delete/remove/unsubscribe requests before either path is even tried.
// ---------------------------------------------------------------
const SYSTEM_PROMPT = `You are the built-in voice/text assistant inside the AFTech Contributions Manager (CM) Pro web dashboard, used by treasurers/collectors to manage community contributions, goals, subscribers, expenses and payments.

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

You can perform these actions directly using tools, instead of just explaining the steps:
- create_goal: creates a new goal/pledge category.
- collect_payment: records a payment collected from a subscriber for a goal.
- add_subscriber: adds a new subscriber/contributor.
- subscribe_to_goal: links an EXISTING subscriber to an EXISTING goal.
- create_pledge: adds a subscriber's pledge amount to an event/one-off goal.
- mark_goal_complete: marks an existing goal as completed.
- stop_rollover: stops a monthly/yearly goal from automatically renewing next period.
- add_expense: logs an expense in Accounting.
- add_payee: adds a new payee in Accounting.
- raise_ticket: opens a new support ticket.
- reopen_ticket: reopens the account's most recently solved support ticket.
- set_currency: changes the account's collection currency.
- edit_subscriber: updates an existing subscriber's mobile number or name.
- report_query: answers a read-only question from data already loaded (totals, dues, counts, plan info) — never a write.

Rules for each tool:
- create_goal: you must know whether it's monthly, yearly, or a one-off/event pledge. If the user didn't say, ASK them first in plain text — never assume "event" or any other default.
- collect_payment: you need a subscriber name (or mobile number) and an amount. If the user also names a specific goal, include goalName; if they don't mention one, simply omit goalName from the tool call — the app will show them their list of dues to pick from, so you must NOT ask which goal yourself or guess one.
- add_subscriber: you need a name and mobile number. If the user doesn't also mention a goal, ask them once in plain text whether to just add the subscriber, or also subscribe them to a specific goal right away, and wait for their answer before calling the tool.
- subscribe_to_goal / create_pledge: need a subscriber name and goal name (create_pledge also needs an amount).
- mark_goal_complete / stop_rollover: need only the goal name.
- add_expense: needs an amount and a category from this exact list: Utility Bills, Staff Salaries, Maintenance, Cleaning, Office Expenses, Event Expenses, Construction & Renovation, Equipment Purchases, Charity Payments, Miscellaneous. Ask if the user's wording doesn't clearly match one of these.
- add_payee: needs a name, mobile number, and a category from that same list.
- raise_ticket: needs a category (one of: billing, collection, receipt_pdf, import_subscribers, other — default to "other" if unclear, this one is low-stakes) and a short description.
- reopen_ticket: no parameters — always reopens the account's own last solved ticket. Never ask which ticket; there is only ever one target.
- set_currency: needs a currency from: INR, USD, GBP, EUR, AUD, CAD, SGD, AED, NZD, CHF, ZAR, MYR, SAR, HKD.
- edit_subscriber: needs a subscriber name (to look them up) and at least one of a new mobile number or a new name. Ask for whichever is missing.
- report_query: needs a metric — one of: total_collected (optionally scoped to "month"), pending_subscribers, subscriber_due (needs subscriberName), active_goals, subscriber_count, current_plan. Pick the metric that matches what the user asked; never guess a subscriber name for subscriber_due.
- Never guess a name, amount, or category the user didn't say — ask a short clarifying question in plain text instead of calling a tool with incomplete information (except raise_ticket's category, which may default to "other").

You must NEVER delete, remove, or unsubscribe anything — there is no tool for it and you are not authorized to perform destructive actions. If asked to delete/remove/unsubscribe something, say plainly that you can't do that yourself (it always needs a manual click in the dashboard as a safety measure), and explain the manual steps instead.

For anything else (how something works, setup steps, general questions), answer directly instead of using a tool:

How to create a goal manually: Sidebar -> "Goals and Pledges" -> click "New Goal" for a monthly or yearly goal (auto-renews each period) or "New Pledge Goal" for a one-off event (no renewal) -> enter a name and optional target amount -> Create.

How to collect a payment manually: open the relevant goal or subscriber (or use the Pending tab) -> "Collect Payment" -> enter the amount -> Save. A receipt can then be shared via WhatsApp or SMS.

How to add a subscriber/contributor manually: Sidebar -> Subscribers -> add a contributor with name and mobile number, then open a goal and use "Add Subscribers" to subscribe them to it.

How to link a bank/payment gateway: Sidebar -> Integrations -> Payment Gateways tab -> choose Razorpay (India, INR) or Stripe.
  Razorpay: In the Razorpay Dashboard go to Settings -> API Keys -> Generate Key, then paste the Key ID and Key Secret into the dashboard. Then in Razorpay go to Settings -> Webhooks -> Add New Webhook, use the Webhook URL shown in the dashboard, set a Webhook Secret (any strong text) and paste that same secret into the dashboard too. Start with Test keys, run one payment end-to-end, then switch to Live keys.
  Stripe: In the Stripe Dashboard go to Developers -> API keys, copy the Secret key and paste it in. Then Developers -> Webhooks -> Add endpoint, use the Webhook URL shown, and paste the Signing secret into the Webhook Secret field. Test in Test mode first, then switch to Live.

WhatsApp integration: Integrations -> WhatsApp tab -> connect it to send payment reminders and receipts in bulk.

Rules for your replies:
- Only answer questions about, or perform actions within, this AFTech CM dashboard.
- Keep answers short and conversational (usually under 60 words) since they may be read aloud by voice, unless the user explicitly asks for more detail.
- If a question is unrelated to this app, say briefly that you can only help with the AFTech CM dashboard.
- When you call a tool, you may also include a short confirmation-style text reply (e.g. "Sure, here's what I'll create:") but keep it brief — the app will show the exact details separately.`;

const TOOLS = [
  {
    name: 'create_goal',
    description: 'Create a new contribution goal/pledge category. Use when the user asks to create, add, start, or set up a new goal, target, fund, or pledge collection, AND you already know whether it is monthly, yearly, or a one-off/event pledge.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the goal, exactly as the user said it (e.g. "Diwali Fund", "Cleaning Charges").' },
        category: {
          type: 'string',
          enum: ['monthly', 'yearly', 'event'],
          description: '"monthly" or "yearly" for a goal that repeats every period, "event" for a one-off pledge collection with no repeat. Must be explicitly known from what the user said — ask first if unclear, never default.'
        },
        targetAmount: { type: 'number', description: 'Optional target amount in the account currency. Omit if not mentioned.' }
      },
      required: ['name', 'category']
    }
  },
  {
    name: 'collect_payment',
    description: 'Record that a payment/contribution has been collected from a subscriber for a goal. Use when the user asks to collect, record, log, or mark a payment/amount received from someone.',
    input_schema: {
      type: 'object',
      properties: {
        subscriberName: { type: 'string', description: "The subscriber's name or mobile number, exactly as the user said it." },
        goalName: { type: 'string', description: 'The name of the goal/target this payment is for, only if the user explicitly named one. Omit this field entirely otherwise — do not guess or ask.' },
        amount: { type: 'number', description: 'The amount collected.' }
      },
      required: ['subscriberName', 'amount']
    }
  },
  {
    name: 'add_subscriber',
    description: 'Add a new subscriber/contributor. Use when the user asks to add, create, or register a new subscriber/contributor, after you have asked whether to also subscribe them to a goal (or they already told you).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "The subscriber's name." },
        mobile: { type: 'string', description: "The subscriber's mobile number." },
        goalName: { type: 'string', description: 'Optional — only include if the user wants them subscribed to a specific goal right away.' }
      },
      required: ['name', 'mobile']
    }
  },
  {
    name: 'subscribe_to_goal',
    description: 'Subscribe an existing subscriber to an existing goal.',
    input_schema: {
      type: 'object',
      properties: {
        subscriberName: { type: 'string', description: "The subscriber's name or mobile number." },
        goalName: { type: 'string', description: 'The goal to subscribe them to.' }
      },
      required: ['subscriberName', 'goalName']
    }
  },
  {
    name: 'create_pledge',
    description: "Add a subscriber's pledge amount to an event/one-off goal.",
    input_schema: {
      type: 'object',
      properties: {
        subscriberName: { type: 'string', description: "The subscriber's name or mobile number." },
        goalName: { type: 'string', description: 'The event/pledge goal this is for.' },
        amount: { type: 'number', description: 'The pledged amount.' }
      },
      required: ['subscriberName', 'goalName', 'amount']
    }
  },
  {
    name: 'mark_goal_complete',
    description: 'Mark an existing goal as completed.',
    input_schema: {
      type: 'object',
      properties: { goalName: { type: 'string', description: 'The goal to mark complete.' } },
      required: ['goalName']
    }
  },
  {
    name: 'stop_rollover',
    description: "Stop a monthly/yearly goal from automatically renewing at the end of its current period.",
    input_schema: {
      type: 'object',
      properties: { goalName: { type: 'string', description: 'The goal to stop rolling over.' } },
      required: ['goalName']
    }
  },
  {
    name: 'add_expense',
    description: 'Log an expense in Accounting.',
    input_schema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'The expense amount.' },
        category: {
          type: 'string',
          enum: ['Utility Bills', 'Staff Salaries', 'Maintenance', 'Cleaning', 'Office Expenses', 'Event Expenses', 'Construction & Renovation', 'Equipment Purchases', 'Charity Payments', 'Miscellaneous'],
          description: 'Must be exactly one of the listed categories — ask the user to pick one if their wording is unclear.'
        },
        description: { type: 'string', description: 'Optional short description of what the expense was for.' }
      },
      required: ['amount', 'category']
    }
  },
  {
    name: 'add_payee',
    description: 'Add a new payee (vendor/staff/contractor the treasurer pays money out to) in Accounting.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "The payee's name." },
        mobile: { type: 'string', description: "The payee's mobile number." },
        category: {
          type: 'string',
          enum: ['Utility Bills', 'Staff Salaries', 'Maintenance', 'Cleaning', 'Office Expenses', 'Event Expenses', 'Construction & Renovation', 'Equipment Purchases', 'Charity Payments', 'Miscellaneous'],
          description: 'Must be exactly one of the listed categories — ask the user to pick one if their wording is unclear.'
        }
      },
      required: ['name', 'mobile', 'category']
    }
  },
  {
    name: 'raise_ticket',
    description: 'Open a new support ticket for the treasurer.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['billing', 'collection', 'receipt_pdf', 'import_subscribers', 'other'], description: 'Default to "other" if the user\'s issue doesn\'t clearly match one of the specific categories.' },
        description: { type: 'string', description: "A short description of the issue, in the user's own words." }
      },
      required: ['category', 'description']
    }
  },
  {
    name: 'set_currency',
    description: "Change the account's collection currency.",
    input_schema: {
      type: 'object',
      properties: {
        currency: { type: 'string', enum: ['INR', 'USD', 'GBP', 'EUR', 'AUD', 'CAD', 'SGD', 'AED', 'NZD', 'CHF', 'ZAR', 'MYR', 'SAR', 'HKD'] }
      },
      required: ['currency']
    }
  },
  {
    name: 'edit_subscriber',
    description: "Update an existing subscriber's mobile number or name.",
    input_schema: {
      type: 'object',
      properties: {
        subscriberName: { type: 'string', description: "The subscriber's current name or mobile number, to look them up." },
        name: { type: 'string', description: 'New name, only if the user wants it changed.' },
        mobile: { type: 'string', description: 'New mobile number, only if the user wants it changed.' }
      },
      required: ['subscriberName']
    }
  },
  {
    name: 'reopen_ticket',
    description: "Reopen the account's most recently solved support ticket. Takes no parameters.",
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'report_query',
    description: 'Answer a read-only question from data already loaded in the dashboard — never writes anything.',
    input_schema: {
      type: 'object',
      properties: {
        metric: {
          type: 'string',
          enum: ['total_collected', 'pending_subscribers', 'subscriber_due', 'active_goals', 'subscriber_count', 'current_plan'],
          description: 'Which report to run.'
        },
        period: { type: 'string', enum: ['all', 'month'], description: 'Only for total_collected — defaults to "all" if omitted.' },
        subscriberName: { type: 'string', description: 'Only for subscriber_due — the subscriber to look up.' }
      },
      required: ['metric']
    }
  }
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

router.post('/assistant-chat', rateLimit(20, 60 * 1000), requireProOrStaffToken, async (req, res) => {
  const { message, history } = req.body;

  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  if (message.length > MAX_MESSAGE_LEN) {
    return res.status(400).json({ error: 'message is too long' });
  }

  const priorTurns = Array.isArray(history)
    ? history
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim() && m.content.length <= MAX_MESSAGE_LEN)
        .slice(-MAX_HISTORY_TURNS)
        .map(m => ({ role: m.role, content: m.content }))
    : [];

  // Try the free local parser first, on every request, key or no key.
  const local = parseLocalIntent(message.trim(), priorTurns);
  if (local.handled || !process.env.ANTHROPIC_API_KEY) {
    const responseBody = { success: true, reply: local.reply };
    if (local.action) responseBody.action = local.action;
    return res.json(responseBody);
  }

  // Local parser wasn't confident this is a known pattern — escalate to Claude.
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
        tools: TOOLS,
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Assistant API error:', data?.error || data);
      return res.status(502).json({ error: 'The assistant is temporarily unavailable. Please try again.' });
    }

    const blocks = Array.isArray(data.content) ? data.content : [];
    const reply = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('').trim();
    const toolUse = blocks.find(b => b.type === 'tool_use' && TOOL_NAMES.has(b.name));

    const responseBody = { success: true, reply };
    if (toolUse) {
      responseBody.action = { type: toolUse.name, params: toolUse.input || {} };
    } else if (!reply) {
      responseBody.reply = "Sorry, I couldn't come up with an answer to that.";
    }

    res.json(responseBody);
  } catch (err) {
    console.error('Assistant request failed:', err.message);
    res.status(502).json({ error: 'The assistant is temporarily unavailable. Please try again.' });
  }
});

module.exports = router;

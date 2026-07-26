const express = require('express');
require('dotenv').config();

const { requireProOrStaffToken } = require('../../middleware/auth');
const { rateLimit } = require('../../middleware/rateLimit');
const { parseLocalIntent } = require('../../utils/assistantLocalIntent');
const supabase = require('../../lib/supabase');

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
- link_payee_category / unlink_payee_category: associates or removes a payee's link to a spending category.
- update_profile: updates the account's type (individual/organization), category, and/or currency.
- add_staff: adds a new staff account with limited access.
- toggle_staff: enables or disables an existing staff account.
- create_payment_link: generates a shareable payment link for a subscriber, optionally for a specific goal.
- send_whatsapp_reminders: sends bulk WhatsApp payment reminders, either to everyone with a pending due or for one specific goal.
- download_receipt: re-downloads the receipt PDF for a subscriber's already-recorded payment on a goal.
- report_query: answers a read-only question from data already loaded (totals, dues, counts, plan info) — never a write.

Rules for each tool:
- create_goal: you must know whether it's monthly, yearly, or a one-off/event pledge. If the user didn't say, ASK them first in plain text — never assume "event" or any other default.
- collect_payment: you need a subscriber name (or mobile number) and an amount. If the user also names a specific goal, include goalName; if they don't mention one, simply omit goalName from the tool call — the app will show them their list of dues to pick from, so you must NOT ask which goal yourself or guess one.
- add_subscriber: you need a name and mobile number. If the user doesn't also mention a goal, ask them once in plain text whether to just add the subscriber, or also subscribe them to a specific goal right away, and wait for their answer before calling the tool. If they do want them subscribed to a goal, you also need the amount that subscriber specifically owes per period for that goal — ask for it if not given, and never guess it or default to the goal's own target amount (a subscriber's due is per-person and usually different from the goal's overall target, which is also frequently unset).
- subscribe_to_goal: needs a subscriber name, a goal name, AND the amount that subscriber specifically owes per period for that goal. This amount is never optional and must never default to the goal's own target amount — always ask if the user didn't state it.
- create_pledge: needs a subscriber name, goal name, and amount.
- mark_goal_complete / stop_rollover: need only the goal name.
- add_expense: needs an amount and a category from this exact list: Utility Bills, Staff Salaries, Maintenance, Cleaning, Office Expenses, Event Expenses, Construction & Renovation, Equipment Purchases, Charity Payments, Miscellaneous. Ask if the user's wording doesn't clearly match one of these.
- add_payee: needs a name, mobile number, and a category from that same list.
- raise_ticket: needs a category (one of: billing, collection, receipt_pdf, import_subscribers, other — default to "other" if unclear, this one is low-stakes) and a short description.
- reopen_ticket: no parameters — always reopens the account's own last solved ticket. Never ask which ticket; there is only ever one target.
- set_currency: needs a currency from: INR, USD, GBP, EUR, AUD, CAD, SGD, AED, NZD, CHF, ZAR, MYR, SAR, HKD.
- edit_subscriber: needs a subscriber name (to look them up) and at least one of a new mobile number or a new name. Ask for whichever is missing.
- link_payee_category / unlink_payee_category: needs a payee name and a category. A payee can have multiple categories, so linking and unlinking are separate tools.
- update_profile: any of accountType (individual/organization), category, or currency — whichever the user wants changed. All are optional in a single call; omit fields the user didn't mention (the app fills those in from the current value), but never call this tool with all three omitted.
- add_staff: needs a name and email address; mobile number is optional (ask once, and proceed without it if the user has none to give). Never ask the user for a password — the app generates one automatically.
- toggle_staff: needs the staff member's name and whether to enable or disable them.
- create_payment_link: needs a subscriber name; goalName is optional (omit if the user didn't mention a specific goal).
- send_whatsapp_reminders: goalName is optional — omit it entirely to mean "everyone with a pending due" (the app's own "remind all" convention); include it only if the user named a specific goal.
- download_receipt: needs a subscriber name and a goal name — this only re-downloads a receipt for a payment that was already recorded, never creates one.
- report_query: needs a metric — one of: total_collected (optionally scoped to "month"), pending_subscribers, subscriber_due (needs subscriberName), active_goals, subscriber_count, current_plan. Pick the metric that matches what the user asked; never guess a subscriber name for subscriber_due.
- Never guess a name, amount, or category the user didn't say — ask a short clarifying question in plain text instead of calling a tool with incomplete information (except raise_ticket's category, which may default to "other").

You must NEVER delete, remove, cancel, or unsubscribe anything — there is no tool for it and you are not authorized to perform destructive actions. If asked to delete/remove/cancel/unsubscribe something, say plainly that you can't do that yourself (it always needs a manual click in the dashboard as a safety measure), and explain the manual steps instead.

You have NO direct access to this account's actual data — no list of contributors, goals, payments, or balances. The ONLY way to state a real number, name, date, or amount from their account is by calling report_query with one of its six metrics (total_collected, pending_subscribers, subscriber_due, active_goals, subscriber_count, current_plan) — that tool's result is filled in separately by the app, not shown to you. NEVER state a specific figure or fact about their account from memory or by estimating — that is always a guess, not a real answer, even if it sounds plausible. If a data question doesn't fit one of those six metrics (e.g. "who's my top donor this year", "what did Ramesh pay last month"), say plainly that you don't have that specific report yet and point them to the relevant dashboard section (Subscriber Details, Pending, Accounting, etc.) instead of guessing a number.

You can ONLY perform the actions listed under "You can perform these actions directly using tools" above. If asked for anything else with no matching tool, say plainly that the assistant doesn't support that action yet, and briefly point to the relevant sidebar section for doing it manually — never claim to have done it, and never improvise by calling a different tool that doesn't actually match what was asked.

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
- When you call a tool, you may also include a short confirmation-style text reply (e.g. "Sure, here's what I'll create:") but keep it brief — the app will show the exact details separately.
- If you are not confident what the user is asking for, ask a short clarifying question rather than picking a tool or an answer that might be wrong — a wrong guess that changes their data or misinforms them is worse than one extra question.`;

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
        goalName: { type: 'string', description: 'Optional — only include if the user wants them subscribed to a specific goal right away.' },
        amount: { type: 'number', description: "Required whenever goalName is included — the amount this specific subscriber owes per period for that goal. Never the goal's own target amount; ask if not stated." }
      },
      required: ['name', 'mobile']
    }
  },
  {
    name: 'subscribe_to_goal',
    description: 'Subscribe an existing subscriber to an existing goal, at a specific per-period amount.',
    input_schema: {
      type: 'object',
      properties: {
        subscriberName: { type: 'string', description: "The subscriber's name or mobile number." },
        goalName: { type: 'string', description: 'The goal to subscribe them to.' },
        amount: { type: 'number', description: "The amount this specific subscriber owes per period for this goal. Never the goal's own target amount — always ask if the user didn't state it." }
      },
      required: ['subscriberName', 'goalName', 'amount']
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
    name: 'link_payee_category',
    description: 'Link an existing payee to a spending category. A payee can have multiple categories.',
    input_schema: {
      type: 'object',
      properties: {
        payeeName: { type: 'string', description: "The payee's name." },
        category: { type: 'string', description: 'The category to link them to.' }
      },
      required: ['payeeName', 'category']
    }
  },
  {
    name: 'unlink_payee_category',
    description: 'Remove an existing link between a payee and a spending category.',
    input_schema: {
      type: 'object',
      properties: {
        payeeName: { type: 'string', description: "The payee's name." },
        category: { type: 'string', description: 'The category to unlink them from.' }
      },
      required: ['payeeName', 'category']
    }
  },
  {
    name: 'update_profile',
    description: "Update the account's type (individual/organization), category, and/or currency.",
    input_schema: {
      type: 'object',
      properties: {
        accountType: { type: 'string', enum: ['individual', 'organization'], description: 'Only if the user wants this changed.' },
        category: { type: 'string', description: 'Only if the user wants this changed.' },
        currency: { type: 'string', enum: ['INR', 'USD', 'GBP', 'EUR', 'AUD', 'CAD', 'SGD', 'AED', 'NZD', 'CHF', 'ZAR', 'MYR', 'SAR', 'HKD'], description: 'Only if the user wants this changed.' }
      }
    }
  },
  {
    name: 'add_staff',
    description: 'Add a new staff account with limited dashboard access. Never ask the user for a password — one is generated automatically.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "The new staff member's name." },
        email: { type: 'string', description: "The new staff member's email address." },
        mobile: { type: 'string', description: 'Optional mobile number.' }
      },
      required: ['name', 'email']
    }
  },
  {
    name: 'toggle_staff',
    description: 'Enable or disable an existing staff account.',
    input_schema: {
      type: 'object',
      properties: {
        staffName: { type: 'string', description: "The staff member's name." },
        enable: { type: 'boolean', description: 'true to enable, false to disable.' }
      },
      required: ['staffName', 'enable']
    }
  },
  {
    name: 'create_payment_link',
    description: 'Generate a shareable payment link for a subscriber, optionally scoped to one goal.',
    input_schema: {
      type: 'object',
      properties: {
        subscriberName: { type: 'string', description: "The subscriber's name or mobile number." },
        goalName: { type: 'string', description: 'Optional — only if the user named a specific goal.' }
      },
      required: ['subscriberName']
    }
  },
  {
    name: 'send_whatsapp_reminders',
    description: 'Send bulk WhatsApp payment reminders — to everyone with a pending due, or for one specific goal.',
    input_schema: {
      type: 'object',
      properties: {
        goalName: { type: 'string', description: 'Optional — omit entirely to mean "everyone with a pending due".' }
      }
    }
  },
  {
    name: 'download_receipt',
    description: "Re-download the receipt PDF for a subscriber's already-recorded payment on a goal. Never creates a new payment.",
    input_schema: {
      type: 'object',
      properties: {
        subscriberName: { type: 'string', description: "The subscriber's name or mobile number." },
        goalName: { type: 'string', description: 'The goal this payment was recorded against.' }
      },
      required: ['subscriberName', 'goalName']
    }
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

// Every message the local parser doesn't recognize is logged here — a
// durable, queryable record of what's actually reaching (or would reach)
// Claude, so recurring phrasings can be spotted and turned into new
// predefined local-parser tasks over time, rather than paying to escalate
// the same kind of question indefinitely. Best-effort only: never blocks
// or fails the actual assistant response.
//
// assistantReply/actionType/actionParams capture what Claude actually did
// with the message (its text reply, and any tool it called) — not just
// what was asked. Reviewing these together is what makes it possible to
// judge whether Claude's interpretation was actually right before turning
// a recurring phrasing into a new local-parser task, rather than only
// seeing the raw question with no idea how well it was already handled.
async function logEscalation(userId, message, hadApiKey, assistantReply, actionType, actionParams) {
  try {
    const { error } = await supabase.from('assistant_escalations').insert([{
      user_id: userId, message, had_api_key: hadApiKey,
      assistant_reply: assistantReply || null,
      action_type: actionType || null,
      action_params: actionParams || null
    }]);
    if (error) console.warn('[escalation-log] insert skipped:', error.message);
  } catch (err) {
    console.warn('[escalation-log] insert threw:', err?.message || err);
  }
}

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
  if (local.handled) {
    const responseBody = { success: true, reply: local.reply };
    if (local.action) responseBody.action = local.action;
    return res.json(responseBody);
  }

  // Normally the current message itself, but the goal-fallback menu's
  // "something else" option overrides this to the ORIGINAL question that
  // triggered the menu — Claude needs that, not the user's bare menu pick
  // ("5"), which means nothing without the question it was answering.
  const escalationText = (typeof local.escalateMessage === 'string' && local.escalateMessage.trim())
    ? local.escalateMessage.trim() : message.trim();

  if (!process.env.ANTHROPIC_API_KEY) {
    // Logged whether or not a key is configured — a message the local
    // parser doesn't recognize is a candidate for a new predefined task
    // either way, not just when it actually reaches Claude. No reply/action
    // to record here since Claude was never called.
    logEscalation(req.proUserId, escalationText, false);
    return res.json({ success: true, reply: local.reply });
  }

  // Local parser wasn't confident this is a known pattern — escalate to Claude.
  const messages = [...priorTurns, { role: 'user', content: escalationText }];

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
        // Cached: this system prompt + the tool list are identical on every
        // request (same account, same code) — caching the last system block
        // covers both (render order is tools -> system -> messages). 1-hour
        // TTL (not the 5-minute default) because real usage here is a
        // treasurer asking occasional questions minutes apart while working
        // through the dashboard, not rapid-fire messages — the 5-minute
        // window mostly expired before a second question ever landed.
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
        tools: TOOLS,
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Assistant API error:', data?.error || data);
      logEscalation(req.proUserId, escalationText, true);
      return res.status(502).json({ error: 'The assistant is temporarily unavailable. Please try again.' });
    }

    // Cheap visibility into whether prompt caching is actually landing —
    // cache_read_input_tokens staying 0 across back-to-back requests within
    // the same 5-minute window means something is invalidating the cache.
    if (data.usage) {
      console.log('Assistant usage:', {
        input: data.usage.input_tokens,
        cache_write: data.usage.cache_creation_input_tokens || 0,
        cache_read: data.usage.cache_read_input_tokens || 0,
        output: data.usage.output_tokens
      });
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

    logEscalation(
      req.proUserId, escalationText, true,
      responseBody.reply, toolUse?.name, toolUse?.input
    );

    res.json(responseBody);
  } catch (err) {
    console.error('Assistant request failed:', err.message);
    logEscalation(req.proUserId, escalationText, true);
    res.status(502).json({ error: 'The assistant is temporarily unavailable. Please try again.' });
  }
});

module.exports = router;

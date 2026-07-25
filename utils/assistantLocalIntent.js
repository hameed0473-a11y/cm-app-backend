// ---------------------------------------------------------------
// LOCAL (NO-AI) INTENT PARSER — tried first on every message, before any
// call to Claude. If it confidently recognizes a known pattern (one of
// the predefined actions, a delete/remove refusal, or a FAQ topic) it
// returns { handled: true, ... } and the caller never touches the AI at
// all — free, and consistent regardless of whether ANTHROPIC_API_KEY is
// set. Only a genuinely unrecognized message returns { handled: false },
// which is the ONLY case routes/web/assistant.js escalates to Claude (and
// only if a key is configured) — this is the "predefined tasks are free,
// only hard questions cost anything" hybrid design.
//
// It intentionally does NOT try to be a real NLU engine — it only
// recognizes a handful of canonical phrasings ("create a goal named X",
// "collect 500 from X for Y") plus a small FAQ. Anything else falls
// through to a message explaining what it currently understands.
// ---------------------------------------------------------------

const AMOUNT_RE = /(?:target|amount)\s*(?:of)?\s*(?:rs\.?|inr|₹|\$)?\s*(\d+(?:\.\d+)?)|(?:₹|\$|rs\.?)\s*(\d+(?:\.\d+)?)/i;

function extractAmount(msg) {
  const m = msg.match(AMOUNT_RE);
  if (!m) return 0;
  return Number(m[1] || m[2]) || 0;
}

// No default here on purpose — a missing/unclear category means the AI
// (local or Claude) must ask, never silently assume "event".
function extractCategory(msg) {
  if (/\bmonthly\b/i.test(msg)) return 'monthly';
  if (/\byearly\b|\bannual(?:ly)?\b/i.test(msg)) return 'yearly';
  if (/\bevent\b|\bone[- ]?off\b|\bpledge\b/i.test(msg)) return 'event';
  return null;
}

function extractGoalName(msg) {
  let m = msg.match(/(?:named|called)\s+["“]?([^"”]+?)["”]?(?=\s+(?:with\b|target\b|for\b|monthly\b|yearly\b|event\b)|[.?!]*$)/i);
  if (m) return m[1].trim();
  m = msg.match(/\bgoal\b\s+["“]?([a-z0-9][a-z0-9 &'-]*?)["”]?(?=\s+(?:with\b|target\b|for\b|monthly\b|yearly\b|event\b)|[.?!]*$)/i);
  if (m) return m[1].trim();
  return '';
}

function parseCollectPayment(msg) {
  // "collect 500 from Ramesh for Diwali Fund"
  let m = msg.match(/(?:collect(?:ed)?|record(?:ed)?|received)\s+(?:rs\.?|inr|₹|\$)?\s*(\d+(?:\.\d+)?)\s+from\s+([a-z0-9 .'-]+?)\s+for\s+([a-z0-9 &.'-]+?)[.?!]*$/i);
  if (m) return { amount: Number(m[1]) || 0, subscriberName: m[2].trim(), goalName: m[3].trim() };

  // "collect 500 from Ramesh" (goal not stated — the app will show a dues list to pick from)
  m = msg.match(/(?:collect(?:ed)?|record(?:ed)?|received)\s+(?:rs\.?|inr|₹|\$)?\s*(\d+(?:\.\d+)?)\s+from\s+([a-z0-9 .'-]+?)[.?!]*$/i);
  if (m) return { amount: Number(m[1]) || 0, subscriberName: m[2].trim(), goalName: '' };

  return null;
}

function extractNameMobile(msg) {
  const mobileMatch = msg.match(/\b(\d{6,15})\b/);
  const mobile = mobileMatch ? mobileMatch[1] : '';
  let name = '';
  let m = msg.match(/(?:named|call(?:ed)?)\s+["“]?([a-z][a-z .'-]*?)["”]?(?=,|\s+mobile\b|\s+number\b|\s+\d|[.?!]*$)/i);
  if (m) name = m[1].trim();
  if (!name) {
    m = msg.match(/\b(?:subscriber|contributor)\b\s+["“]?([a-z][a-z .'-]*?)["”]?(?=,|\s+mobile\b|\s+number\b|\s+\d|[.?!]*$)/i);
    if (m) name = m[1].trim();
  }
  return { name, mobile };
}

function extractGoalMention(msg) {
  const m = msg.match(/\b(?:to|for|in)\s+(?:the\s+)?(?:goal\s+)?["“]?([a-z0-9][a-z0-9 &'-]*?)["”]?(?:\s+goal)?[.?!]*$/i);
  return m ? m[1].trim() : '';
}

const ADD_SUBSCRIBER_CLARIFY_RE = /general subscriber only, or also subscribe them to a specific goal/i;

// Handles both "add a subscriber named X, mobile Y [to Goal]" in one shot,
// and the two-turn version where we asked "just add, or also subscribe to a
// goal?" and this message is the answer — recovered by re-reading the prior
// user turn (which had the name/mobile) out of the conversation history.
function parseAddSubscriber(msg, history) {
  const wantsAdd = /\b(add|create|register)\b/i.test(msg) && /\b(subscriber|contributor)\b/i.test(msg);
  if (wantsAdd) {
    const { name, mobile } = extractNameMobile(msg);
    if (!name) return { reply: 'What\'s the subscriber\'s name? Try: "add a subscriber named Priya, mobile 9876543210".', handled: true };
    if (!mobile) return { reply: `What's ${name}'s mobile number?`, handled: true };

    const goalName = extractGoalMention(msg);
    if (goalName) {
      return { reply: '[Test mode] Here\'s what I understood:', action: { type: 'add_subscriber', params: { name, mobile, goalName } }, handled: true };
    }
    return {
      reply: `Got it — should I add ${name} as a general subscriber only, or also subscribe them to a specific goal right away? Reply "just add" or say the goal name.`,
      handled: true
    };
  }

  // Only look at the single most recent assistant turn — if that wasn't our
  // clarifying question, this message isn't a reply to it.
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== 'assistant') continue;
    if (!ADD_SUBSCRIBER_CLARIFY_RE.test(history[i].content)) return null;
    const priorUser = history[i - 1];
    if (!priorUser || priorUser.role !== 'user') return null;
    const { name, mobile } = extractNameMobile(priorUser.content);
    if (!name || !mobile) return null;

    if (/^\s*(just add|no goal|no thanks?|general only|none|no)\s*[.?!]*$/i.test(msg)) {
      return { reply: '[Test mode] Here\'s what I understood:', action: { type: 'add_subscriber', params: { name, mobile } }, handled: true };
    }
    return { reply: '[Test mode] Here\'s what I understood:', action: { type: 'add_subscriber', params: { name, mobile, goalName: msg.trim() } }, handled: true };
  }

  return null;
}

// ---------------------------------------------------------------
// SAFETY GATE — delete/remove/unsubscribe is never AI-executable, in
// test mode or with a real key, no exceptions. Checked before anything
// else so it can never be shadowed by a create/collect/add match, and
// there is deliberately no delete-type tool defined anywhere for Claude
// to call either (see routes/web/assistant.js).
// ---------------------------------------------------------------
const DELETE_STEPS = {
  goal: 'Sidebar -> Goals and Pledges -> open the goal -> Delete. (If it just needs closing rather than deleting, use "Mark Complete" instead.)',
  subscriber: 'Sidebar -> Subscribers -> select the subscriber -> Delete.',
  payment: 'Open the goal or Subscriber Details, find the payment in the list, and use its delete option.',
  expense: 'Sidebar -> Accounting -> Expenses -> find the expense -> Delete.',
  payee: 'Sidebar -> Accounting -> Payees -> select the payee -> Delete.',
  subscription: 'Open the goal, find the subscriber under it, and use "Unsubscribe" / "Remove from goal".',
  staff: 'Sidebar -> Staff -> find the staff account -> Remove.',
  integration: 'Sidebar -> Integrations -> open the connected provider -> Disconnect/Remove.'
};

function detectDeleteTarget(msg) {
  if (/\bstaff\b/i.test(msg)) return 'staff';
  if (/\bintegration\b|\brazorpay\b|\bstripe\b|\bwhatsapp\b/i.test(msg)) return 'integration';
  if (/\bpayee\b/i.test(msg)) return 'payee';
  if (/\bexpense\b/i.test(msg)) return 'expense';
  if (/\bpayment\b|\breceipt\b/i.test(msg)) return 'payment';
  if (/\bunsubscribe\b/i.test(msg)) return 'subscription';
  if (/\bgoal\b/i.test(msg) && /\bfrom\b/i.test(msg)) return 'subscription';
  if (/\bgoal\b/i.test(msg)) return 'goal';
  if (/\bsubscriber\b|\bcontributor\b/i.test(msg)) return 'subscriber';
  return null;
}

function handleDeleteIntent(msg) {
  const target = detectDeleteTarget(msg);
  const steps = target ? DELETE_STEPS[target] : 'open the relevant section from the sidebar and use its Delete/Remove option there.';
  return {
    reply: `I'm not authorized to delete or remove anything myself — that always needs a manual click in the dashboard as a safety measure. Here's how: ${steps}`,
    handled: true
  };
}

const FAQ = [
  {
    test: /razorpay|stripe|payment gateway|bank account|link.*(bank|gateway)/i,
    reply: 'Sidebar -> Integrations -> Payment Gateways -> choose Razorpay (India, INR) or Stripe, then follow the on-screen steps to paste your keys and webhook secret. Start with test keys before going live.'
  },
  {
    test: /whatsapp/i,
    reply: 'Sidebar -> Integrations -> WhatsApp tab -> connect it to send payment reminders and receipts in bulk.'
  },
  {
    test: /import/i,
    reply: 'Sidebar -> Subscribers (or Goals, or Accounting) -> "Import from Excel" -> upload your sheet. This is a file-upload flow, so I can\'t do it for you by voice, but I can walk you through the column format if you\'d like.'
  },
  {
    test: /goal/i,
    reply: 'Sidebar -> "Goals and Pledges" -> "New Goal" (monthly/yearly) or "New Pledge Goal" (one-off) -> enter a name and optional target -> Create. Or just say "create a goal named ..." and I\'ll do it for you.'
  },
  {
    test: /payment|due|pending/i,
    reply: 'Open the relevant goal or subscriber (or the Pending tab) -> "Collect Payment" -> enter the amount -> Save. Or say "collect 500 from <name> for <goal>" and I\'ll do it for you.'
  }
];

const FALLBACK_REPLY = 'Test mode (no AI key set yet): I can currently handle "create a goal named X", "collect 500 from <name> for <goal>", and "add a subscriber named X, mobile Y", plus basic questions about goals, payments, subscribers, and integrations. Add ANTHROPIC_API_KEY on the backend to unlock full understanding.';

function parseLocalIntent(message, history) {
  const msg = message.trim();
  const safeHistory = Array.isArray(history) ? history : [];

  if (/\b(delete|remove|unsubscribe)\b/i.test(msg)) {
    return handleDeleteIntent(msg);
  }

  const addSubscriberResult = parseAddSubscriber(msg, safeHistory);
  if (addSubscriberResult) return addSubscriberResult;

  const wantsCollect = /\b(collect(?:ed)?|record(?:ed)?|received)\b/i.test(msg) && /\bfrom\b/i.test(msg);
  if (wantsCollect) {
    const parsed = parseCollectPayment(msg);
    if (!parsed || !parsed.amount) {
      return { reply: 'I didn\'t catch the amount. Try: "collect 500 from Ramesh for Diwali Fund".', handled: true };
    }
    if (!parsed.subscriberName) {
      return { reply: 'Who should I collect this from? Try: "collect 500 from Ramesh for Diwali Fund".', handled: true };
    }
    // goalName may be empty here on purpose — the app will show the
    // subscriber's list of dues to pick from instead of guessing.
    return { reply: '[Test mode] Here\'s what I understood:', action: { type: 'collect_payment', params: parsed }, handled: true };
  }

  const wantsCreateGoal = /\b(create|add|start|set ?up)\b/i.test(msg) && /\b(goal|target|fund|pledge)\b/i.test(msg);
  if (wantsCreateGoal) {
    const name = extractGoalName(msg);
    if (!name) {
      return { reply: 'What should the goal be named? Try: "create a goal named Diwali Fund".', handled: true };
    }
    const category = extractCategory(msg);
    if (!category) {
      return { reply: `What type of goal is "${name}" — monthly, yearly, or a one-off/event pledge?`, handled: true };
    }
    return {
      reply: '[Test mode] Here\'s what I understood:',
      action: { type: 'create_goal', params: { name, category, targetAmount: extractAmount(msg) } },
      handled: true
    };
  }

  const faqHit = FAQ.find(item => item.test.test(msg));
  if (faqHit) return { reply: faqHit.reply, handled: true };

  return { reply: FALLBACK_REPLY, handled: false };
}

module.exports = { parseLocalIntent };

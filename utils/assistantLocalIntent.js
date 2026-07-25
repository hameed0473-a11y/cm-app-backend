// ---------------------------------------------------------------
// LOCAL (NO-AI) INTENT PARSER — a free stand-in for the Anthropic call,
// used automatically whenever ANTHROPIC_API_KEY isn't set. Pattern-matches
// a small, fixed set of known phrasings into the exact same
// {type, params} action shape the real AI would return via tool-calling,
// so the whole confirmation-card -> create-goal/collect-payment flow can
// be tested end-to-end without any billing. The moment a real API key is
// set, routes/web/assistant.js stops calling this and uses Claude instead
// — nothing else needs to change.
//
// This intentionally does NOT try to be a real NLU engine — it only
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

function extractCategory(msg) {
  if (/\bmonthly\b/i.test(msg)) return 'monthly';
  if (/\byearly\b|\bannual(?:ly)?\b/i.test(msg)) return 'yearly';
  return 'event';
}

function extractGoalName(msg) {
  let m = msg.match(/(?:named|called)\s+["“]?([^"”]+?)["”]?(?=\s+(?:with\b|target\b|for\b|monthly\b|yearly\b|event\b)|[.?!]*$)/i);
  if (m) return m[1].trim();
  m = msg.match(/\bgoal\b\s+["“]?([a-z0-9][a-z0-9 &'-]*?)["”]?(?=\s+(?:with\b|target\b|for\b|monthly\b|yearly\b|event\b)|[.?!]*$)/i);
  if (m) return m[1].trim();
  return '';
}

function parseCollectPayment(msg) {
  let m = msg.match(/(?:collect(?:ed)?|record(?:ed)?|received)\s+(?:rs\.?|inr|₹|\$)?\s*(\d+(?:\.\d+)?)\s+from\s+([a-z0-9 .'-]+?)\s+for\s+([a-z0-9 &.'-]+?)[.?!]*$/i);
  if (m) return { amount: Number(m[1]) || 0, subscriberName: m[2].trim(), goalName: m[3].trim() };

  m = msg.match(/(?:collect(?:ed)?|record(?:ed)?|received)\s+(?:rs\.?|inr|₹|\$)?\s*(\d+(?:\.\d+)?)\s+from\s+([a-z0-9 .'-]+?)[.?!]*$/i);
  if (m) return { amount: Number(m[1]) || 0, subscriberName: m[2].trim(), goalName: '' };

  return null;
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
    test: /add.*(subscriber|contributor)/i,
    reply: 'Sidebar -> Subscribers -> add a contributor with name and mobile number, then open a goal and use "Add Subscribers" to subscribe them.'
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

const FALLBACK_REPLY = 'Test mode (no AI key set yet): I can currently handle "create a goal named X" and "collect 500 from <name> for <goal>", plus basic questions about goals, payments, subscribers, and integrations. Add ANTHROPIC_API_KEY on the backend to unlock full understanding.';

function parseLocalIntent(message) {
  const msg = message.trim();

  const wantsCollect = /\b(collect(?:ed)?|record(?:ed)?|received)\b/i.test(msg) && /\bfrom\b/i.test(msg);
  if (wantsCollect) {
    const parsed = parseCollectPayment(msg);
    if (!parsed || !parsed.amount) {
      return { reply: 'I didn\'t catch the amount. Try: "collect 500 from Ramesh for Diwali Fund".' };
    }
    if (!parsed.subscriberName) {
      return { reply: 'Who should I collect this from? Try: "collect 500 from Ramesh for Diwali Fund".' };
    }
    if (!parsed.goalName) {
      return { reply: `Which goal is this for? Try: "collect ${parsed.amount} from ${parsed.subscriberName} for <goal name>".` };
    }
    return { reply: '[Test mode] Here\'s what I understood:', action: { type: 'collect_payment', params: parsed } };
  }

  const wantsCreateGoal = /\b(create|add|start|set ?up)\b/i.test(msg) && /\b(goal|target|fund|pledge)\b/i.test(msg);
  if (wantsCreateGoal) {
    const name = extractGoalName(msg);
    if (!name) {
      return { reply: 'What should the goal be named? Try: "create a goal named Diwali Fund".' };
    }
    return {
      reply: '[Test mode] Here\'s what I understood:',
      action: { type: 'create_goal', params: { name, category: extractCategory(msg), targetAmount: extractAmount(msg) } }
    };
  }

  const faqHit = FAQ.find(item => item.test.test(msg));
  return { reply: faqHit ? faqHit.reply : FALLBACK_REPLY };
}

module.exports = { parseLocalIntent };

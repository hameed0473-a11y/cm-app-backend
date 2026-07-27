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
// recognizes a handful of canonical phrasings per action, plus a small
// FAQ. Anything else falls through to a message explaining what it
// currently understands.
// ---------------------------------------------------------------

// Keep in sync with the backend's own enums (routes/web/expenses.js,
// routes/web/tickets.js, lib/gateways.js) — duplicated here so the local
// parser can validate/resolve without an extra round trip.
const EXPENSE_CATEGORIES = ['Utility Bills', 'Staff Salaries', 'Maintenance', 'Cleaning', 'Office Expenses', 'Event Expenses', 'Construction & Renovation', 'Equipment Purchases', 'Charity Payments', 'Miscellaneous'];
const TICKET_CATEGORIES = ['billing', 'collection', 'receipt_pdf', 'import_subscribers', 'other'];
const SUPPORTED_CURRENCIES = ['INR', 'USD', 'GBP', 'EUR', 'AUD', 'CAD', 'SGD', 'AED', 'NZD', 'CHF', 'ZAR', 'MYR', 'SAR', 'HKD'];
const CURRENCY_WORDS = {
  dollars: 'USD', dollar: 'USD', rupees: 'INR', rupee: 'INR', pounds: 'GBP', pound: 'GBP',
  euros: 'EUR', euro: 'EUR', dirhams: 'AED', dirham: 'AED', ringgit: 'MYR', riyal: 'SAR',
  'hong kong dollar': 'HKD', 'singapore dollar': 'SGD', 'new zealand dollar': 'NZD',
  'australian dollar': 'AUD', 'canadian dollar': 'CAD', 'south african rand': 'ZAR', francs: 'CHF', franc: 'CHF'
};

const AMOUNT_RE = /(?:target|amount)\s*(?:of)?\s*(?:rs\.?|inr|₹|\$|£|€)?\s*(\d+(?:\.\d+)?)|(?:₹|\$|£|€|rs\.?)\s*(\d+(?:\.\d+)?)/i;

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

function parseCollectPayment(msg) {
  // "collect 500 from Ramesh for Diwali Fund"
  let m = msg.match(/(?:collect(?:ed)?|record(?:ed)?|received)\s+(?:rs\.?|inr|₹|\$|£|€)?\s*(\d+(?:\.\d+)?)\s+from\s+([a-z0-9 .'-]+?)\s+for\s+([a-z0-9 &.'-]+?)[.?!]*$/i);
  if (m) return { amount: Number(m[1]) || 0, subscriberName: m[2].trim(), goalName: m[3].trim() };

  // "collect 500 from Ramesh" (goal not stated — the app will show a dues list to pick from)
  m = msg.match(/(?:collect(?:ed)?|record(?:ed)?|received)\s+(?:rs\.?|inr|₹|\$|£|€)?\s*(\d+(?:\.\d+)?)\s+from\s+([a-z0-9 .'-]+?)[.?!]*$/i);
  if (m) return { amount: Number(m[1]) || 0, subscriberName: m[2].trim(), goalName: '' };

  return null;
}

function extractNameMobile(msg, keyword) {
  const mobileMatch = msg.match(/\b(\d{6,15})\b/);
  const mobile = mobileMatch ? mobileMatch[1] : '';
  let name = '';
  let m = msg.match(/(?:named|call(?:ed)?)\s+["“]?([a-z][a-z0-9 .'&-]*?)["”]?(?=,|\s+mobile\b|\s+number\b|\s+category\b|\s+\d|[.?!]*$)/i);
  if (m) name = m[1].trim();
  if (!name && keyword) {
    m = msg.match(new RegExp(`\\b${keyword}\\b\\s+["“]?([a-z][a-z0-9 .'&-]*?)["”]?(?=,|\\s+mobile\\b|\\s+number\\b|\\s+category\\b|\\s+\\d|[.?!]*$)`, 'i'));
    if (m) name = m[1].trim();
  }
  return { name, mobile };
}

// A subscriber's per-goal amount is the recurring due THEY are on the hook
// for each period, not the goal's own (often unset) overall target — so
// every place that subscribes someone to a goal must get this explicitly
// from the user, via "... at 500", never default or guess it. Strips a
// trailing "at <amount>" clause so the remaining text (goal name, etc.)
// parses cleanly, and reports whichever amount it found either way.
function stripTrailingAmount(msg) {
  const m = msg.match(/^(.*?)\s+\bat\s+(?:rs\.?|inr|₹|\$|£|€)?\s*(\d+(?:\.\d+)?)(?:\s*(?:per\s*(?:month|year|period))?)?[.?!]*$/i);
  if (m) return { rest: m[1].trim(), amount: Number(m[2]) || 0 };
  return { rest: msg, amount: extractAmount(msg) };
}

// For a follow-up turn that's expected to be *just* the amount (a reply to
// our own "how much should X pay?" question) — accepts a bare number, an
// "at <number>" reply, or a currency-prefixed one.
function extractBareOrAtAmount(msg) {
  const m = msg.trim().match(/^(?:at\s+)?(?:rs\.?|inr|₹|\$|£|€)?\s*(\d+(?:\.\d+)?)\s*(?:per\s*(?:month|year|period))?[.?!]*$/i);
  if (m) return Number(m[1]) || 0;
  return extractAmount(msg);
}

function matchExpenseCategory(text) {
  const norm = text.toLowerCase();
  const found = EXPENSE_CATEGORIES.find(c => norm.includes(c.toLowerCase()) || c.toLowerCase().includes(norm.trim()));
  return found || null;
}

function matchCurrency(text) {
  const norm = text.toLowerCase();
  for (const code of SUPPORTED_CURRENCIES) {
    if (norm.includes(code.toLowerCase())) return code;
  }
  for (const word of Object.keys(CURRENCY_WORDS)) {
    if (norm.includes(word)) return CURRENCY_WORDS[word];
  }
  return null;
}

// Loose "does this feel like a yes/no" check — kept generic (not tied to
// create_goal specifically) so any future confirm-first flow can reuse it.
// CANCEL_RE also catches "cancel"/"stop"/"back"/"exit" as ways to step back
// out of a pending multi-turn flow at any point, not just when directly
// answering a yes/no question. It's checked separately, and earlier (from
// parseLocalIntent, via cancelCreateGoalIfPending below), than the
// top-level delete/remove intent check would otherwise swallow "cancel".
const AFFIRMATIVE_RE = /^\s*(yes|yeah|yep|yup|correct|right|sure|ok(?:ay)?|confirm|go ahead|please do)\b/i;
const CANCEL_RE = /^\s*(no|nope|nah|never ?mind|don'?t|cancel|stop|back|exit|forget it)\b/i;
// A bare greeting with nothing else — answered locally (see parseLocalIntent)
// instead of spending a Claude call on "hi"/"hello" alone.
const GREETING_RE = /^\s*(hi+|hello+|hey+|hola|good\s?morning|good\s?afternoon|good\s?evening)\s*[.!]*$/i;

// The three questions the create-goal flow asks, in order — recognized on
// the assistant's own prior message so a short follow-up reply ("yes", a
// bare goal name, or "monthly") can be understood without repeating the
// whole request, same pattern as every other multi-turn flow in this file.
const CREATE_GOAL_CONFIRM_RE = /are you saying you'd like to create a new goal/i;
const CREATE_GOAL_NAME_RE = /^great — what should the goal be named\?$/i;
const CREATE_GOAL_TYPE_RE = /what type of goal is "([^"]+)"/i;

// Registry of every question regex belonging to a confirm-first multi-turn
// flow — each flow pushes its own step markers onto this array right after
// defining them. Used by cancelPendingFlowIfAny() below to let the user
// back out with "cancel"/"stop"/etc. at ANY step of ANY such flow, checked
// from the very top of parseLocalIntent before the delete/remove intent
// check would otherwise misread "cancel" as wanting to delete something.
const PENDING_FLOW_MARKERS = [CREATE_GOAL_CONFIRM_RE, CREATE_GOAL_NAME_RE, CREATE_GOAL_TYPE_RE];

// Separate, smaller registry for steps where a bare "no" is a normal answer
// to that specific question (not an abort) — e.g. "no goal, just add them"
// — so only stricter, unambiguous cancel wording backs out of those steps.
// Flows push their own such markers on right after defining them.
const STRICT_ABORT_RE = /^\s*(cancel|stop|never ?mind|forget it|exit|back)\b/i;
const PENDING_FLOW_STRICT_ABORT_MARKERS = [];

function cancelPendingFlowIfAny(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');
  if (!lastAssistant) return null;
  if (PENDING_FLOW_MARKERS.some(re => re.test(lastAssistant.content)) && CANCEL_RE.test(msg)) {
    return { reply: 'No problem — cancelled. Let me know if there\'s something else I can help with.', handled: true };
  }
  if (PENDING_FLOW_STRICT_ABORT_MARKERS.some(re => re.test(lastAssistant.content)) && STRICT_ABORT_RE.test(msg)) {
    return { reply: 'No problem — cancelled. Let me know if there\'s something else I can help with.', handled: true };
  }
  return null;
}

// A "how do I ..." / "how to ..." question about creating a goal is asking
// for an explanation, not asking us to actually create one — must not
// trigger the confirm-first flow below (it used to, since it also contains
// "create" + "goal").
const HOW_TO_RE = /\bhow\s+(?:do|does|can|to)\b/i;

// A fast-path regex capturing "whatever comes before/after a trigger word"
// can accidentally capture generic filler ("a goal", "the", "the goal")
// instead of a real name when the message was actually just the generic
// trigger phrase itself (e.g. "mark a goal complete", "complete the
// goal") — this catches that so it falls through to the step-by-step flow
// instead of proposing a bogus name.
const GENERIC_GOAL_WORDS_RE = /^(?:a|the|this|that|my|our|it)\s*(?:goal)?$/i;

// Keyword-driven, confirm-first flow: a message merely containing
// "create"/"add"/etc. + "goal"/"target"/"fund"/"pledge" is treated as a
// probable (not certain) request, so the very first thing we do is ask the
// user to confirm before assuming anything — cheap to correct if wrong,
// since nothing is proposed/created until they say yes twice more (goal
// name, then type) and finally confirm the actual create_goal action card.
function parseCreateGoal(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 4: answering "what type of goal is X — monthly, yearly, or pledge?"
  // (a "cancel"/"stop"/etc. reply here is already handled earlier, by
  // cancelPendingFlowIfAny in parseLocalIntent, before this is even reached)
  if (lastAssistant && CREATE_GOAL_TYPE_RE.test(lastAssistant.content)) {
    const name = lastAssistant.content.match(CREATE_GOAL_TYPE_RE)[1];
    const category = extractCategory(msg);
    if (!category) {
      return { reply: `Sorry, I didn't catch the type — is "${name}" a monthly goal, a yearly goal, or a one-off/event pledge?`, handled: true };
    }
    return {
      reply: 'Here\'s what I understood:',
      action: { type: 'create_goal', params: { name, category, targetAmount: 0 } },
      handled: true
    };
  }

  // Step 3: answering "what should the goal be named?" — usually just a
  // name, but also accepts the type in the same reply (e.g. "Water Fund,
  // monthly"), skipping straight to step 4's result in that case. Any
  // stray "target/amount/for <number>" clause is stripped out of the name
  // rather than kept as part of it (this flow only asks for name + type,
  // so a target amount mentioned here is simply not captured).
  if (lastAssistant && CREATE_GOAL_NAME_RE.test(lastAssistant.content)) {
    let name = msg.replace(/^(?:it'?s|its|name it|call it|named?)\s+/i, '').replace(/[.?!]+$/, '').trim();
    name = name.replace(/\s+(?:target|amount|for)\s*(?:of)?\s*(?:rs\.?|inr|₹|\$|£|€)?\s*\d+(?:\.\d+)?\s*$/i, '').trim();
    if (!name) return { reply: 'What should the goal be named?', handled: true };
    const category = extractCategory(name);
    if (category) {
      name = name.replace(/\b(monthly|yearly|annual(?:ly)?|event|one[- ]?off|pledge)\b/gi, '').replace(/[,\s]+$/, '').replace(/\s{2,}/g, ' ').trim();
      return {
        reply: 'Here\'s what I understood:',
        action: { type: 'create_goal', params: { name, category, targetAmount: 0 } },
        handled: true
      };
    }
    return { reply: `What type of goal is "${name}" — monthly, yearly, or a one-off/event pledge?`, handled: true };
  }

  // Step 2: answering "are you saying you'd like to create a new goal?"
  // ("cancel" is handled earlier by cancelPendingFlowIfAny; anything else
  // that isn't a recognizable "yes" just falls through to other intents)
  if (lastAssistant && CREATE_GOAL_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: 'Great — what should the goal be named?', handled: true };
  }

  // Step 1: first mention — a keyword hit only, nothing is assumed yet.
  // Skipped for "how do I .../how to ..." questions, which want an
  // explanation (see the FAQ below), not to actually create anything.
  const wantsCreateGoal = !HOW_TO_RE.test(msg)
    && /\b(create|add|start|set ?up|make)\b/i.test(msg) && /\b(goal|target|fund|pledge)\b/i.test(msg);
  if (wantsCreateGoal) {
    return { reply: 'Are you saying you\'d like to create a new goal?', handled: true };
  }

  return null;
}

// The steps this flow asks, in order. Each question embeds whatever it
// already knows (name, then also mobile, then also goal) directly in its
// own text — recovered from there rather than re-scanning history, same
// approach as create_goal's CREATE_GOAL_TYPE_RE.
const ADD_SUBSCRIBER_CONFIRM_RE = /are you saying you'd like to add a new subscriber/i;
const ADD_SUBSCRIBER_NAME_RE = /^great — what's the subscriber's name\?$/i;
const ADD_SUBSCRIBER_MOBILE_RE = /^what's (.+?)'s mobile number\?$/i;
const ADD_SUBSCRIBER_GOAL_OR_NOT_RE = /should i add (.+?) \(mobile (\d+)\) as a general subscriber only, or also subscribe them to a specific goal/i;
const ADD_SUBSCRIBER_AMOUNT_RE = /how much should (.+?) \(mobile (\d+)\) pay per period for "([^"]+)"/i;
// "no"/"no thanks"/etc. at the goal-or-not step means "no goal, just add
// them" — a normal answer to that specific question, not an abort — so
// that step goes in PENDING_FLOW_STRICT_ABORT_MARKERS (only unambiguous
// wording like "cancel"/"stop" backs out of it) rather than
// PENDING_FLOW_MARKERS (which would treat a bare "no" as an abort).
const ADD_SUBSCRIBER_SKIP_GOAL_RE = /^\s*(just add|no goal|no thanks?|general only|none|no)\s*[.?!]*$/i;

function goalOrNotQuestion(name, mobile) {
  return `Got it — should I add ${name} (mobile ${mobile}) as a general subscriber only, or also subscribe them to a specific goal right away? Reply "just add" or say the goal name and their per-period amount, e.g. "Diwali Fund at 500".`;
}

PENDING_FLOW_MARKERS.push(ADD_SUBSCRIBER_CONFIRM_RE, ADD_SUBSCRIBER_NAME_RE, ADD_SUBSCRIBER_MOBILE_RE, ADD_SUBSCRIBER_AMOUNT_RE);
PENDING_FLOW_STRICT_ABORT_MARKERS.push(ADD_SUBSCRIBER_GOAL_OR_NOT_RE);

// Keyword-driven, confirm-first flow, same pattern as parseCreateGoal:
// "add"/"create"/"register" + "subscriber"/"contributor" only starts with
// a yes/no check, then collects name -> mobile -> (optional goal + amount)
// one question at a time.
function parseAddSubscriber(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 6: answering "how much should X (mobile Y) pay per period for <goal>?"
  if (lastAssistant && ADD_SUBSCRIBER_AMOUNT_RE.test(lastAssistant.content)) {
    const [, name, mobile, goalName] = lastAssistant.content.match(ADD_SUBSCRIBER_AMOUNT_RE);
    const amount = extractBareOrAtAmount(msg);
    if (!amount) {
      return { reply: `How much should ${name} (mobile ${mobile}) pay per period for "${goalName}"? Reply e.g. "500".`, handled: true };
    }
    return { reply: 'Here\'s what I understood:', action: { type: 'add_subscriber', params: { name, mobile, goalName, amount } }, handled: true };
  }

  // Step 5: answering "just add, or also subscribe them to a goal?"
  // ("cancel"/"stop"/etc. here is already handled by cancelPendingFlowIfAny
  // in parseLocalIntent, before this is even reached)
  if (lastAssistant && ADD_SUBSCRIBER_GOAL_OR_NOT_RE.test(lastAssistant.content)) {
    const [, name, mobile] = lastAssistant.content.match(ADD_SUBSCRIBER_GOAL_OR_NOT_RE);
    if (ADD_SUBSCRIBER_SKIP_GOAL_RE.test(msg)) {
      return { reply: 'Here\'s what I understood:', action: { type: 'add_subscriber', params: { name, mobile } }, handled: true };
    }
    const { rest, amount } = stripTrailingAmount(msg);
    const goalName = rest.trim();
    if (!goalName) return { reply: goalOrNotQuestion(name, mobile), handled: true };
    if (!amount) {
      return { reply: `How much should ${name} (mobile ${mobile}) pay per period for "${goalName}"? Reply e.g. "${goalName} at 500".`, handled: true };
    }
    return { reply: 'Here\'s what I understood:', action: { type: 'add_subscriber', params: { name, mobile, goalName, amount } }, handled: true };
  }

  // Step 4: answering "what's X's mobile number?"
  if (lastAssistant && ADD_SUBSCRIBER_MOBILE_RE.test(lastAssistant.content)) {
    const name = lastAssistant.content.match(ADD_SUBSCRIBER_MOBILE_RE)[1];
    const mobileMatch = msg.match(/\b(\d{6,15})\b/);
    if (!mobileMatch) return { reply: `What's ${name}'s mobile number?`, handled: true };
    return { reply: goalOrNotQuestion(name, mobileMatch[1]), handled: true };
  }

  // Step 3: answering "what should the subscriber's name be?" — also
  // accepts the mobile number in the same reply (e.g. "Priya, 9876543210").
  if (lastAssistant && ADD_SUBSCRIBER_NAME_RE.test(lastAssistant.content)) {
    const mobileMatch = msg.match(/\b(\d{6,15})\b/);
    let name = msg.replace(/^(?:it'?s|its|name is|call(?:ed)?)\s+/i, '').replace(/[.?!]+$/, '').trim();
    if (mobileMatch) name = name.replace(mobileMatch[0], '').replace(/[,\s]+$/, '').trim();
    if (!name) return { reply: 'What\'s the subscriber\'s name?', handled: true };
    if (mobileMatch) return { reply: goalOrNotQuestion(name, mobileMatch[1]), handled: true };
    return { reply: `What's ${name}'s mobile number?`, handled: true };
  }

  // Step 2: answering "are you saying you'd like to add a new subscriber?"
  if (lastAssistant && ADD_SUBSCRIBER_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: 'Great — what\'s the subscriber\'s name?', handled: true };
  }

  // Step 1: first mention — a keyword hit only, nothing is assumed yet.
  const wantsAdd = !HOW_TO_RE.test(msg)
    && /\b(add|create|register)\b/i.test(msg) && /\b(subscriber|contributor)\b/i.test(msg);
  if (wantsAdd) {
    return { reply: 'Are you saying you\'d like to add a new subscriber?', handled: true };
  }

  return null;
}

const SUBSCRIBE_RE = /\bsubscribe\b\s+([a-z0-9 .'-]+?)\s+\bto\b\s+(?:the\s+)?(?:goal\s+)?["“]?([a-z0-9][a-z0-9 &'-]*?)["”]?(?:\s+goal)?[.?!]*$/i;

// Steps: confirm -> which subscriber -> which goal -> per-period amount.
// The fast path (SUBSCRIBE_RE matching in one shot, e.g. "subscribe Ramesh
// to Diwali Fund at 500") still works without any confirmation, same as
// before — the confirm-first flow only kicks in when "subscribe" is used
// without that exact shape. Deliberately keyed off the word "subscribe"
// only (not "add ... to ... goal") to avoid colliding with add_subscriber's
// own trigger words.
const SUBSCRIBE_CONFIRM_RE = /are you saying you'd like to subscribe someone to a goal/i;
const SUBSCRIBE_WHO_RE = /^great — who should i subscribe\?$/i;
const SUBSCRIBE_GOAL_RE = /^which goal should i subscribe (.+?) to\?$/i;
const SUBSCRIBE_AMOUNT_RE = /how much should (.+?) pay per period for "([^"]+)"/i;
PENDING_FLOW_MARKERS.push(SUBSCRIBE_CONFIRM_RE, SUBSCRIBE_WHO_RE, SUBSCRIBE_GOAL_RE, SUBSCRIBE_AMOUNT_RE);

function parseSubscribeToGoal(msg, history) {
  const { rest, amount: strippedAmount } = stripTrailingAmount(msg);
  const fastMatch = rest.match(SUBSCRIBE_RE) || msg.match(SUBSCRIBE_RE);
  if (fastMatch) {
    const subscriberName = fastMatch[1].trim();
    const goalName = fastMatch[2].trim();
    if (!strippedAmount) {
      return { reply: `How much should ${subscriberName} pay per period for "${goalName}"? Try: "subscribe ${subscriberName} to ${goalName} at 500".`, handled: true };
    }
    return {
      reply: 'Here\'s what I understood:',
      action: { type: 'subscribe_to_goal', params: { subscriberName, goalName, amount: strippedAmount } },
      handled: true
    };
  }

  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 4: answering "how much should X pay per period for <goal>?"
  if (lastAssistant && SUBSCRIBE_AMOUNT_RE.test(lastAssistant.content)) {
    const [, subscriberName, goalName] = lastAssistant.content.match(SUBSCRIBE_AMOUNT_RE);
    const amount = extractBareOrAtAmount(msg);
    if (!amount) return { reply: `How much should ${subscriberName} pay per period for "${goalName}"? Reply e.g. "500".`, handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'subscribe_to_goal', params: { subscriberName, goalName, amount } }, handled: true };
  }

  // Step 3: answering "which goal should I subscribe X to?"
  if (lastAssistant && SUBSCRIBE_GOAL_RE.test(lastAssistant.content)) {
    const subscriberName = lastAssistant.content.match(SUBSCRIBE_GOAL_RE)[1];
    const { rest: goalRest, amount } = stripTrailingAmount(msg);
    const goalName = goalRest.replace(/[.?!]+$/, '').trim();
    if (!goalName) return { reply: `Which goal should I subscribe ${subscriberName} to?`, handled: true };
    if (!amount) return { reply: `How much should ${subscriberName} pay per period for "${goalName}"? Reply e.g. "${goalName} at 500".`, handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'subscribe_to_goal', params: { subscriberName, goalName, amount } }, handled: true };
  }

  // Step 2: answering "who should I subscribe?"
  if (lastAssistant && SUBSCRIBE_WHO_RE.test(lastAssistant.content)) {
    const subscriberName = msg.replace(/[.?!]+$/, '').trim();
    if (!subscriberName) return { reply: 'Who should I subscribe?', handled: true };
    return { reply: `Which goal should I subscribe ${subscriberName} to?`, handled: true };
  }

  // Step 1 (confirm): answering "are you saying you'd like to subscribe someone to a goal?"
  if (lastAssistant && SUBSCRIBE_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: 'Great — who should I subscribe?', handled: true };
  }

  // Step 0: loose keyword hit — "subscribe" without the full one-shot shape
  if (!HOW_TO_RE.test(msg) && /\bsubscribe\b/i.test(msg)) {
    return { reply: 'Are you saying you\'d like to subscribe someone to a goal?', handled: true };
  }

  return null;
}

// Steps: confirm -> who -> which goal -> pledge amount. The fast path
// ("pledge 1000 for Ramesh towards Diwali Fund") still works in one shot.
const CREATE_PLEDGE_RE = /\bpledge\b\s+(?:of\s+)?(?:rs\.?|inr|₹|\$|£|€)?\s*(\d+(?:\.\d+)?)\s+for\s+([a-z0-9 .'-]+?)\s+(?:towards|for|to)\s+([a-z0-9 &.'-]+?)[.?!]*$/i;
const CREATE_PLEDGE_CONFIRM_RE = /are you saying you'd like to create a pledge/i;
const CREATE_PLEDGE_WHO_RE = /^great — who is this pledge for\?$/i;
const CREATE_PLEDGE_GOAL_RE = /^which event\/pledge goal is (.+?)'s pledge for\?$/i;
const CREATE_PLEDGE_AMOUNT_RE = /^how much is (.+?) pledging (?:for|towards) "([^"]+)"\?$/i;
PENDING_FLOW_MARKERS.push(CREATE_PLEDGE_CONFIRM_RE, CREATE_PLEDGE_WHO_RE, CREATE_PLEDGE_GOAL_RE, CREATE_PLEDGE_AMOUNT_RE);

function parseCreatePledge(msg, history) {
  const fastMatch = msg.match(CREATE_PLEDGE_RE);
  if (fastMatch) {
    return {
      reply: 'Here\'s what I understood:',
      action: { type: 'create_pledge', params: { amount: Number(fastMatch[1]) || 0, subscriberName: fastMatch[2].trim(), goalName: fastMatch[3].trim() } },
      handled: true
    };
  }

  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 4: answering "how much is X pledging towards <goal>?"
  if (lastAssistant && CREATE_PLEDGE_AMOUNT_RE.test(lastAssistant.content)) {
    const [, subscriberName, goalName] = lastAssistant.content.match(CREATE_PLEDGE_AMOUNT_RE);
    const amount = extractBareOrAtAmount(msg);
    if (!amount) return { reply: `How much is ${subscriberName} pledging towards "${goalName}"?`, handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'create_pledge', params: { amount, subscriberName, goalName } }, handled: true };
  }

  // Step 3: answering "which event/pledge goal is X's pledge for?"
  if (lastAssistant && CREATE_PLEDGE_GOAL_RE.test(lastAssistant.content)) {
    const subscriberName = lastAssistant.content.match(CREATE_PLEDGE_GOAL_RE)[1];
    const { rest, amount } = stripTrailingAmount(msg);
    const goalName = rest.replace(/[.?!]+$/, '').trim();
    if (!goalName) return { reply: `Which event/pledge goal is ${subscriberName}'s pledge for?`, handled: true };
    if (!amount) return { reply: `How much is ${subscriberName} pledging towards "${goalName}"?`, handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'create_pledge', params: { amount, subscriberName, goalName } }, handled: true };
  }

  // Step 2: answering "who is this pledge for?"
  if (lastAssistant && CREATE_PLEDGE_WHO_RE.test(lastAssistant.content)) {
    const subscriberName = msg.replace(/[.?!]+$/, '').trim();
    if (!subscriberName) return { reply: 'Who is this pledge for?', handled: true };
    return { reply: `Which event/pledge goal is ${subscriberName}'s pledge for?`, handled: true };
  }

  // Step 1 (confirm)
  if (lastAssistant && CREATE_PLEDGE_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: 'Great — who is this pledge for?', handled: true };
  }

  // Step 0: loose "pledge" keyword hit, not matching the one-shot shape.
  // Excludes create/add/start/setup wording — "create a pledge" means a
  // new pledge-category GOAL (create_goal, handled by parseCreateGoal),
  // not recording an existing subscriber's pledge amount against one.
  if (!HOW_TO_RE.test(msg) && /\bpledge\b/i.test(msg) && !/\b(create|add|start|set ?up)\b/i.test(msg)) {
    return { reply: 'Are you saying you\'d like to create a pledge?', handled: true };
  }

  return null;
}

// Steps: confirm -> which goal. Fast path ("mark Diwali Fund as complete" /
// "complete the Diwali Fund goal") still works in one shot.
const MARK_COMPLETE_CONFIRM_RE = /are you saying you'd like to mark a goal (?:as )?complete/i;
const MARK_COMPLETE_NAME_RE = /^great — which goal should i mark complete\?$/i;
PENDING_FLOW_MARKERS.push(MARK_COMPLETE_CONFIRM_RE, MARK_COMPLETE_NAME_RE);

function parseMarkComplete(msg, history) {
  let fastMatch = msg.match(/\bmark\b\s+(?:the\s+)?["“]?([a-z0-9][a-z0-9 &'-]*?)["”]?\s+(?:as\s+)?complete/i);
  if (!fastMatch) fastMatch = msg.match(/\bcomplete\b\s+(?:the\s+)?["“]?([a-z0-9][a-z0-9 &'-]*?)["”]?\s+goal/i);
  // A generic trigger phrase like "mark a goal complete" isn't naming a
  // real goal called "a goal" — treat it as no match so it falls through
  // to the step-by-step flow instead.
  if (fastMatch && GENERIC_GOAL_WORDS_RE.test(fastMatch[1].trim())) fastMatch = null;
  if (fastMatch) {
    return { reply: 'Here\'s what I understood:', action: { type: 'mark_goal_complete', params: { goalName: fastMatch[1].trim() } }, handled: true };
  }

  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  if (lastAssistant && MARK_COMPLETE_NAME_RE.test(lastAssistant.content)) {
    const goalName = msg.replace(/[.?!]+$/, '').trim();
    if (!goalName) return { reply: 'Which goal should I mark complete?', handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'mark_goal_complete', params: { goalName } }, handled: true };
  }

  if (lastAssistant && MARK_COMPLETE_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: 'Great — which goal should I mark complete?', handled: true };
  }

  if (!HOW_TO_RE.test(msg) && /\bcomplete\b/i.test(msg) && /\bgoal\b|\bmark\b/i.test(msg)) {
    return { reply: 'Are you saying you\'d like to mark a goal complete?', handled: true };
  }

  return null;
}

// Steps: confirm -> which goal. Fast path ("stop Cleaning Charges from
// rolling over" / "turn off rollover for Cleaning Charges") still works.
const STOP_ROLLOVER_CONFIRM_RE = /are you saying you'd like to stop a goal from rolling over/i;
const STOP_ROLLOVER_NAME_RE = /^great — which goal should i stop from rolling over\?$/i;
PENDING_FLOW_MARKERS.push(STOP_ROLLOVER_CONFIRM_RE, STOP_ROLLOVER_NAME_RE);

function parseStopRollover(msg, history) {
  let fastMatch = msg.match(/\bstop\b\s+(?:the\s+)?["“]?([a-z0-9][a-z0-9 &'-]*?)["”]?\s+from\s+rolling\s*over/i);
  if (!fastMatch) fastMatch = msg.match(/(?:stop|turn off|disable)\b.*?\brollover\b\s+(?:for|on)\s+["“]?([a-z0-9][a-z0-9 &'-]*?)["”]?[.?!]*$/i);
  if (fastMatch) {
    return { reply: 'Here\'s what I understood:', action: { type: 'stop_rollover', params: { goalName: fastMatch[1].trim() } }, handled: true };
  }

  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  if (lastAssistant && STOP_ROLLOVER_NAME_RE.test(lastAssistant.content)) {
    const goalName = msg.replace(/[.?!]+$/, '').trim();
    if (!goalName) return { reply: 'Which goal should I stop from rolling over?', handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'stop_rollover', params: { goalName } }, handled: true };
  }

  if (lastAssistant && STOP_ROLLOVER_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: 'Great — which goal should I stop from rolling over?', handled: true };
  }

  if (!HOW_TO_RE.test(msg) && (/\brollover\b|\brolling over\b/i.test(msg)) && /\b(stop|turn off|disable)\b/i.test(msg)) {
    return { reply: 'Are you saying you\'d like to stop a goal from rolling over?', handled: true };
  }

  return null;
}

// Steps: confirm -> amount -> category (-> optional description folded into
// the category answer if present). Fast path ("add an expense of 2000 for
// flowers, category event expenses") still works in one shot.
const ADD_EXPENSE_CONFIRM_RE = /are you saying you'd like to add an expense/i;
const ADD_EXPENSE_AMOUNT_RE = /^great — how much was the expense\?$/i;
const ADD_EXPENSE_CATEGORY_RE = /^what category is this (?:rs\.?|inr|₹|\$|£|€)?\s*[\d,.]+\s*expense — one of:/i;
PENDING_FLOW_MARKERS.push(ADD_EXPENSE_CONFIRM_RE, ADD_EXPENSE_AMOUNT_RE, ADD_EXPENSE_CATEGORY_RE);

function parseAddExpense(msg, history) {
  const fastAmtMatch = msg.match(/(?:expense|spent|paid)\s+(?:of\s+)?(?:rs\.?|inr|₹|\$|£|€)?\s*(\d+(?:\.\d+)?)/i) || msg.match(/(?:₹|\$|£|€|rs\.?)\s*(\d+(?:\.\d+)?)/i);
  if (fastAmtMatch) {
    const amount = Number(fastAmtMatch[1]) || 0;
    const forMatch = msg.match(/\bfor\s+([a-z0-9 .'-]+?)(?:,|\s+category\b|[.?!]*$)/i);
    const description = forMatch ? forMatch[1].trim() : '';
    const catMatch = msg.match(/\bcategory\s+([a-z &]+?)[.?!]*$/i);
    const category = catMatch ? matchExpenseCategory(catMatch[1]) : matchExpenseCategory(msg);
    if (category) {
      return { reply: 'Here\'s what I understood:', action: { type: 'add_expense', params: { amount, description, category } }, handled: true };
    }
    return { reply: `What category is this ${formatMoney(amount)} expense — one of: ${EXPENSE_CATEGORIES.join(', ')}?`, handled: true };
  }

  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 3: answering the category question
  if (lastAssistant && ADD_EXPENSE_CATEGORY_RE.test(lastAssistant.content)) {
    const amountMatch = lastAssistant.content.match(/is this (?:rs\.?|inr|₹|\$|£|€)?\s*([\d,.]+)\s*expense/i);
    const amount = amountMatch ? Number(amountMatch[1].replace(/,/g, '')) || 0 : 0;
    const category = matchExpenseCategory(msg);
    if (!category) return { reply: `What category is this ${formatMoney(amount)} expense — one of: ${EXPENSE_CATEGORIES.join(', ')}?`, handled: true };
    const forMatch = msg.match(/\bfor\s+([a-z0-9 .'-]+?)[.?!]*$/i);
    const description = forMatch ? forMatch[1].trim() : '';
    return { reply: 'Here\'s what I understood:', action: { type: 'add_expense', params: { amount, description, category } }, handled: true };
  }

  // Step 2: answering "how much was the expense?"
  if (lastAssistant && ADD_EXPENSE_AMOUNT_RE.test(lastAssistant.content)) {
    const amount = extractBareOrAtAmount(msg);
    if (!amount) return { reply: 'How much was the expense?', handled: true };
    const category = matchExpenseCategory(msg);
    if (category) {
      return { reply: 'Here\'s what I understood:', action: { type: 'add_expense', params: { amount, description: '', category } }, handled: true };
    }
    return { reply: `What category is this ${formatMoney(amount)} expense — one of: ${EXPENSE_CATEGORIES.join(', ')}?`, handled: true };
  }

  // Step 1 (confirm)
  if (lastAssistant && ADD_EXPENSE_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: 'Great — how much was the expense?', handled: true };
  }

  if (!HOW_TO_RE.test(msg) && /\bexpense\b/i.test(msg) && /\b(add|log|record)\b/i.test(msg)) {
    return { reply: 'Are you saying you\'d like to add an expense?', handled: true };
  }

  return null;
}

function formatMoney(n) {
  return (n || 0).toLocaleString('en-IN');
}

// Steps: confirm -> name -> mobile -> category. Fast path ("add a payee
// named XYZ Supplies, mobile 9998887776, category Maintenance") still works.
const ADD_PAYEE_CONFIRM_RE = /are you saying you'd like to add a new payee/i;
const ADD_PAYEE_NAME_RE = /^great — what's the payee's name\?$/i;
const ADD_PAYEE_MOBILE_RE = /^what's (.+?)'s mobile number\? \(payee\)$/i;
const ADD_PAYEE_CATEGORY_RE = /^what category is (.+?) \(mobile (\d+)\) for — one of:/i;
PENDING_FLOW_MARKERS.push(ADD_PAYEE_CONFIRM_RE, ADD_PAYEE_NAME_RE, ADD_PAYEE_MOBILE_RE, ADD_PAYEE_CATEGORY_RE);

function parseAddPayee(msg, history) {
  const fastNameMobile = extractNameMobile(msg, 'payee');
  if (fastNameMobile.name && fastNameMobile.mobile) {
    const catMatch = msg.match(/\bcategory\s+([a-z &]+?)[.?!]*$/i);
    const category = catMatch ? matchExpenseCategory(catMatch[1]) : matchExpenseCategory(msg);
    if (category) {
      return { reply: 'Here\'s what I understood:', action: { type: 'add_payee', params: { name: fastNameMobile.name, mobile: fastNameMobile.mobile, category } }, handled: true };
    }
    return { reply: `What category is ${fastNameMobile.name} (mobile ${fastNameMobile.mobile}) for — one of: ${EXPENSE_CATEGORIES.join(', ')}?`, handled: true };
  }

  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 4: answering the category question
  if (lastAssistant && ADD_PAYEE_CATEGORY_RE.test(lastAssistant.content)) {
    const [, name, mobile] = lastAssistant.content.match(ADD_PAYEE_CATEGORY_RE);
    const category = matchExpenseCategory(msg);
    if (!category) return { reply: `What category is ${name} (mobile ${mobile}) for — one of: ${EXPENSE_CATEGORIES.join(', ')}?`, handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'add_payee', params: { name, mobile, category } }, handled: true };
  }

  // Step 3: answering "what's X's mobile number?"
  if (lastAssistant && ADD_PAYEE_MOBILE_RE.test(lastAssistant.content)) {
    const name = lastAssistant.content.match(ADD_PAYEE_MOBILE_RE)[1];
    const mobileMatch = msg.match(/\b(\d{6,15})\b/);
    if (!mobileMatch) return { reply: `What's ${name}'s mobile number? (payee)`, handled: true };
    return { reply: `What category is ${name} (mobile ${mobileMatch[1]}) for — one of: ${EXPENSE_CATEGORIES.join(', ')}?`, handled: true };
  }

  // Step 2: answering "what's the payee's name?"
  if (lastAssistant && ADD_PAYEE_NAME_RE.test(lastAssistant.content)) {
    const mobileMatch = msg.match(/\b(\d{6,15})\b/);
    let name = msg.replace(/^(?:it'?s|its|name is|call(?:ed)?)\s+/i, '').replace(/[.?!]+$/, '').trim();
    if (mobileMatch) name = name.replace(mobileMatch[0], '').replace(/[,\s]+$/, '').trim();
    if (!name) return { reply: 'What\'s the payee\'s name?', handled: true };
    if (mobileMatch) return { reply: `What category is ${name} (mobile ${mobileMatch[1]}) for — one of: ${EXPENSE_CATEGORIES.join(', ')}?`, handled: true };
    return { reply: `What's ${name}'s mobile number? (payee)`, handled: true };
  }

  // Step 1 (confirm)
  if (lastAssistant && ADD_PAYEE_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: 'Great — what\'s the payee\'s name?', handled: true };
  }

  if (!HOW_TO_RE.test(msg) && /\bpayee\b/i.test(msg) && /\b(add|create|register)\b/i.test(msg)) {
    return { reply: 'Are you saying you\'d like to add a new payee?', handled: true };
  }

  return null;
}

function matchTicketCategory(text) {
  const norm = text.toLowerCase();
  if (/bill/.test(norm)) return 'billing';
  if (/collect/.test(norm)) return 'collection';
  if (/receipt|pdf/.test(norm)) return 'receipt_pdf';
  if (/import/.test(norm)) return 'import_subscribers';
  return 'other';
}

// Steps: confirm -> description (category classified from it, defaulting to
// "other" — low-stakes support routing, not a financial/data-shape
// decision, so unlike goal category this never blocks on a clarifying
// question). Fast path ("raise a support ticket about payment delay")
// still works in one shot.
const RAISE_TICKET_CONFIRM_RE = /are you saying you'd like to raise a support ticket/i;
const RAISE_TICKET_DESC_RE = /^great — what's the issue\?$/i;
PENDING_FLOW_MARKERS.push(RAISE_TICKET_CONFIRM_RE, RAISE_TICKET_DESC_RE);

function raiseTicketFromText(msg) {
  const category = matchTicketCategory(msg);
  let description = msg
    .replace(/\b(raise|open|create|submit)\b/gi, '')
    .replace(/\b(a\s+)?(support\s+)?ticket\b/gi, '')
    .replace(/,?\s*category\s+[a-z ]+$/i, '')
    .replace(/\babout\b/gi, '')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim();
  if (!description) description = msg.trim();
  return { reply: 'Here\'s what I understood:', action: { type: 'raise_ticket', params: { category, description } }, handled: true };
}

function parseRaiseTicket(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  if (lastAssistant && RAISE_TICKET_DESC_RE.test(lastAssistant.content)) {
    if (!msg.trim()) return { reply: 'What\'s the issue?', handled: true };
    return raiseTicketFromText(msg);
  }

  if (lastAssistant && RAISE_TICKET_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: 'Great — what\'s the issue?', handled: true };
  }

  if (!HOW_TO_RE.test(msg) && /\bticket\b/i.test(msg) && /\b(raise|open|create|submit)\b/i.test(msg)) {
    // If the message already carries a real description beyond just "raise
    // a ticket", skip the confirm question — it's unambiguous either way.
    const bareMatch = /^\s*(?:please\s+)?(?:raise|open|create|submit)\s+(?:a\s+)?(?:support\s+)?ticket\s*[.?!]*$/i.test(msg);
    if (!bareMatch) return raiseTicketFromText(msg);
    return { reply: 'Are you saying you\'d like to raise a support ticket?', handled: true };
  }

  return null;
}

// Steps: confirm -> which field (mobile or name) -> new value. Fast path
// ("change Ramesh's mobile number to 9998887766" / "change Ramesh's name to
// Suresh") still works in one shot.
const EDIT_SUBSCRIBER_CONFIRM_RE = /are you saying you'd like to edit a subscriber's details/i;
const EDIT_SUBSCRIBER_WHO_RE = /^great — which subscriber, and should i change their mobile number or their name\?$/i;
const EDIT_SUBSCRIBER_VALUE_RE = /^what should (.+?)'s (mobile number|name) be changed to\?$/i;
PENDING_FLOW_MARKERS.push(EDIT_SUBSCRIBER_CONFIRM_RE, EDIT_SUBSCRIBER_WHO_RE, EDIT_SUBSCRIBER_VALUE_RE);

function parseEditSubscriber(msg, history) {
  let fastMatch = msg.match(/(?:change|update|edit)\s+([a-z][a-z0-9 .'-]*?)'s\s+mobile(?:\s+number)?\s+to\s+(\d{6,15})/i);
  if (fastMatch) {
    return { reply: 'Here\'s what I understood:', action: { type: 'edit_subscriber', params: { subscriberName: fastMatch[1].trim(), mobile: fastMatch[2].trim() } }, handled: true };
  }
  fastMatch = msg.match(/(?:change|update|edit)\s+([a-z][a-z0-9 .'-]*?)'s\s+name\s+to\s+([a-z][a-z0-9 .'-]*?)[.?!]*$/i);
  if (fastMatch) {
    return { reply: 'Here\'s what I understood:', action: { type: 'edit_subscriber', params: { subscriberName: fastMatch[1].trim(), name: fastMatch[2].trim() } }, handled: true };
  }

  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 3: answering "what should X's mobile/name be changed to?"
  if (lastAssistant && EDIT_SUBSCRIBER_VALUE_RE.test(lastAssistant.content)) {
    const [, subscriberName, field] = lastAssistant.content.match(EDIT_SUBSCRIBER_VALUE_RE);
    const value = msg.replace(/[.?!]+$/, '').trim();
    if (!value) return { reply: `What should ${subscriberName}'s ${field} be changed to?`, handled: true };
    if (field === 'mobile number') {
      const mobileMatch = value.match(/\d{6,15}/);
      if (!mobileMatch) return { reply: `What should ${subscriberName}'s mobile number be changed to?`, handled: true };
      return { reply: 'Here\'s what I understood:', action: { type: 'edit_subscriber', params: { subscriberName, mobile: mobileMatch[0] } }, handled: true };
    }
    return { reply: 'Here\'s what I understood:', action: { type: 'edit_subscriber', params: { subscriberName, name: value } }, handled: true };
  }

  // Step 2: answering "which subscriber, and mobile or name?"
  if (lastAssistant && EDIT_SUBSCRIBER_WHO_RE.test(lastAssistant.content)) {
    const isMobile = /\bmobile\b/i.test(msg);
    const isName = /\bname\b/i.test(msg);
    const subscriberName = msg
      .replace(/\b(mobile(?:\s+number)?|name)\b/gi, '')
      .replace(/[,.]/g, '')
      .trim();
    if (!subscriberName) return { reply: 'Which subscriber, and should I change their mobile number or their name?', handled: true };
    if (!isMobile && !isName) {
      return { reply: `Should I change ${subscriberName}'s mobile number or their name?`, handled: true };
    }
    const field = isMobile ? 'mobile number' : 'name';
    return { reply: `What should ${subscriberName}'s ${field} be changed to?`, handled: true };
  }

  // Step 1 (confirm)
  if (lastAssistant && EDIT_SUBSCRIBER_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: 'Great — which subscriber, and should I change their mobile number or their name?', handled: true };
  }

  if (!HOW_TO_RE.test(msg) && /\b(change|update|edit)\b/i.test(msg) && /\bsubscriber\b|\bcontributor\b/i.test(msg)) {
    return { reply: 'Are you saying you\'d like to edit a subscriber\'s details?', handled: true };
  }

  return null;
}

// Steps: confirm -> which payee -> which category -> link or unlink. A
// payee can have several categories at once (it's an array on the backend,
// see routes/web/expenses.js), so this is one flow with a branch at the
// end rather than two separate ones.
const PAYEE_CATEGORY_CONFIRM_RE = /are you saying you'd like to (?:link|unlink) a payee (?:to|from) a category/i;
const PAYEE_CATEGORY_WHICH_PAYEE_RE = /^great — which payee, and (?:should i link them to|should i remove them from) which category\?$/i;
PENDING_FLOW_MARKERS.push(PAYEE_CATEGORY_CONFIRM_RE, PAYEE_CATEGORY_WHICH_PAYEE_RE);

const GENERIC_PAYEE_OR_CATEGORY_WORDS_RE = /^(?:a|the|this|that|my|our|it|some)\s*(?:payee|category)?$/i;

function parsePayeeCategory(msg, history) {
  // Fast path — "link XYZ Supplies to the Flowers category" / "unlink XYZ
  // Supplies from Maintenance". Guarded against generic phrasing like "link a
  // payee to a category" (a question, not a real instruction) being mistaken
  // for real payee/category names.
  let fastMatch = msg.match(/\blink\b\s+([a-z0-9 .'&-]+?)\s+to\s+(?:the\s+)?([a-z0-9 &]+?)(?:\s+category)?[.?!]*$/i);
  if (fastMatch && !GENERIC_PAYEE_OR_CATEGORY_WORDS_RE.test(fastMatch[1].trim()) && !GENERIC_PAYEE_OR_CATEGORY_WORDS_RE.test(fastMatch[2].trim())) {
    return { reply: 'Here\'s what I understood:', action: { type: 'link_payee_category', params: { payeeName: fastMatch[1].trim(), category: fastMatch[2].trim() } }, handled: true };
  }
  fastMatch = msg.match(/\bunlink\b\s+([a-z0-9 .'&-]+?)\s+from\s+(?:the\s+)?([a-z0-9 &]+?)(?:\s+category)?[.?!]*$/i);
  if (fastMatch && !GENERIC_PAYEE_OR_CATEGORY_WORDS_RE.test(fastMatch[1].trim()) && !GENERIC_PAYEE_OR_CATEGORY_WORDS_RE.test(fastMatch[2].trim())) {
    return { reply: 'Here\'s what I understood:', action: { type: 'unlink_payee_category', params: { payeeName: fastMatch[1].trim(), category: fastMatch[2].trim() } }, handled: true };
  }

  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 2: answering "which payee, and which category?" — expects
  // something like "XYZ Supplies, Maintenance" (link) or the same for unlink,
  // remembering which direction (link/unlink) from the confirm question.
  if (lastAssistant && PAYEE_CATEGORY_WHICH_PAYEE_RE.test(lastAssistant.content)) {
    const isUnlink = /remove them from/i.test(lastAssistant.content);
    const parts = msg.split(',');
    const payeeName = (parts[0] || '').trim();
    const category = (parts[1] || '').replace(/[.?!]+$/, '').trim();
    if (!payeeName || !category) {
      return { reply: `Which payee, and ${isUnlink ? 'which category should I remove them from' : 'which category should I link them to'}? Reply like "XYZ Supplies, Maintenance".`, handled: true };
    }
    return {
      reply: 'Here\'s what I understood:',
      action: { type: isUnlink ? 'unlink_payee_category' : 'link_payee_category', params: { payeeName, category } },
      handled: true
    };
  }

  // Step 1 (confirm) — remembers link vs unlink for the next question's wording
  if (lastAssistant && PAYEE_CATEGORY_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    const isUnlink = /unlink/i.test(lastAssistant.content);
    return { reply: `Great — which payee, and ${isUnlink ? 'should I remove them from which category' : 'should I link them to which category'}?`, handled: true };
  }

  if (!HOW_TO_RE.test(msg) && /\bpayee\b/i.test(msg) && /\bcategory\b|\bcategories\b/i.test(msg) && /\b(link|unlink|remove|associate)\b/i.test(msg)) {
    const isUnlink = /\b(unlink|remove)\b/i.test(msg);
    return { reply: `Are you saying you'd like to ${isUnlink ? 'unlink a payee from a category' : 'link a payee to a category'}?`, handled: true };
  }

  return null;
}

// Steps: confirm -> one free-form follow-up covering whichever of account
// type (individual/organization), category, and currency the user wants to
// change — all three are optional in that single reply (say as many as
// apply), and any field left unmentioned is filled in from the account's
// current value by the frontend, not guessed here.
const UPDATE_PROFILE_CONFIRM_RE = /are you saying you'd like to update your account profile/i;
const UPDATE_PROFILE_WHAT_RE = /^great — what would you like to update\? tell me the account type/i;
PENDING_FLOW_MARKERS.push(UPDATE_PROFILE_CONFIRM_RE, UPDATE_PROFILE_WHAT_RE);

function parseUpdateProfile(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 2: answering "what would you like to update?"
  if (lastAssistant && UPDATE_PROFILE_WHAT_RE.test(lastAssistant.content)) {
    let accountType;
    if (/\borgani[sz]ation\b/i.test(msg)) accountType = 'organization';
    else if (/\bindividual\b/i.test(msg)) accountType = 'individual';

    const currency = matchCurrency(msg);

    let category = msg
      .replace(/\b(organi[sz]ation|individual)\b/gi, '')
      .replace(new RegExp(`\\b(${SUPPORTED_CURRENCIES.join('|')})\\b`, 'gi'), '')
      .replace(/\bcategory\b|\bcurrency\b|\baccount type\b/gi, '')
      .replace(/[,.]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!category) category = undefined;

    if (!accountType && !currency && !category) {
      return { reply: 'What would you like to update — account type (individual/organization), category, and/or currency?', handled: true };
    }
    return { reply: 'Here\'s what I understood:', action: { type: 'update_profile', params: { accountType, category, currency } }, handled: true };
  }

  // Step 1 (confirm)
  if (lastAssistant && UPDATE_PROFILE_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: 'Great — what would you like to update? Tell me the account type (individual/organization), category, and/or currency — whatever\'s changing.', handled: true };
  }

  if (!HOW_TO_RE.test(msg) && /\b(update|change|edit)\b/i.test(msg) && /\bprofile\b|\baccount\b/i.test(msg)) {
    return { reply: 'Are you saying you\'d like to update your account profile?', handled: true };
  }

  return null;
}

// Steps: confirm -> name -> email -> mobile (optional). The password is
// never asked for through chat — a random one is generated once everything
// else is known, and shown back in the confirmation so the treasurer can
// share it with the new staff member. Typing a password into a chat box
// is exactly the kind of thing this avoids on purpose.
const ADD_STAFF_CONFIRM_RE = /are you saying you'd like to add a new staff account/i;
const ADD_STAFF_NAME_RE = /^great — what's the new staff member's name\?$/i;
const ADD_STAFF_EMAIL_RE = /^what's (.+?)'s email address\?$/i;
const ADD_STAFF_MOBILE_RE = /^\(optional\) what's (.+?)'s mobile number\? reply "skip" if you'd rather leave it blank\.$/i;
PENDING_FLOW_MARKERS.push(ADD_STAFF_CONFIRM_RE, ADD_STAFF_NAME_RE, ADD_STAFF_EMAIL_RE, ADD_STAFF_MOBILE_RE);

function generateStaffPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function parseAddStaff(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 4: answering the (optional) mobile question
  if (lastAssistant && ADD_STAFF_MOBILE_RE.test(lastAssistant.content)) {
    const name = lastAssistant.content.match(ADD_STAFF_MOBILE_RE)[1];
    const skip = /^\s*skip\b/i.test(msg);
    const mobileMatch = msg.match(/\d{6,15}/);
    if (!skip && !mobileMatch) return { reply: `(optional) What's ${name}'s mobile number? Reply "skip" if you'd rather leave it blank.`, handled: true };
    // Email was asked (and answered) one step earlier — recover it from
    // that question's own text plus the user's reply to it.
    let recoveredEmail = '';
    for (let i = (history || []).length - 1; i >= 0; i--) {
      const h = history[i];
      if (h.role === 'assistant' && ADD_STAFF_EMAIL_RE.test(h.content)) {
        const next = history[i + 1];
        if (next && next.role === 'user') recoveredEmail = next.content.trim();
        break;
      }
    }
    const password = generateStaffPassword();
    return {
      reply: 'Here\'s what I understood:',
      action: { type: 'add_staff', params: { name, email: recoveredEmail, mobile: skip ? undefined : mobileMatch[0], password } },
      handled: true
    };
  }

  // Step 3: answering "what's X's email address?"
  if (lastAssistant && ADD_STAFF_EMAIL_RE.test(lastAssistant.content)) {
    const name = lastAssistant.content.match(ADD_STAFF_EMAIL_RE)[1];
    const emailMatch = msg.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
    if (!emailMatch) return { reply: `What's ${name}'s email address?`, handled: true };
    return { reply: `(optional) What's ${name}'s mobile number? Reply "skip" if you'd rather leave it blank.`, handled: true };
  }

  // Step 2: answering "what's the new staff member's name?"
  if (lastAssistant && ADD_STAFF_NAME_RE.test(lastAssistant.content)) {
    const name = msg.replace(/[.?!]+$/, '').trim();
    if (!name) return { reply: 'What\'s the new staff member\'s name?', handled: true };
    return { reply: `What's ${name}'s email address?`, handled: true };
  }

  // Step 1 (confirm)
  if (lastAssistant && ADD_STAFF_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: 'Great — what\'s the new staff member\'s name?', handled: true };
  }

  if (!HOW_TO_RE.test(msg) && /\bstaff\b/i.test(msg) && /\b(add|create|register|new)\b/i.test(msg)) {
    return { reply: 'Are you saying you\'d like to add a new staff account?', handled: true };
  }

  return null;
}

// Steps: confirm -> which staff member -> enable or disable. Removing
// staff is destructive and stays refused (see DELETE_STEPS/'staff' below)
// — only enable/disable (a reversible status flip) is a real action here.
const TOGGLE_STAFF_CONFIRM_RE = /are you saying you'd like to enable or disable a staff account/i;
const TOGGLE_STAFF_WHICH_RE = /^great — which staff member, and should i enable or disable them\?$/i;
PENDING_FLOW_MARKERS.push(TOGGLE_STAFF_CONFIRM_RE, TOGGLE_STAFF_WHICH_RE);

const TOGGLE_STAFF_BAD_NAME_RE = /\b(or|enable|disable|activate|deactivate)\b/i;

function parseToggleStaff(msg, history) {
  // Fast path — "disable Priya's staff account" / "enable Priya as staff".
  // Guarded against generic trigger phrasing like "enable or disable staff"
  // (a question, not a real instruction naming someone) being mistaken for
  // a real staff name, and against "as" being swallowed into the name.
  let fastMatch = msg.match(/\b(disable|deactivate)\b\s+([a-z0-9 .'-]+?)(?:'s|\s+as)?\s+staff\b/i);
  if (fastMatch && !TOGGLE_STAFF_BAD_NAME_RE.test(fastMatch[2].trim())) {
    return { reply: 'Here\'s what I understood:', action: { type: 'toggle_staff', params: { staffName: fastMatch[2].trim(), enable: false } }, handled: true };
  }
  fastMatch = msg.match(/\b(enable|activate|reactivate)\b\s+([a-z0-9 .'-]+?)(?:'s|\s+as)?\s+staff\b/i);
  if (fastMatch && !TOGGLE_STAFF_BAD_NAME_RE.test(fastMatch[2].trim())) {
    return { reply: 'Here\'s what I understood:', action: { type: 'toggle_staff', params: { staffName: fastMatch[2].trim(), enable: true } }, handled: true };
  }

  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 2: answering "which staff member, and enable or disable?"
  if (lastAssistant && TOGGLE_STAFF_WHICH_RE.test(lastAssistant.content)) {
    const isEnable = /\benable|activate\b/i.test(msg);
    const isDisable = /\bdisable|deactivate\b/i.test(msg);
    const staffName = msg.replace(/\b(enable|disable|activate|deactivate)\b/gi, '').replace(/[,.]/g, '').trim();
    if (!staffName) return { reply: 'Which staff member, and should I enable or disable them?', handled: true };
    if (!isEnable && !isDisable) return { reply: `Should I enable or disable ${staffName}?`, handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'toggle_staff', params: { staffName, enable: isEnable } }, handled: true };
  }

  // Step 1 (confirm)
  if (lastAssistant && TOGGLE_STAFF_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: 'Great — which staff member, and should I enable or disable them?', handled: true };
  }

  if (!HOW_TO_RE.test(msg) && /\bstaff\b/i.test(msg) && /\b(enable|disable|activate|deactivate)\b/i.test(msg)) {
    return { reply: 'Are you saying you\'d like to enable or disable a staff account?', handled: true };
  }

  return null;
}

// Steps: confirm -> who -> which goal (optional, mirrors collect_payment's
// "omit it and the app shows a dues list to pick from" behavior). The
// actual gateway-connected check happens server-side when the frontend
// calls /pro/create-payment-link — this flow just gathers who/what.
const PAYMENT_LINK_CONFIRM_RE = /are you saying you'd like to generate a payment link/i;
// Two different questions dovetail into this same step: the flow's own
// direct trigger ("who should the payment link be for?") and the collect
// fallback menu's option 1, worded around a mobile lookup instead — kept
// textually distinct from DOWNLOAD_RECEIPT_MOBILE_RE below (also a "what's
// the subscriber's mobile number" question) so FLOW_OWNERS never confuses
// which flow a reply belongs to.
const PAYMENT_LINK_WHO_RE = /^great — (?:who should the payment link be for|what's the subscriber's mobile number so i can look up their due and generate the link)\?$/i;
PENDING_FLOW_MARKERS.push(PAYMENT_LINK_CONFIRM_RE, PAYMENT_LINK_WHO_RE);

const PAYMENT_LINK_FAKE_GOAL_RE = /^(?:his|her|their|its)\s+(?:due|dues|payment|account)s?$/i;

function parseCreatePaymentLink(msg, history) {
  // Fast path — "send Ramesh a payment link for Diwali Fund" (subscriber
  // named right after "send", before "a payment link").
  let fastMatch = msg.match(/\bsend\s+([a-z0-9 .'-]+?)\s+a\s+payment link\b(?:\s+for\s+([a-z0-9 &.'-]+?))?[.?!]*$/i);
  if (fastMatch && fastMatch[1]) {
    const goalName = fastMatch[2] && !PAYMENT_LINK_FAKE_GOAL_RE.test(fastMatch[2].trim()) ? fastMatch[2].trim() : undefined;
    return { reply: 'Here\'s what I understood:', action: { type: 'create_payment_link', params: { subscriberName: fastMatch[1].trim(), goalName } }, handled: true };
  }
  // Fast path — "generate a payment link for Ramesh for Diwali Fund" /
  // "payment link for Ramesh"
  fastMatch = msg.match(/(?:payment link)\b.*?\bfor\s+([a-z0-9 .'-]+?)(?:\s+for\s+([a-z0-9 &.'-]+?))?[.?!]*$/i);
  if (fastMatch && fastMatch[1]) {
    const goalName = fastMatch[2] && !PAYMENT_LINK_FAKE_GOAL_RE.test(fastMatch[2].trim()) ? fastMatch[2].trim() : undefined;
    return { reply: 'Here\'s what I understood:', action: { type: 'create_payment_link', params: { subscriberName: fastMatch[1].trim(), goalName } }, handled: true };
  }

  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 2: answering "who should the payment link be for?" — goal name is
  // optional in the same reply ("Ramesh for Diwali Fund" or just "Ramesh").
  if (lastAssistant && PAYMENT_LINK_WHO_RE.test(lastAssistant.content)) {
    const m = msg.match(/^([a-z0-9 .'-]+?)(?:\s+for\s+([a-z0-9 &.'-]+?))?[.?!]*$/i);
    const subscriberName = m ? m[1].trim() : msg.replace(/[.?!]+$/, '').trim();
    if (!subscriberName) return { reply: 'Who should the payment link be for?', handled: true };
    const goalName = m && m[2] ? m[2].trim() : undefined;
    return { reply: 'Here\'s what I understood:', action: { type: 'create_payment_link', params: { subscriberName, goalName } }, handled: true };
  }

  // Step 1 (confirm)
  if (lastAssistant && PAYMENT_LINK_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: 'Great — who should the payment link be for?', handled: true };
  }

  if (!HOW_TO_RE.test(msg) && /\bpayment link\b/i.test(msg) && !/\bhow\b/i.test(msg)) {
    return { reply: 'Are you saying you\'d like to generate a payment link?', handled: true };
  }

  return null;
}

// Steps: confirm -> which goal (optional — omit for "everyone with any
// pending due", mirroring the app's own "remind all" convention). The
// actual send requires the treasurer's own WhatsApp Business API to
// already be connected — enforced server-side by /web-send-whatsapp-bulk.
const WHATSAPP_BULK_CONFIRM_RE = /are you saying you'd like to send whatsapp reminders/i;
const WHATSAPP_BULK_WHICH_RE = /^great — remind everyone with a pending due, or just one goal\? say "everyone" or name the goal\.$/i;
PENDING_FLOW_MARKERS.push(WHATSAPP_BULK_CONFIRM_RE, WHATSAPP_BULK_WHICH_RE);

function parseSendWhatsappReminders(msg, history) {
  // Fast path — check for a named goal FIRST (e.g. "...everyone pending on
  // Diwali Fund" mentions "everyone" but still names a specific goal), then
  // fall back to the loose "everyone" catch-all with no goal named at all.
  let fastMatch = msg.match(/\bwhatsapp\b.*?\breminders?\b.*?\b(?:for|on)\s+([a-z0-9 &.'-]+?)[.?!]*$/i);
  if (fastMatch) {
    return { reply: 'Here\'s what I understood:', action: { type: 'send_whatsapp_reminders', params: { goalName: fastMatch[1].trim() } }, handled: true };
  }
  if (/\bwhatsapp\b.*?\breminders?\b.*?\beveryone\b/i.test(msg)) {
    return { reply: 'Here\'s what I understood:', action: { type: 'send_whatsapp_reminders', params: {} }, handled: true };
  }

  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 2: answering "everyone, or which goal?"
  if (lastAssistant && WHATSAPP_BULK_WHICH_RE.test(lastAssistant.content)) {
    if (/^\s*everyone\b/i.test(msg)) {
      return { reply: 'Here\'s what I understood:', action: { type: 'send_whatsapp_reminders', params: {} }, handled: true };
    }
    const goalName = msg.replace(/[.?!]+$/, '').trim();
    if (!goalName) return { reply: 'Remind everyone with a pending due, or just one goal? Say "everyone" or name the goal.', handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'send_whatsapp_reminders', params: { goalName } }, handled: true };
  }

  // Step 1 (confirm)
  if (lastAssistant && WHATSAPP_BULK_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: 'Great — remind everyone with a pending due, or just one goal? Say "everyone" or name the goal.', handled: true };
  }

  if (!HOW_TO_RE.test(msg) && /\bwhatsapp\b/i.test(msg) && /\breminders?\b/i.test(msg)) {
    return { reply: 'Are you saying you\'d like to send WhatsApp reminders?', handled: true };
  }

  return null;
}

// Steps: mobile number -> goal name -> done. Only ever entered via the
// collect fallback menu's option 2 below (no standalone keyword trigger of
// its own) — "download the receipt" alone is too generic a phrase to guess
// at reliably, whereas the menu already established the user meant this.
const DOWNLOAD_RECEIPT_MOBILE_RE = /^great — what's the subscriber's mobile number so i can find their receipt\?$/i;
const DOWNLOAD_RECEIPT_GOAL_RE = /^what's the goal name for (.+?)'s receipt\?$/i;
PENDING_FLOW_MARKERS.push(DOWNLOAD_RECEIPT_MOBILE_RE, DOWNLOAD_RECEIPT_GOAL_RE);

function parseDownloadReceipt(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 2: answering "what's the goal name for <mobile>'s receipt?"
  if (lastAssistant && DOWNLOAD_RECEIPT_GOAL_RE.test(lastAssistant.content)) {
    const [, subscriberName] = lastAssistant.content.match(DOWNLOAD_RECEIPT_GOAL_RE);
    const goalName = msg.replace(/[.?!]+$/, '').trim();
    if (!goalName) return { reply: `What's the goal name for ${subscriberName}'s receipt?`, handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'download_receipt', params: { subscriberName, goalName } }, handled: true };
  }

  // Step 1: answering "what's the subscriber's mobile number...?"
  if (lastAssistant && DOWNLOAD_RECEIPT_MOBILE_RE.test(lastAssistant.content)) {
    const mobileMatch = msg.match(/\b(\d{6,15})\b/);
    const subscriberName = mobileMatch ? mobileMatch[1] : msg.replace(/[.?!]+$/, '').trim();
    if (!subscriberName) return { reply: 'What\'s the subscriber\'s mobile number?', handled: true };
    return { reply: `What's the goal name for ${subscriberName}'s receipt?`, handled: true };
  }

  return null;
}

// "reopen my last support ticket" / "reopen my ticket" — always resolved
// against the account's own most-recently-solved ticket, never guessed by
// description (too error-prone from voice), so no name/id extraction here.
// Confirm-first like everything else, but has no fields to collect after
// that — a "yes" goes straight to proposing the action.
const REOPEN_TICKET_CONFIRM_RE = /are you saying you'd like to reopen your last support ticket/i;
PENDING_FLOW_MARKERS.push(REOPEN_TICKET_CONFIRM_RE);

function parseReopenTicket(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');
  if (lastAssistant && REOPEN_TICKET_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: 'Here\'s what I understood:', action: { type: 'reopen_ticket', params: {} }, handled: true };
  }
  if (!HOW_TO_RE.test(msg) && /\bticket\b/i.test(msg) && /\breopen\b/i.test(msg)) {
    return { reply: 'Are you saying you\'d like to reopen your last support ticket?', handled: true };
  }
  return null;
}

// Read-only report/query intents — answerable entirely from data the
// dashboard already has loaded (contributors, targets, dues, billing info),
// so these never need confirmation and never touch the database. The
// frontend computes the actual answer; this just recognizes the question
// and picks which metric to compute.
function parseReportQuery(msg) {
  let m = msg.match(/(?:what does|how much does)\s+([a-z][a-z0-9 .'-]*?)\s+owe/i) ||
          msg.match(/\bdue\s*(?:amount)?\s*for\s+([a-z][a-z0-9 .'-]*?)[.?!]*$/i);
  if (m) {
    return {
      reply: 'Here\'s what I understood:',
      action: { type: 'report_query', params: { metric: 'subscriber_due', subscriberName: m[1].trim() } },
      handled: true
    };
  }

  if (/\bhow many subscribers\b|\bsubscriber count\b|\btotal subscribers\b/i.test(msg)) {
    return { reply: 'Here\'s what I understood:', action: { type: 'report_query', params: { metric: 'subscriber_count' } }, handled: true };
  }

  if (/\bpending subscribers\b|\bwho(?:'s| is)?\s*pending\b|\boutstanding\s+(?:subscribers|dues)\b/i.test(msg)) {
    return { reply: 'Here\'s what I understood:', action: { type: 'report_query', params: { metric: 'pending_subscribers' } }, handled: true };
  }

  if (/\bactive goals\b|\blist\b.*\bgoals\b/i.test(msg)) {
    return { reply: 'Here\'s what I understood:', action: { type: 'report_query', params: { metric: 'active_goals' } }, handled: true };
  }

  if (/\b(when does|when is)\b.*\b(renew|subscription|plan)\b/i.test(msg) || /\bmy\s+(current\s+)?(plan|subscription)\b/i.test(msg)) {
    return { reply: 'Here\'s what I understood:', action: { type: 'report_query', params: { metric: 'current_plan' } }, handled: true };
  }

  if (/\b(how much|total)\b.*\bcollect(?:ed)?\b/i.test(msg)) {
    const period = /\bthis month\b/i.test(msg) ? 'month' : 'all';
    return { reply: 'Here\'s what I understood:', action: { type: 'report_query', params: { metric: 'total_collected', period } }, handled: true };
  }

  return null;
}

// Steps: confirm -> which currency. Fast path ("change my currency to USD"
// / "set currency to euros" — currency already named) still works in one
// shot, skipping the confirm question since it's unambiguous either way.
const SET_CURRENCY_CONFIRM_RE = /are you saying you'd like to change your collection currency/i;
const SET_CURRENCY_WHICH_RE = new RegExp(`^great — which currency — one of: ${SUPPORTED_CURRENCIES.join(', ')}\\?$`);
PENDING_FLOW_MARKERS.push(SET_CURRENCY_CONFIRM_RE, SET_CURRENCY_WHICH_RE);

function parseSetCurrency(msg, history) {
  const fastCurrency = matchCurrency(msg);
  if (fastCurrency) {
    return { reply: 'Here\'s what I understood:', action: { type: 'set_currency', params: { currency: fastCurrency } }, handled: true };
  }

  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  if (lastAssistant && SET_CURRENCY_WHICH_RE.test(lastAssistant.content)) {
    return { reply: `Which currency — one of: ${SUPPORTED_CURRENCIES.join(', ')}?`, handled: true };
  }

  if (lastAssistant && SET_CURRENCY_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: `Great — which currency — one of: ${SUPPORTED_CURRENCIES.join(', ')}?`, handled: true };
  }

  if (!HOW_TO_RE.test(msg) && /\bcurrency\b/i.test(msg) && /\b(change|set|switch)\b/i.test(msg)) {
    return { reply: 'Are you saying you\'d like to change your collection currency?', handled: true };
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
  if (/\bunsubscribe\b|\bsubscription\b/i.test(msg)) return 'subscription';
  if (/\bgoal\b/i.test(msg) && /\bfrom\b/i.test(msg)) return 'subscription';
  if (/\bgoal\b/i.test(msg)) return 'goal';
  // "remove/delete <name> from <goal name>" — no literal "goal"/"subscribe"
  // word needed (e.g. the sheet's own example "Remove Ramesh from Diwali
  // Fund") — a bare "from" clause on a removal request almost always means
  // taking someone off a goal, not deleting the subscriber outright.
  if (/\bfrom\b/i.test(msg)) return 'subscription';
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
    test: /subscriber|contributor/i,
    reply: 'Sidebar -> Subscribers -> "+ Add" -> enter a name and mobile number -> Save. Or just say "add a subscriber" and I\'ll walk you through it.'
  },
  {
    test: /payment|due|pending/i,
    reply: 'Open the relevant goal or subscriber (or the Pending tab) -> "Collect Payment" -> enter the amount -> Save. Or just say "collect 500 from <name> for <goal>" and I\'ll do it for you.'
  }
];

const FALLBACK_REPLY = 'Test mode (no AI key set yet): I can currently handle creating goals, collecting payments, adding/editing subscribers, subscribing someone to a goal, creating a pledge, marking a goal complete, stopping a goal\'s rollover, adding an expense/payee, raising or reopening a support ticket, changing your currency, and answering questions like "how much have I collected", "who\'s pending", "what does X owe", "list my active goals", "how many subscribers do I have", and "when does my subscription renew" — plus basic how-to questions. Add ANTHROPIC_API_KEY on the backend to unlock full understanding.';

// ---------------------------------------------------------------
// "ANY OTHER" LOOKUP — shared last step for every menu's final option
// (Goals/Collect/Subscriber/Accounting/Root). Picking that option no
// longer escalates immediately with whatever question originally opened
// the menu — a bare "5" means nothing on its own, and reusing the
// original question is often stale by the time someone reaches this
// option after browsing through several picks. Instead it asks the user
// to actually type what they need, and THAT reply is what gets escalated.
// One shared marker/handler for all five menus, since the step is
// identical everywhere.
// ---------------------------------------------------------------
const ANY_OTHER_ASK_TEXT = 'Please enter the details of your requirement.';
const ANY_OTHER_ASK_RE = /^please enter the details of your requirement\.$/i;
PENDING_FLOW_MARKERS.push(ANY_OTHER_ASK_RE);

function parseAnyOtherLookup(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');
  if (!(lastAssistant && ANY_OTHER_ASK_RE.test(lastAssistant.content))) return null;
  const trimmed = msg.trim();
  if (!trimmed) return { reply: ANY_OTHER_ASK_TEXT, handled: true };
  return { reply: '', handled: false, escalateMessage: trimmed };
}

// ---------------------------------------------------------------
// GOALS MENU — menu-first navigation for the Goals section (see the
// ROOT MENU below for the top-level entry point). Tried as a last resort
// after every specific goal-related flow above has already had its shot
// at a bare "goal" mention, and reached directly when the root menu's
// "Goals" option is picked. A message that mentions "goal" but doesn't
// cleanly match create/subscribe/pledge/complete/rollover is far more
// likely to be one of these common intents than genuinely novel — so
// this asks which one, instead of either guessing or spending a Claude
// call on it. A plain "how do I ...?" question still skips this and goes
// straight to the FAQ's explanation, same as before.
//
// Option 8 ("any other") is the only path that still reaches Claude — it
// asks the user to type their requirement (see parseAnyOtherLookup above)
// rather than escalating the original menu-triggering question, which by
// this point may be stale or no longer what they mean.
// ---------------------------------------------------------------
const GOAL_MENU_QUESTION = 'I\'m not quite sure what you\'d like to do with a goal. Please choose one:\n1. Create a Goal\n2. View Goals\n3. List of Pending Subscribers\n4. Delete a Goal\n5. Mark Goal as Complete\n6. Stop Rollover the Goal\n7. Download Receipt\n8. Any other';
const GOAL_MENU_RE = /i'm not quite sure what you'd like to do with a goal\. please choose one:/i;
PENDING_FLOW_MARKERS.push(GOAL_MENU_RE);

const GOALS_LIST_RECEIPTS_WHO_RE = /^great — what's the subscriber's name or mobile number, so i can list their receipts\?$/i;
PENDING_FLOW_MARKERS.push(GOALS_LIST_RECEIPTS_WHO_RE);

// Owned only by the Goals menu's "Download Receipt" option — no standalone
// keyword trigger of its own, same reasoning as parseDownloadReceipt above.
// Unlike parseDownloadReceipt (which needs a goal name too, for a single
// receipt), this only needs the subscriber — the frontend lists every goal
// they have a receipt for and the user picks which one to download.
function parseListReceiptsLookup(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');
  if (!(lastAssistant && GOALS_LIST_RECEIPTS_WHO_RE.test(lastAssistant.content))) return null;

  const mobileMatch = msg.match(/\b(\d{6,15})\b/);
  const subscriberName = mobileMatch ? mobileMatch[1] : msg.replace(/[.?!]+$/, '').trim();
  if (!subscriberName) return { reply: 'What\'s the subscriber\'s name or mobile number?', handled: true };
  return { reply: 'Here\'s what I understood:', action: { type: 'list_receipts_for_subscriber', params: { subscriberName } }, handled: true };
}

function parseGoalFallbackMenu(msg, history) {
  const safeHistory = Array.isArray(history) ? history : [];
  const lastAssistant = [...safeHistory].reverse().find(h => h.role === 'assistant');

  if (lastAssistant && GOAL_MENU_RE.test(lastAssistant.content)) {
    const choice = msg.trim().toLowerCase();

    if (/^1\b/.test(choice) || (/\bcreate\b/i.test(choice) && !/\bdelete\b/i.test(choice))) {
      return { reply: 'Great — what should the goal be named?', handled: true };
    }
    // Options 2-4 and 7 are terminal or hand off elsewhere without looping
    // back automatically on their own — the menu is re-appended after each
    // terminal reply so the next pick ("4", "6", etc.) still has the menu
    // question as the last assistant turn to match against, instead of
    // falling through to Claude with nothing to go on.
    if (/^2\b/.test(choice) || /\bview\b/i.test(choice)) {
      return { reply: `Opening Goals for you.\n\n${GOAL_MENU_QUESTION}`, action: { type: 'view_goals', params: {} }, handled: true };
    }
    if (/^3\b/.test(choice) || /\bpending\b|\bmissed\b/i.test(choice)) {
      return { reply: `Opening Pending for you.\n\n${GOAL_MENU_QUESTION}`, action: { type: 'view_pending', params: {} }, handled: true };
    }
    if (/^4\b/.test(choice) || /\bdelete\b/i.test(choice)) {
      const deleteResult = handleDeleteIntent('delete goal');
      return { reply: `${deleteResult.reply}\n\n${GOAL_MENU_QUESTION}`, handled: true };
    }
    if (/^5\b/.test(choice) || /\bcomplete\b/i.test(choice)) {
      return { reply: 'Great — which goal should I mark complete?', handled: true };
    }
    if (/^6\b/.test(choice) || /\brollover\b|\brolling over\b/i.test(choice)) {
      return { reply: 'Great — which goal should I stop from rolling over?', handled: true };
    }
    if (/^7\b/.test(choice) || /\breceipt\b|\bdownload\b/i.test(choice)) {
      return { reply: 'Great — what\'s the subscriber\'s name or mobile number, so I can list their receipts?', handled: true };
    }
    if (/^8\b/.test(choice) || /\b(something else|not covered|other|claude|ai)\b/i.test(choice)) {
      return { reply: ANY_OTHER_ASK_TEXT, handled: true };
    }

    // Unrecognized reply to the menu — re-ask rather than guess.
    return { reply: GOAL_MENU_QUESTION, handled: true };
  }

  if (!HOW_TO_RE.test(msg) && /\bgoal\b/i.test(msg)) {
    return { reply: GOAL_MENU_QUESTION, handled: true };
  }

  return null;
}

// ---------------------------------------------------------------
// ACCOUNTING MENU — same menu-first pattern as Goals/Subscribers. All
// five report options here are read-only (no writes, so no confirmation
// needed) and none of them make sense as a free-text Claude tool — a
// treasurer isn't going to naturally phrase "download the day-wise
// ledger" in conversation, they'll pick it from this menu — so none of
// these are added to Claude's tool schema either (see routes/web/
// assistant.js), keeping the system prompt from growing for menu-only
// actions, same reasoning as view_goals/view_pending.
// ---------------------------------------------------------------
const ACCOUNTING_MENU_QUESTION = 'I\'m not quite sure what you\'d like to do in Accounting. Please choose one:\n1. View Total Amount Collected\n2. Download Total Collected — Day-wise\n3. Download Total Collected — Goal-wise\n4. List of Pending & Paid\n5. Insights (charts & report)\n6. Any other';
const ACCOUNTING_MENU_RE = /i'm not quite sure what you'd like to do in accounting\. please choose one:/i;
PENDING_FLOW_MARKERS.push(ACCOUNTING_MENU_RE);

function parseAccountingFallbackMenu(msg, history) {
  const safeHistory = Array.isArray(history) ? history : [];
  const lastAssistant = [...safeHistory].reverse().find(h => h.role === 'assistant');

  if (lastAssistant && ACCOUNTING_MENU_RE.test(lastAssistant.content)) {
    const choice = msg.trim().toLowerCase();

    // All options here are terminal (read-only reports/navigation, no
    // multi-step flow to hand off into) — the menu is re-appended after
    // each so the next pick still has the menu question to match against.
    // Option 1 doesn't re-append the menu the way the others do — its
    // actual answer is computed client-side from real account data (see
    // buildReportQueryReply in AIAssistant.tsx) and pushed as a separate
    // message after this reply, so putting the menu text here would show
    // it BEFORE the answer instead of after.
    if (/^1\b/.test(choice) || /\btotal\b/i.test(choice)) {
      return { reply: '', action: { type: 'report_query', params: { metric: 'total_collected' } }, handled: true };
    }
    if (/^2\b/.test(choice) || /\bday\b|\bdaywise\b/i.test(choice)) {
      return { reply: `Downloading your day-wise ledger.\n\n${ACCOUNTING_MENU_QUESTION}`, action: { type: 'download_daywise_ledger', params: {} }, handled: true };
    }
    if (/^3\b/.test(choice) || /\bgoal\b|\bgoalwise\b/i.test(choice)) {
      return { reply: `Downloading your goal-wise ledger.\n\n${ACCOUNTING_MENU_QUESTION}`, action: { type: 'download_goalwise_ledger', params: {} }, handled: true };
    }
    if (/^4\b/.test(choice) || /\bpending\b|\bpaid\b/i.test(choice)) {
      return { reply: `Here are your active goals — pick one for the pending & paid report.\n\n${ACCOUNTING_MENU_QUESTION}`, action: { type: 'list_goals_for_report', params: {} }, handled: true };
    }
    if (/^5\b/.test(choice) || /\binsights?\b/i.test(choice)) {
      return { reply: `Generating your insights report.\n\n${ACCOUNTING_MENU_QUESTION}`, action: { type: 'download_insights_report', params: {} }, handled: true };
    }
    if (/^6\b/.test(choice) || /\b(something else|not covered|other|claude|ai)\b/i.test(choice)) {
      return { reply: ANY_OTHER_ASK_TEXT, handled: true };
    }

    // Unrecognized reply to the menu — re-ask rather than guess.
    return { reply: ACCOUNTING_MENU_QUESTION, handled: true };
  }

  if (!HOW_TO_RE.test(msg) && /\baccounting\b|\baccounts?\b/i.test(msg)) {
    return { reply: ACCOUNTING_MENU_QUESTION, handled: true };
  }

  return null;
}

// ---------------------------------------------------------------
// ROOT MENU — the assistant's default entry point (shown by the frontend
// itself as the opening greeting, no backend call involved in displaying
// it — see AIAssistant.tsx). This only ever needs to handle the REPLY to
// that greeting: picking a sidebar section hands off into that section's
// own menu (Goals/Subscribers/Accounting already exist; Pending is simple
// enough to be a direct navigation with no submenu of its own).
//
// Typed shortcuts (e.g. typing "create a goal" directly) keep working
// exactly as before — this menu is an additional, easier front door, not
// a replacement requirement.
// ---------------------------------------------------------------
const ROOT_MENU_QUESTION = 'Hi, welcome to Afleen — your AI assistant! 👋\nPlease pick a section below, or just type what you need:\n1. Goals\n2. Subscribers\n3. Pending/Missed\n4. Accounting\n5. Any other';
const ROOT_MENU_RE = /please pick a section below, or just type what you need:/i;
PENDING_FLOW_MARKERS.push(ROOT_MENU_RE);

function parseRootMenu(msg, history) {
  const safeHistory = Array.isArray(history) ? history : [];
  const lastAssistant = [...safeHistory].reverse().find(h => h.role === 'assistant');
  if (!(lastAssistant && ROOT_MENU_RE.test(lastAssistant.content))) return null;

  const choice = msg.trim().toLowerCase();

  if (/^1\b/.test(choice) || /\bgoals?\b/i.test(choice)) {
    return { reply: GOAL_MENU_QUESTION, handled: true };
  }
  if (/^2\b/.test(choice) || /\bsubscribers?\b/i.test(choice)) {
    return { reply: SUBSCRIBER_MENU_QUESTION, handled: true };
  }
  if (/^3\b/.test(choice) || /\bpending\b|\bmissed\b/i.test(choice)) {
    return { reply: `Opening Pending for you.\n\n${ROOT_MENU_QUESTION}`, action: { type: 'view_pending', params: {} }, handled: true };
  }

  if (/^4\b/.test(choice) || /\baccounting\b|\baccounts?\b/i.test(choice)) {
    return { reply: ACCOUNTING_MENU_QUESTION, handled: true };
  }

  if (/^5\b/.test(choice) || /\b(something else|not covered|other|claude|ai)\b/i.test(choice)) {
    return { reply: ANY_OTHER_ASK_TEXT, handled: true };
  }

  // Unrecognized reply to the menu — re-ask rather than guess.
  return { reply: ROOT_MENU_QUESTION, handled: true };
}

// ---------------------------------------------------------------
// COLLECT FALLBACK MENU — same last-resort pattern as the goal menu above,
// keyed on "collect" instead of "goal". Option 1 hands off into the
// existing create_payment_link flow (via PAYMENT_LINK_WHO_RE, broadened
// above to also match this menu's own step-2 wording) rather than
// recording a cash collection — the user's own spec for this option ends
// with "generate the link", which is what that flow already does; the
// "displays the total dues" part of the spec is already satisfied by the
// existing confirmation card (shown by the frontend before Confirm is
// clicked), not by anything the backend needs to compute itself.
// ---------------------------------------------------------------
const COLLECT_MENU_QUESTION = 'I\'m not quite sure what you\'d like to do regarding a payment. Please choose one:\n1. Collect payment (generate a payment link)\n2. Download the receipt\n3. Delete the payment/receipt\n4. How to pay the amount\n5. Something else';
const COLLECT_MENU_RE = /i'm not quite sure what you'd like to do regarding a payment\. please choose one:/i;
PENDING_FLOW_MARKERS.push(COLLECT_MENU_RE);

const COLLECT_MENU_HOWTO_REPLY = 'Open the relevant goal or subscriber (or the Pending tab) -> "Collect Payment" -> enter the amount -> Save. Or just say "collect 500 from <name> for <goal>" and I\'ll do it for you.';

function parseCollectFallbackMenu(msg, history) {
  const safeHistory = Array.isArray(history) ? history : [];
  const lastAssistant = [...safeHistory].reverse().find(h => h.role === 'assistant');

  if (lastAssistant && COLLECT_MENU_RE.test(lastAssistant.content)) {
    const choice = msg.trim().toLowerCase();

    // Delete checked first — "delete the receipt" would otherwise also
    // match option 2's bare /receipt/ keyword below. Only options 3 and 4
    // are terminal (1 and 2 hand off into their own multi-step flows) — the
    // menu is re-appended after each terminal reply so the next pick still
    // has something to match against instead of falling through to Claude.
    if (/^3\b/.test(choice) || /\bdelete\b/i.test(choice)) {
      const deleteResult = handleDeleteIntent('delete payment');
      return { reply: `${deleteResult.reply}\n\n${COLLECT_MENU_QUESTION}`, handled: true };
    }
    if (/^1\b/.test(choice) || /\bcollect\b/i.test(choice)) {
      return { reply: 'Great — what\'s the subscriber\'s mobile number so I can look up their due and generate the link?', handled: true };
    }
    if (/^2\b/.test(choice) || /\breceipt\b|\bdownload\b/i.test(choice)) {
      return { reply: 'Great — what\'s the subscriber\'s mobile number so I can find their receipt?', handled: true };
    }
    if (/^4\b/.test(choice) || /\bhow\b/i.test(choice)) {
      return { reply: `${COLLECT_MENU_HOWTO_REPLY}\n\n${COLLECT_MENU_QUESTION}`, handled: true };
    }
    if (/^5\b/.test(choice) || /\b(something else|not covered|other|claude|ai)\b/i.test(choice)) {
      return { reply: ANY_OTHER_ASK_TEXT, handled: true };
    }

    // Unrecognized reply to the menu — re-ask rather than guess.
    return { reply: COLLECT_MENU_QUESTION, handled: true };
  }

  if (!HOW_TO_RE.test(msg) && /\bcollect(?:ed|ing)?\b/i.test(msg)) {
    return { reply: COLLECT_MENU_QUESTION, handled: true };
  }

  return null;
}

// ---------------------------------------------------------------
// SUBSCRIBER FALLBACK MENU — same last-resort pattern as the goal/collect
// menus above, keyed on "subscriber"/"subscribers". Option 1 hands off
// into the existing add_subscriber flow (via its own marker text) and
// option 5's terminal step ("what should X's name/mobile be changed to?")
// hands off into the existing edit_subscriber flow the same way — see the
// FLOW_OWNERS comment below for why reusing exact marker text is what
// makes that handoff work without duplicating either flow's logic.
//
// Option 5 also needs to show the subscriber's actual current details
// before asking what to change, per spec — the local parser has no real
// account data to show, so it proposes the same view_subscriber_details
// action as option 2 (this time with a subscriberName so the frontend can
// pre-fill/auto-search it), bundled with the next chat question in the
// same turn. See AIAssistant.tsx: this action always executes immediately
// with no confirmation card, since opening a read-only lookup panel isn't
// a write and doesn't need one.
//
// NOTE: the user's own spec listed 5 numbered options plus an unnumbered
// "not covered above" line — treated here as a 6th option, since escalating
// to Claude needs its own slot distinct from "edit subscriber details".
// ---------------------------------------------------------------
const SUBSCRIBER_MENU_QUESTION = 'I\'m not quite sure what you\'d like to do with a subscriber. Please choose one:\n1. Add subscriber\n2. View subscriber details\n3. Delete/remove the subscriber\n4. How to add a subscriber\n5. Edit subscriber details\n6. Something else';
const SUBSCRIBER_MENU_RE = /i'm not quite sure what you'd like to do with a subscriber\. please choose one:/i;
PENDING_FLOW_MARKERS.push(SUBSCRIBER_MENU_RE);

const SUBSCRIBER_MENU_HOWTO_REPLY = 'Sidebar -> Subscribers -> "+ Add" -> enter a name and mobile number -> Save. Or just say "add a subscriber" and I\'ll walk you through it.';

const EDIT_DETAILS_NAME_MOBILE_RE = /^great — what's the subscriber's name and mobile number, so i can look up their details\?$/i;
const EDIT_DETAILS_WHAT_RE = /^here are (.+?)'s details — check the panel that just opened\. what would you like to change: name, mobile number, or unsubscribe from a goal\?$/i;
PENDING_FLOW_MARKERS.push(EDIT_DETAILS_NAME_MOBILE_RE, EDIT_DETAILS_WHAT_RE);

// Owned only by the subscriber menu's option 5 — no standalone keyword
// trigger of its own, same reasoning as parseDownloadReceipt above.
function parseEditSubscriberDetailsLookup(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 3: answering "what would you like to change?"
  if (lastAssistant && EDIT_DETAILS_WHAT_RE.test(lastAssistant.content)) {
    const [, subscriberName] = lastAssistant.content.match(EDIT_DETAILS_WHAT_RE);
    if (/\b(unsubscribe|remove|delete)\b/i.test(msg)) {
      return handleDeleteIntent('unsubscribe');
    }
    if (/\bmobile\b/i.test(msg)) {
      return { reply: `What should ${subscriberName}'s mobile number be changed to?`, handled: true };
    }
    if (/\bname\b/i.test(msg)) {
      return { reply: `What should ${subscriberName}'s name be changed to?`, handled: true };
    }
    return { reply: `What would you like to change for ${subscriberName} — name, mobile number, or unsubscribe from a goal?`, handled: true };
  }

  // Step 2: answering "what's the subscriber's name and mobile number?"
  if (lastAssistant && EDIT_DETAILS_NAME_MOBILE_RE.test(lastAssistant.content)) {
    const mobileMatch = msg.match(/\b(\d{6,15})\b/);
    const subscriberName = mobileMatch ? mobileMatch[1] : msg.replace(/[.?!]+$/, '').trim();
    if (!subscriberName) return { reply: 'What\'s the subscriber\'s name and mobile number?', handled: true };
    return {
      reply: `Here are ${subscriberName}'s details — check the panel that just opened. What would you like to change: name, mobile number, or unsubscribe from a goal?`,
      action: { type: 'view_subscriber_details', params: { subscriberName } },
      handled: true
    };
  }

  return null;
}

function parseSubscriberFallbackMenu(msg, history) {
  const safeHistory = Array.isArray(history) ? history : [];
  const lastAssistant = [...safeHistory].reverse().find(h => h.role === 'assistant');

  if (lastAssistant && SUBSCRIBER_MENU_RE.test(lastAssistant.content)) {
    const choice = msg.trim().toLowerCase();

    // Delete and edit checked first — both mention "subscriber"/"details"
    // in ways that could otherwise be caught by the plainer add/view checks.
    // Options 2-4 are terminal (1 and 5 hand off into their own multi-step
    // flows) — the menu is re-appended after each so the next pick still
    // has the menu question to match against instead of falling through
    // to Claude.
    if (/^3\b/.test(choice) || /\b(delete|remove)\b/i.test(choice)) {
      const deleteResult = handleDeleteIntent('delete subscriber');
      return { reply: `${deleteResult.reply}\n\n${SUBSCRIBER_MENU_QUESTION}`, handled: true };
    }
    if (/^5\b/.test(choice) || /\bedit\b/i.test(choice)) {
      return { reply: 'Great — what\'s the subscriber\'s name and mobile number, so I can look up their details?', handled: true };
    }
    if (/^1\b/.test(choice) || /\badd\b/i.test(choice)) {
      return { reply: 'Great — what\'s the subscriber\'s name?', handled: true };
    }
    if (/^2\b/.test(choice) || /\bview\b|\bdetails\b/i.test(choice)) {
      return { reply: `Opening Subscriber Details for you.\n\n${SUBSCRIBER_MENU_QUESTION}`, action: { type: 'view_subscriber_details', params: {} }, handled: true };
    }
    if (/^4\b/.test(choice) || /\bhow\b/i.test(choice)) {
      return { reply: `${SUBSCRIBER_MENU_HOWTO_REPLY}\n\n${SUBSCRIBER_MENU_QUESTION}`, handled: true };
    }
    if (/^6\b/.test(choice) || /\b(something else|not covered|other|claude|ai)\b/i.test(choice)) {
      return { reply: ANY_OTHER_ASK_TEXT, handled: true };
    }

    // Unrecognized reply to the menu — re-ask rather than guess.
    return { reply: SUBSCRIBER_MENU_QUESTION, handled: true };
  }

  if (!HOW_TO_RE.test(msg) && /\bsubscribers?\b/i.test(msg)) {
    return { reply: SUBSCRIBER_MENU_QUESTION, handled: true };
  }

  return null;
}

// ---------------------------------------------------------------
// FLOW OWNERSHIP — every confirm-first flow's fast-path check runs
// unconditionally at the top of its own function, which is fine on a
// fresh message but dangerous mid-flow: a reply meant as step 2 of one
// flow could accidentally match a completely different flow's fast path
// (e.g. a reply containing a currency code, mid-way through an unrelated
// flow, getting swallowed by set_currency's own always-on fast path).
// This registry lets parseLocalIntent check "is a specific flow already
// pending?" first and, if so, dispatch to ONLY that flow's function
// before anything else gets a chance to misfire on this message.
// ---------------------------------------------------------------
const FLOW_OWNERS = [
  { markers: [CREATE_GOAL_CONFIRM_RE, CREATE_GOAL_NAME_RE, CREATE_GOAL_TYPE_RE], fn: parseCreateGoal },
  { markers: [ADD_SUBSCRIBER_CONFIRM_RE, ADD_SUBSCRIBER_NAME_RE, ADD_SUBSCRIBER_MOBILE_RE, ADD_SUBSCRIBER_GOAL_OR_NOT_RE, ADD_SUBSCRIBER_AMOUNT_RE], fn: parseAddSubscriber },
  { markers: [SUBSCRIBE_CONFIRM_RE, SUBSCRIBE_WHO_RE, SUBSCRIBE_GOAL_RE, SUBSCRIBE_AMOUNT_RE], fn: parseSubscribeToGoal },
  { markers: [CREATE_PLEDGE_CONFIRM_RE, CREATE_PLEDGE_WHO_RE, CREATE_PLEDGE_GOAL_RE, CREATE_PLEDGE_AMOUNT_RE], fn: parseCreatePledge },
  { markers: [MARK_COMPLETE_CONFIRM_RE, MARK_COMPLETE_NAME_RE], fn: parseMarkComplete },
  { markers: [STOP_ROLLOVER_CONFIRM_RE, STOP_ROLLOVER_NAME_RE], fn: parseStopRollover },
  { markers: [ADD_EXPENSE_CONFIRM_RE, ADD_EXPENSE_AMOUNT_RE, ADD_EXPENSE_CATEGORY_RE], fn: parseAddExpense },
  { markers: [ADD_PAYEE_CONFIRM_RE, ADD_PAYEE_NAME_RE, ADD_PAYEE_MOBILE_RE, ADD_PAYEE_CATEGORY_RE], fn: parseAddPayee },
  { markers: [RAISE_TICKET_CONFIRM_RE, RAISE_TICKET_DESC_RE], fn: parseRaiseTicket },
  { markers: [REOPEN_TICKET_CONFIRM_RE], fn: parseReopenTicket },
  { markers: [SET_CURRENCY_CONFIRM_RE, SET_CURRENCY_WHICH_RE], fn: parseSetCurrency },
  { markers: [EDIT_SUBSCRIBER_CONFIRM_RE, EDIT_SUBSCRIBER_WHO_RE, EDIT_SUBSCRIBER_VALUE_RE], fn: parseEditSubscriber },
  { markers: [PAYEE_CATEGORY_CONFIRM_RE, PAYEE_CATEGORY_WHICH_PAYEE_RE], fn: parsePayeeCategory },
  { markers: [UPDATE_PROFILE_CONFIRM_RE, UPDATE_PROFILE_WHAT_RE], fn: parseUpdateProfile },
  { markers: [ADD_STAFF_CONFIRM_RE, ADD_STAFF_NAME_RE, ADD_STAFF_EMAIL_RE, ADD_STAFF_MOBILE_RE], fn: parseAddStaff },
  { markers: [TOGGLE_STAFF_CONFIRM_RE, TOGGLE_STAFF_WHICH_RE], fn: parseToggleStaff },
  { markers: [PAYMENT_LINK_CONFIRM_RE, PAYMENT_LINK_WHO_RE], fn: parseCreatePaymentLink },
  { markers: [WHATSAPP_BULK_CONFIRM_RE, WHATSAPP_BULK_WHICH_RE], fn: parseSendWhatsappReminders },
  { markers: [DOWNLOAD_RECEIPT_MOBILE_RE, DOWNLOAD_RECEIPT_GOAL_RE], fn: parseDownloadReceipt },
  { markers: [GOALS_LIST_RECEIPTS_WHO_RE], fn: parseListReceiptsLookup },
  { markers: [GOAL_MENU_RE], fn: parseGoalFallbackMenu },
  { markers: [COLLECT_MENU_RE], fn: parseCollectFallbackMenu },
  { markers: [EDIT_DETAILS_NAME_MOBILE_RE, EDIT_DETAILS_WHAT_RE], fn: parseEditSubscriberDetailsLookup },
  { markers: [SUBSCRIBER_MENU_RE], fn: parseSubscriberFallbackMenu },
  { markers: [ACCOUNTING_MENU_RE], fn: parseAccountingFallbackMenu },
  { markers: [ROOT_MENU_RE], fn: parseRootMenu },
  { markers: [ANY_OTHER_ASK_RE], fn: parseAnyOtherLookup }
];

function parseLocalIntent(message, history) {
  const msg = message.trim();
  const safeHistory = Array.isArray(history) ? history : [];

  // Checked before the delete/remove intent check below, since "cancel" is
  // a legitimate way to back out of a pending multi-turn flow but would
  // otherwise be misread as wanting to delete something.
  const pendingFlowCancelResult = cancelPendingFlowIfAny(msg, safeHistory);
  if (pendingFlowCancelResult) return pendingFlowCancelResult;

  // If a specific flow is already mid-progress, give it first refusal on
  // this message before anything else's fast-path gets a chance to
  // misfire on it (see FLOW_OWNERS comment above). A null result means
  // this function itself decided the reply doesn't continue its flow
  // (e.g. not a recognizable yes/no) — normal dispatch below still runs
  // in that case.
  const lastAssistantMsg = [...safeHistory].reverse().find(h => h.role === 'assistant');
  if (lastAssistantMsg) {
    const owner = FLOW_OWNERS.find(o => o.markers.some(re => re.test(lastAssistantMsg.content)));
    if (owner) {
      const ownerResult = owner.fn(msg, safeHistory);
      if (ownerResult) return ownerResult;
    }
  }

  // A bare cancel word or greeting with NOTHING actually pending (no flow
  // matched above) — reaching here at all already proves that, since
  // cancelPendingFlowIfAny and every FLOW_OWNERS entry above would have
  // returned first if there were something real to cancel/continue.
  // Answer locally instead of either (a) escalating a one-word message
  // like "no"/"exit"/"hi" to Claude with nothing to go on, or (b) letting
  // a bare "cancel"/"stop" fall into the delete-intent gate just below,
  // which would otherwise misfire a "not authorized to delete" refusal
  // about nothing in particular.
  if (CANCEL_RE.test(msg)) {
    return { reply: 'There\'s nothing pending to cancel right now. What would you like to do?', handled: true };
  }
  if (GREETING_RE.test(msg)) {
    return { reply: 'Hi! What would you like to do — name a sidebar section (e.g. "goal", "subscriber", "expense") or just tell me directly.', handled: true };
  }

  if (/\b(delete|remove|unsubscribe|cancel)\b/i.test(msg) && !(/\bpayee\b/i.test(msg) && /\bcategor/i.test(msg))) {
    return handleDeleteIntent(msg);
  }

  const addSubscriberResult = parseAddSubscriber(msg, safeHistory);
  if (addSubscriberResult) return addSubscriberResult;

  const subscribeResult = parseSubscribeToGoal(msg, safeHistory);
  if (subscribeResult) return subscribeResult;

  const createPledgeResult = parseCreatePledge(msg, safeHistory);
  if (createPledgeResult) return createPledgeResult;

  const markCompleteResult = parseMarkComplete(msg, safeHistory);
  if (markCompleteResult) return markCompleteResult;

  const stopRolloverResult = parseStopRollover(msg, safeHistory);
  if (stopRolloverResult) return stopRolloverResult;

  const addExpenseResult = parseAddExpense(msg, safeHistory);
  if (addExpenseResult) return addExpenseResult;

  const addPayeeResult = parseAddPayee(msg, safeHistory);
  if (addPayeeResult) return addPayeeResult;

  const reopenTicketResult = parseReopenTicket(msg, safeHistory);
  if (reopenTicketResult) return reopenTicketResult;

  const raiseTicketResult = parseRaiseTicket(msg, safeHistory);
  if (raiseTicketResult) return raiseTicketResult;

  const setCurrencyResult = parseSetCurrency(msg, safeHistory);
  if (setCurrencyResult) return setCurrencyResult;

  const editSubscriberResult = parseEditSubscriber(msg, safeHistory);
  if (editSubscriberResult) return editSubscriberResult;

  const payeeCategoryResult = parsePayeeCategory(msg, safeHistory);
  if (payeeCategoryResult) return payeeCategoryResult;

  const updateProfileResult = parseUpdateProfile(msg, safeHistory);
  if (updateProfileResult) return updateProfileResult;

  const toggleStaffResult = parseToggleStaff(msg, safeHistory);
  if (toggleStaffResult) return toggleStaffResult;

  const addStaffResult = parseAddStaff(msg, safeHistory);
  if (addStaffResult) return addStaffResult;

  const createPaymentLinkResult = parseCreatePaymentLink(msg, safeHistory);
  if (createPaymentLinkResult) return createPaymentLinkResult;

  const downloadReceiptResult = parseDownloadReceipt(msg, safeHistory);
  if (downloadReceiptResult) return downloadReceiptResult;

  const whatsappRemindersResult = parseSendWhatsappReminders(msg, safeHistory);
  if (whatsappRemindersResult) return whatsappRemindersResult;

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
    return { reply: 'Here\'s what I understood:', action: { type: 'collect_payment', params: parsed }, handled: true };
  }

  const createGoalResult = parseCreateGoal(msg, safeHistory);
  if (createGoalResult) return createGoalResult;

  const reportResult = parseReportQuery(msg);
  if (reportResult) return reportResult;

  // Last-resort "goal" pilot — tried only once every specific goal-related
  // flow above has already had (and passed on) this message. See the
  // comment above parseGoalFallbackMenu for why this runs before the FAQ.
  const goalMenuResult = parseGoalFallbackMenu(msg, safeHistory);
  if (goalMenuResult) return goalMenuResult;

  // Same last-resort placement, keyed on "collect" — see the comment above
  // parseCollectFallbackMenu.
  const collectMenuResult = parseCollectFallbackMenu(msg, safeHistory);
  if (collectMenuResult) return collectMenuResult;

  // Same last-resort placement, keyed on "subscriber"/"subscribers" — see
  // the comment above parseSubscriberFallbackMenu.
  const subscriberMenuResult = parseSubscriberFallbackMenu(msg, safeHistory);
  if (subscriberMenuResult) return subscriberMenuResult;

  // Same last-resort placement, keyed on "accounting"/"accounts" — see the
  // comment above parseAccountingFallbackMenu.
  const accountingMenuResult = parseAccountingFallbackMenu(msg, safeHistory);
  if (accountingMenuResult) return accountingMenuResult;

  const faqHit = FAQ.find(item => item.test.test(msg));
  if (faqHit) return { reply: faqHit.reply, handled: true };

  return { reply: FALLBACK_REPLY, handled: false };
}

module.exports = { parseLocalIntent };

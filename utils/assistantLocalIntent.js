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

function parseLocalIntent(message, history) {
  const msg = message.trim();
  const safeHistory = Array.isArray(history) ? history : [];

  // Checked before the delete/remove intent check below, since "cancel" is
  // a legitimate way to back out of a pending multi-turn flow but would
  // otherwise be misread as wanting to delete something.
  const pendingFlowCancelResult = cancelPendingFlowIfAny(msg, safeHistory);
  if (pendingFlowCancelResult) return pendingFlowCancelResult;

  if (/\b(delete|remove|unsubscribe|cancel)\b/i.test(msg)) {
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

  const faqHit = FAQ.find(item => item.test.test(msg));
  if (faqHit) return { reply: faqHit.reply, handled: true };

  return { reply: FALLBACK_REPLY, handled: false };
}

module.exports = { parseLocalIntent };

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

function extractGoalMention(msg) {
  const m = msg.match(/\b(?:to|for|in)\s+(?:the\s+)?(?:goal\s+)?["“]?([a-z0-9][a-z0-9 &'-]*?)["”]?(?:\s+goal)?[.?!]*$/i);
  return m ? m[1].trim() : '';
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

// The three questions this flow asks, in order — recognized on the
// assistant's own prior message so a short follow-up reply ("yes", a bare
// goal name, or "monthly") can be understood without repeating the whole
// request, same pattern as every other multi-turn flow in this file.
const CREATE_GOAL_CONFIRM_RE = /are you saying you'd like to create a new goal/i;
const CREATE_GOAL_NAME_RE = /^great — what should the goal be named\?$/i;
const CREATE_GOAL_TYPE_RE = /what type of goal is "([^"]+)"/i;
const CREATE_GOAL_ANY_STEP_RE = new RegExp(
  [CREATE_GOAL_CONFIRM_RE.source, CREATE_GOAL_NAME_RE.source, CREATE_GOAL_TYPE_RE.source].join('|'), 'i'
);

// Lets the user back out of the create-goal flow at any of its 3 steps —
// called from the very top of parseLocalIntent, before the delete/remove
// intent check would otherwise misread "cancel" as wanting to delete
// something.
function cancelCreateGoalIfPending(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');
  if (!lastAssistant || !CREATE_GOAL_ANY_STEP_RE.test(lastAssistant.content)) return null;
  if (!CANCEL_RE.test(msg)) return null;
  return { reply: 'No problem — cancelled. Let me know if there\'s something else I can help with.', handled: true };
}

// A "how do I ..." / "how to ..." question about creating a goal is asking
// for an explanation, not asking us to actually create one — must not
// trigger the confirm-first flow below (it used to, since it also contains
// "create" + "goal").
const HOW_TO_RE = /\bhow\s+(?:do|does|can|to)\b/i;

// Keyword-driven, confirm-first flow: a message merely containing
// "create"/"add"/etc. + "goal"/"target"/"fund"/"pledge" is treated as a
// probable (not certain) request, so the very first thing we do is ask the
// user to confirm before assuming anything — cheap to correct if wrong,
// since nothing is proposed/created until they say yes twice more (goal
// name, then type) and finally confirm the actual create_goal action card.
function parseCreateGoal(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 4: answering "what type of goal is X — monthly, yearly, or pledge?"
  if (lastAssistant && CREATE_GOAL_TYPE_RE.test(lastAssistant.content)) {
    if (CANCEL_RE.test(msg)) return { reply: 'No problem — cancelled. Let me know if there\'s something else I can help with.', handled: true };
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
    if (CANCEL_RE.test(msg)) return { reply: 'No problem — cancelled. Let me know if there\'s something else I can help with.', handled: true };
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
  if (lastAssistant && CREATE_GOAL_CONFIRM_RE.test(lastAssistant.content)) {
    if (CANCEL_RE.test(msg)) {
      return { reply: 'No problem — let me know if there\'s something else I can help with.', handled: true };
    }
    if (!AFFIRMATIVE_RE.test(msg)) return null; // not a recognizable yes/no — let other intents try this message
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

const ADD_SUBSCRIBER_CLARIFY_RE = /general subscriber only, or also subscribe them to a specific goal/i;
const ADD_SUBSCRIBER_AMOUNT_CLARIFY_RE = /how much should .+ pay per period for/i;

// Handles both "add a subscriber named X, mobile Y [to Goal]" in one shot,
// and the two-turn version where we asked "just add, or also subscribe to a
// goal?" and this message is the answer — recovered by re-reading the prior
// user turn (which had the name/mobile) out of the conversation history.
function parseAddSubscriber(msg, history) {
  const wantsAdd = /\b(add|create|register)\b/i.test(msg) && /\b(subscriber|contributor)\b/i.test(msg);
  if (wantsAdd) {
    const { rest, amount } = stripTrailingAmount(msg);
    const { name, mobile } = extractNameMobile(rest, '(?:subscriber|contributor)');
    if (!name) return { reply: 'What\'s the subscriber\'s name? Try: "add a subscriber named Priya, mobile 9876543210".', handled: true };
    if (!mobile) return { reply: `What's ${name}'s mobile number?`, handled: true };

    const goalName = extractGoalMention(rest);
    if (goalName) {
      if (!amount) {
        return { reply: `How much should ${name} pay per period for "${goalName}"? Try: "add a subscriber named ${name}, mobile ${mobile}, to ${goalName} at 500".`, handled: true };
      }
      return { reply: 'Here\'s what I understood:', action: { type: 'add_subscriber', params: { name, mobile, goalName, amount } }, handled: true };
    }
    return {
      reply: `Got it — should I add ${name} as a general subscriber only, or also subscribe them to a specific goal right away? Reply "just add" or say the goal name and their per-period amount, e.g. "Diwali Fund at 500".`,
      handled: true
    };
  }

  // Is the most recent assistant turn one of ours — either the original
  // "just add or a goal?" question, or our own "how much should they pay?"
  // follow-up (asked when a goal was named without an amount)?
  const lastAssistant = [...history].reverse().find(h => h.role === 'assistant');
  if (!lastAssistant) return null;
  const isAmountFollowUp = ADD_SUBSCRIBER_AMOUNT_CLARIFY_RE.test(lastAssistant.content);
  const isOriginalClarify = ADD_SUBSCRIBER_CLARIFY_RE.test(lastAssistant.content);
  if (!isAmountFollowUp && !isOriginalClarify) return null;

  // Recover the original name/mobile from the most recent user turn that
  // actually contains them, scanning back as far as needed — this stays
  // correct however many clarifying round-trips (goal? / amount?) happened
  // since the original request.
  let name = '', mobile = '';
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== 'user') continue;
    const found = extractNameMobile(history[i].content, '(?:subscriber|contributor)');
    if (found.name && found.mobile) { name = found.name; mobile = found.mobile; break; }
  }
  if (!name || !mobile) return null;

  // We already know the goal name (it's in our own last question) and are
  // only waiting on the amount — this message is expected to be just that,
  // not a fresh goal name.
  if (isAmountFollowUp) {
    const goalMatch = lastAssistant.content.match(/for "([^"]+)"/);
    const goalName = goalMatch ? goalMatch[1] : '';
    if (!goalName) return null;
    const amount = extractBareOrAtAmount(msg);
    if (!amount) {
      return { reply: `How much should ${name} pay per period for "${goalName}"? Reply e.g. "500".`, handled: true };
    }
    return { reply: 'Here\'s what I understood:', action: { type: 'add_subscriber', params: { name, mobile, goalName, amount } }, handled: true };
  }

  if (/^\s*(just add|no goal|no thanks?|general only|none|no)\s*[.?!]*$/i.test(msg)) {
    return { reply: 'Here\'s what I understood:', action: { type: 'add_subscriber', params: { name, mobile } }, handled: true };
  }

  const { rest, amount } = stripTrailingAmount(msg);
  const goalName = rest.trim();
  if (!goalName) {
    return { reply: `Got it — should I add ${name} as a general subscriber only, or also subscribe them to a specific goal? Reply "just add" or say the goal name and amount, e.g. "Diwali Fund at 500".`, handled: true };
  }
  if (!amount) {
    return { reply: `How much should ${name} pay per period for "${goalName}"? Reply e.g. "${goalName} at 500".`, handled: true };
  }
  return { reply: 'Here\'s what I understood:', action: { type: 'add_subscriber', params: { name, mobile, goalName, amount } }, handled: true };
}

const SUBSCRIBE_RE = /\bsubscribe\b\s+([a-z0-9 .'-]+?)\s+\bto\b\s+(?:the\s+)?(?:goal\s+)?["“]?([a-z0-9][a-z0-9 &'-]*?)["”]?(?:\s+goal)?[.?!]*$/i;
const SUBSCRIBE_AMOUNT_CLARIFY_RE = /how much should .+ pay per period for/i;

// "subscribe Ramesh to Diwali Fund at 500" — links an EXISTING subscriber to
// an EXISTING goal, with the amount THEY specifically owe per period (never
// the goal's own overall target, which is a different number and is often
// unset — defaulting to it silently made new subscribers show as having no
// dues, i.e. "already paid"). Deliberately keyed off the word "subscribe"
// only (not "add ... to ... goal") to avoid colliding with create_goal's
// own add/goal trigger words. Also handles the follow-up turn when the
// amount wasn't given inline, by re-deriving the subscriber/goal from
// whichever earlier user turn actually matched SUBSCRIBE_RE.
function parseSubscribeToGoal(msg, history) {
  const { rest, amount: strippedAmount } = stripTrailingAmount(msg);
  const m = rest.match(SUBSCRIBE_RE) || msg.match(SUBSCRIBE_RE);
  if (m) {
    const subscriberName = m[1].trim();
    const goalName = m[2].trim();
    if (!strippedAmount) {
      return { reply: `How much should ${subscriberName} pay per period for "${goalName}"? Try: "subscribe ${subscriberName} to ${goalName} at 500".`, handled: true };
    }
    return {
      reply: 'Here\'s what I understood:',
      action: { type: 'subscribe_to_goal', params: { subscriberName, goalName, amount: strippedAmount } },
      handled: true
    };
  }

  // Not a fresh "subscribe X to Y" message — is it a reply to our own
  // "how much should they pay?" follow-up?
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');
  if (!lastAssistant || !SUBSCRIBE_AMOUNT_CLARIFY_RE.test(lastAssistant.content)) return null;

  let subscriberName = '', goalName = '';
  for (let i = (history || []).length - 1; i >= 0; i--) {
    if (history[i].role !== 'user') continue;
    const found = history[i].content.match(SUBSCRIBE_RE);
    if (found) { subscriberName = found[1].trim(); goalName = found[2].trim(); break; }
  }
  if (!subscriberName || !goalName) return null;

  const amount = extractBareOrAtAmount(msg);
  if (!amount) {
    return { reply: `How much should ${subscriberName} pay per period for "${goalName}"? Try: "subscribe ${subscriberName} to ${goalName} at 500".`, handled: true };
  }
  return {
    reply: 'Here\'s what I understood:',
    action: { type: 'subscribe_to_goal', params: { subscriberName, goalName, amount } },
    handled: true
  };
}

// "pledge 1000 for Ramesh towards Diwali Fund"
function parseCreatePledge(msg) {
  const m = msg.match(/\bpledge\b\s+(?:of\s+)?(?:rs\.?|inr|₹|\$|£|€)?\s*(\d+(?:\.\d+)?)\s+for\s+([a-z0-9 .'-]+?)\s+(?:towards|for|to)\s+([a-z0-9 &.'-]+?)[.?!]*$/i);
  if (!m) return { reply: 'Try: "pledge 1000 for Ramesh towards Diwali Fund".', handled: true };
  return {
    reply: 'Here\'s what I understood:',
    action: { type: 'create_pledge', params: { amount: Number(m[1]) || 0, subscriberName: m[2].trim(), goalName: m[3].trim() } },
    handled: true
  };
}

// "mark Diwali Fund as complete" / "complete the Diwali Fund goal"
function parseMarkComplete(msg) {
  let m = msg.match(/\bmark\b\s+(?:the\s+)?["“]?([a-z0-9][a-z0-9 &'-]*?)["”]?\s+(?:as\s+)?complete/i);
  if (!m) m = msg.match(/\bcomplete\b\s+(?:the\s+)?["“]?([a-z0-9][a-z0-9 &'-]*?)["”]?\s+goal/i);
  if (!m) return { reply: 'Try: "mark Diwali Fund as complete".', handled: true };
  return {
    reply: 'Here\'s what I understood:',
    action: { type: 'mark_goal_complete', params: { goalName: m[1].trim() } },
    handled: true
  };
}

// "stop Cleaning Charges from rolling over" / "turn off rollover for Cleaning Charges"
function parseStopRollover(msg) {
  let m = msg.match(/\bstop\b\s+(?:the\s+)?["“]?([a-z0-9][a-z0-9 &'-]*?)["”]?\s+from\s+rolling\s*over/i);
  if (!m) m = msg.match(/(?:stop|turn off|disable)\b.*?\brollover\b\s+(?:for|on)\s+["“]?([a-z0-9][a-z0-9 &'-]*?)["”]?[.?!]*$/i);
  if (!m) return { reply: 'Try: "stop Cleaning Charges from rolling over".', handled: true };
  return {
    reply: 'Here\'s what I understood:',
    action: { type: 'stop_rollover', params: { goalName: m[1].trim() } },
    handled: true
  };
}

// "add an expense of 2000 for flowers, category event expenses"
function parseAddExpense(msg) {
  const amtMatch = msg.match(/(?:expense|spent|paid)\s+(?:of\s+)?(?:rs\.?|inr|₹|\$|£|€)?\s*(\d+(?:\.\d+)?)/i) || msg.match(/(?:₹|\$|£|€|rs\.?)\s*(\d+(?:\.\d+)?)/i);
  const amount = amtMatch ? Number(amtMatch[1]) || 0 : 0;
  if (!amount) return { reply: 'I didn\'t catch the amount. Try: "add an expense of 2000 for flowers".', handled: true };

  const forMatch = msg.match(/\bfor\s+([a-z0-9 .'-]+?)(?:,|\s+category\b|[.?!]*$)/i);
  const description = forMatch ? forMatch[1].trim() : '';

  const catMatch = msg.match(/\bcategory\s+([a-z &]+?)[.?!]*$/i);
  const category = catMatch ? matchExpenseCategory(catMatch[1]) : matchExpenseCategory(msg);
  if (!category) {
    return { reply: `What category is this expense — one of: ${EXPENSE_CATEGORIES.join(', ')}?`, handled: true };
  }

  return {
    reply: 'Here\'s what I understood:',
    action: { type: 'add_expense', params: { amount, description, category } },
    handled: true
  };
}

// "add a payee named XYZ Supplies, mobile 9998887776, category Maintenance"
function parseAddPayee(msg) {
  const { name, mobile } = extractNameMobile(msg, 'payee');
  if (!name) return { reply: 'What\'s the payee\'s name? Try: "add a payee named XYZ Supplies, mobile 9998887776, category Maintenance".', handled: true };
  if (!mobile) return { reply: `What's ${name}'s mobile number?`, handled: true };

  const catMatch = msg.match(/\bcategory\s+([a-z &]+?)[.?!]*$/i);
  const category = catMatch ? matchExpenseCategory(catMatch[1]) : matchExpenseCategory(msg);
  if (!category) {
    return { reply: `What category is this payee for — one of: ${EXPENSE_CATEGORIES.join(', ')}?`, handled: true };
  }

  return {
    reply: 'Here\'s what I understood:',
    action: { type: 'add_payee', params: { name, mobile, category } },
    handled: true
  };
}

function matchTicketCategory(text) {
  const norm = text.toLowerCase();
  if (/bill/.test(norm)) return 'billing';
  if (/collect/.test(norm)) return 'collection';
  if (/receipt|pdf/.test(norm)) return 'receipt_pdf';
  if (/import/.test(norm)) return 'import_subscribers';
  return 'other';
}

// "raise a support ticket about payment delay" — category classification is
// low-stakes (support routing, not a financial/data-shape decision), so
// unlike goal category this is allowed to default to "other" rather than
// blocking on a clarifying question.
function parseRaiseTicket(msg) {
  const category = matchTicketCategory(msg);
  let description = msg
    .replace(/\b(raise|open|create|submit)\b/gi, '')
    .replace(/\b(a\s+)?(support\s+)?ticket\b/gi, '')
    .replace(/,?\s*category\s+[a-z ]+$/i, '')
    .replace(/\babout\b/gi, '')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim();
  if (!description) description = msg.trim();
  return {
    reply: 'Here\'s what I understood:',
    action: { type: 'raise_ticket', params: { category, description } },
    handled: true
  };
}

// "change Ramesh's mobile number to 9998887766" / "update Ramesh's name to Suresh"
function parseEditSubscriber(msg) {
  let m = msg.match(/(?:change|update|edit)\s+([a-z][a-z0-9 .'-]*?)'s\s+mobile(?:\s+number)?\s+to\s+(\d{6,15})/i);
  if (m) {
    return {
      reply: 'Here\'s what I understood:',
      action: { type: 'edit_subscriber', params: { subscriberName: m[1].trim(), mobile: m[2].trim() } },
      handled: true
    };
  }

  m = msg.match(/(?:change|update|edit)\s+([a-z][a-z0-9 .'-]*?)'s\s+name\s+to\s+([a-z][a-z0-9 .'-]*?)[.?!]*$/i);
  if (m) {
    return {
      reply: 'Here\'s what I understood:',
      action: { type: 'edit_subscriber', params: { subscriberName: m[1].trim(), name: m[2].trim() } },
      handled: true
    };
  }

  return { reply: 'Try: "change Ramesh\'s mobile number to 9998887766" or "change Ramesh\'s name to Suresh".', handled: true };
}

// "reopen my last support ticket" / "reopen my ticket" — always resolved
// against the account's own most-recently-solved ticket, never guessed by
// description (too error-prone from voice), so no name/id extraction here.
function parseReopenTicket() {
  return {
    reply: 'Here\'s what I understood:',
    action: { type: 'reopen_ticket', params: {} },
    handled: true
  };
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

// "change my currency to USD" / "set currency to euros"
function parseSetCurrency(msg) {
  const currency = matchCurrency(msg);
  if (!currency) {
    return { reply: `Which currency — one of: ${SUPPORTED_CURRENCIES.join(', ')}?`, handled: true };
  }
  return {
    reply: 'Here\'s what I understood:',
    action: { type: 'set_currency', params: { currency } },
    handled: true
  };
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
    reply: 'Open the relevant goal or subscriber (or the Pending tab) -> "Collect Payment" -> enter the amount -> Save. Or just say "collect 500 from <name> for <goal>" and I\'ll do it for you.'
  }
];

const FALLBACK_REPLY = 'Test mode (no AI key set yet): I can currently handle creating goals, collecting payments, adding/editing subscribers, subscribing someone to a goal, creating a pledge, marking a goal complete, stopping a goal\'s rollover, adding an expense/payee, raising or reopening a support ticket, changing your currency, and answering questions like "how much have I collected", "who\'s pending", "what does X owe", "list my active goals", "how many subscribers do I have", and "when does my subscription renew" — plus basic how-to questions. Add ANTHROPIC_API_KEY on the backend to unlock full understanding.';

function parseLocalIntent(message, history) {
  const msg = message.trim();
  const safeHistory = Array.isArray(history) ? history : [];

  // Checked before the delete/remove intent check below, since "cancel" is
  // a legitimate way to back out of the create-goal flow but would
  // otherwise be misread as wanting to delete something.
  const createGoalCancelResult = cancelCreateGoalIfPending(msg, safeHistory);
  if (createGoalCancelResult) return createGoalCancelResult;

  if (/\b(delete|remove|unsubscribe|cancel)\b/i.test(msg)) {
    return handleDeleteIntent(msg);
  }

  const addSubscriberResult = parseAddSubscriber(msg, safeHistory);
  if (addSubscriberResult) return addSubscriberResult;

  const subscribeResult = parseSubscribeToGoal(msg, safeHistory);
  if (subscribeResult) return subscribeResult;

  if (/\bpledge\b/i.test(msg) && !/\b(create|add|start|set ?up)\b/i.test(msg)) {
    return parseCreatePledge(msg);
  }

  if (/\bcomplete\b/i.test(msg) && /\bgoal\b|\bmark\b/i.test(msg)) {
    return parseMarkComplete(msg);
  }

  if (/\brollover\b|\brolling over\b/i.test(msg) && /\b(stop|turn off|disable)\b/i.test(msg)) {
    return parseStopRollover(msg);
  }

  if (/\bexpense\b/i.test(msg) && /\b(add|log|record)\b/i.test(msg)) {
    return parseAddExpense(msg);
  }

  if (/\bpayee\b/i.test(msg) && /\b(add|create|register)\b/i.test(msg)) {
    return parseAddPayee(msg);
  }

  if (/\bticket\b/i.test(msg) && /\breopen\b/i.test(msg)) {
    return parseReopenTicket();
  }

  if (/\bticket\b/i.test(msg) && /\b(raise|open|create|submit)\b/i.test(msg)) {
    return parseRaiseTicket(msg);
  }

  if (/\bcurrency\b/i.test(msg) && /\b(change|set|switch)\b/i.test(msg)) {
    return parseSetCurrency(msg);
  }

  if (/'s\s+(?:mobile(?:\s+number)?|name)\s+to\b/i.test(msg) && /\b(change|update|edit)\b/i.test(msg)) {
    return parseEditSubscriber(msg);
  }

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

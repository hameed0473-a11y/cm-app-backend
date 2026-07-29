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
// Display/recognition names in each UI language, positionally paired with
// EXPENSE_CATEGORIES above — matchExpenseCategory() accepts any language's
// name but always returns the canonical English string, since that's what
// the backend (routes/web/expenses.js) stores/expects.
const EXPENSE_CATEGORY_TRANSLATIONS = {
  en: EXPENSE_CATEGORIES,
  de: ['Nebenkosten', 'Personalgehälter', 'Wartung', 'Reinigung', 'Bürokosten', 'Veranstaltungskosten', 'Bau & Renovierung', 'Ausrüstungskäufe', 'Wohltätigkeitszahlungen', 'Sonstiges'],
  fr: ['Factures de services', 'Salaires du personnel', 'Entretien', 'Nettoyage', 'Frais de bureau', 'Frais d\'événement', 'Construction et rénovation', 'Achats d\'équipement', 'Paiements caritatifs', 'Divers'],
  es: ['Facturas de servicios', 'Salarios del personal', 'Mantenimiento', 'Limpieza', 'Gastos de oficina', 'Gastos de eventos', 'Construcción y renovación', 'Compras de equipo', 'Pagos de caridad', 'Varios'],
  ar: ['فواتير الخدمات', 'رواتب الموظفين', 'الصيانة', 'التنظيف', 'مصاريف المكتب', 'مصاريف الفعاليات', 'البناء والتجديد', 'شراء المعدات', 'مدفوعات خيرية', 'متفرقات'],
  ru: ['Коммунальные платежи', 'Зарплаты персонала', 'Обслуживание', 'Уборка', 'Офисные расходы', 'Расходы на мероприятия', 'Строительство и ремонт', 'Покупка оборудования', 'Благотворительные платежи', 'Разное'],
  pt: ['Contas de serviços', 'Salários da equipe', 'Manutenção', 'Limpeza', 'Despesas de escritório', 'Despesas de eventos', 'Construção e reforma', 'Compras de equipamentos', 'Pagamentos de caridade', 'Diversos'],
  zh: ['水电费', '员工工资', '维护', '清洁', '办公费用', '活动费用', '建筑与翻新', '设备采购', '慈善捐款', '其他']
};

function expenseCategoryNames() {
  return EXPENSE_CATEGORY_TRANSLATIONS[currentLang] || EXPENSE_CATEGORIES;
}
const TICKET_CATEGORIES = ['billing', 'collection', 'receipt_pdf', 'import_subscribers', 'other'];
const SUPPORTED_CURRENCIES = ['INR', 'USD', 'GBP', 'EUR', 'AUD', 'CAD', 'SGD', 'AED', 'NZD', 'CHF', 'ZAR', 'MYR', 'SAR', 'HKD'];
const CURRENCY_WORDS = {
  dollars: 'USD', dollar: 'USD', rupees: 'INR', rupee: 'INR', pounds: 'GBP', pound: 'GBP',
  euros: 'EUR', euro: 'EUR', dirhams: 'AED', dirham: 'AED', ringgit: 'MYR', riyal: 'SAR',
  'hong kong dollar': 'HKD', 'singapore dollar': 'SGD', 'new zealand dollar': 'NZD',
  'australian dollar': 'AUD', 'canadian dollar': 'CAD', 'south african rand': 'ZAR', francs: 'CHF', franc: 'CHF'
};

// ---------------------------------------------------------------
// ROOT-MENU LOCALIZATION — the assistant's opening greeting/menu (see
// ROOT_MENU_QUESTION-equivalent below) is the highest-traffic, most
// visible thing a user reads before ever typing/speaking a command, so
// it's the first thing localized to avoid every non-English session
// escalating to Claude just to navigate the root menu. Sub-menus (Goal/
// Subscriber/Accounting/Collect) are NOT yet localized — a deliberate,
// narrower first pass; they still fall through to Claude for non-English
// replies exactly as before. See parseLocalIntent's `lang` param.
// ---------------------------------------------------------------
const ROOT_MENU_TEXT = {
  en: { greeting: 'Hi, welcome to Afleen — your AI assistant! 👋', pickLine: 'Please pick a section below, or just type what you need:', goals: 'Goals', subscribers: 'Subscribers', pending: 'Pending/Missed', accounting: 'Accounting', other: 'Any other', openingPending: 'Opening Pending for you.' },
  de: { greeting: 'Hallo, willkommen bei Afleen — Ihrem KI-Assistenten! 👋', pickLine: 'Bitte wählen Sie unten einen Bereich, oder tippen Sie einfach, was Sie brauchen:', goals: 'Ziele', subscribers: 'Abonnenten', pending: 'Verpasst/Ausstehend', accounting: 'Buchhaltung', other: 'Sonstiges', openingPending: 'Öffne Ausstehend für Sie.' },
  fr: { greeting: 'Bonjour, bienvenue sur Afleen — votre assistant IA ! 👋', pickLine: 'Veuillez choisir une section ci-dessous, ou tapez simplement ce dont vous avez besoin :', goals: 'Objectifs', subscribers: 'Abonnés', pending: 'Manqués/En attente', accounting: 'Comptabilité', other: 'Autre chose', openingPending: 'Ouverture de En attente pour vous.' },
  es: { greeting: 'Hola, bienvenido a Afleen — tu asistente de IA! 👋', pickLine: 'Elige una sección abajo, o simplemente escribe lo que necesitas:', goals: 'Metas', subscribers: 'Suscriptores', pending: 'Perdidos/Pendientes', accounting: 'Contabilidad', other: 'Otra cosa', openingPending: 'Abriendo Pendientes para ti.' },
  ar: { greeting: 'مرحبًا بك في أفلين — مساعدك الذكي! 👋', pickLine: 'يرجى اختيار قسم أدناه، أو اكتب ما تحتاجه مباشرة:', goals: 'الأهداف', subscribers: 'المشتركون', pending: 'فائت/معلّق', accounting: 'المحاسبة', other: 'أخرى', openingPending: 'يتم فتح المعلّق من أجلك.' },
  ru: { greeting: 'Здравствуйте, добро пожаловать в Afleen — ваш ИИ-помощник! 👋', pickLine: 'Выберите раздел ниже или просто напишите, что вам нужно:', goals: 'Цели', subscribers: 'Подписчики', pending: 'Пропущено/Ожидает', accounting: 'Бухгалтерия', other: 'Другое', openingPending: 'Открываю раздел «Ожидает» для вас.' },
  pt: { greeting: 'Olá, bem-vindo ao Afleen — seu assistente de IA! 👋', pickLine: 'Escolha uma seção abaixo, ou apenas digite o que você precisa:', goals: 'Metas', subscribers: 'Assinantes', pending: 'Perdidos/Pendentes', accounting: 'Contabilidade', other: 'Outra coisa', openingPending: 'Abrindo Pendentes para você.' },
  zh: { greeting: '您好，欢迎使用 Afleen — 您的 AI 助手！👋', pickLine: '请选择下方的一个板块，或直接输入您的需求：', goals: '目标', subscribers: '订阅者', pending: '错过/待处理', accounting: '账务', other: '其他', openingPending: '正在为您打开待处理。' }
};

// Per-language keyword matching for a typed/spoken root-menu reply, in
// addition to the digit shortcuts (1-5) which already work in every
// language unchanged. "claude"/"ai" are recognized as option-5 triggers
// in every language since they're commonly typed/spoken as-is regardless
// of UI language.
const ROOT_OPTION_KEYWORDS = {
  en: { 1: /\bgoals?\b/i, 2: /\bsubscribers?\b/i, 3: /\bpending\b|\bmissed\b/i, 4: /\baccounting\b|\baccounts?\b/i, 5: /\b(something else|not covered|other|claude|ai)\b/i },
  de: { 1: /\bziele?\b/i, 2: /\babonnent(en)?\b/i, 3: /\bverpasst\b|\bausstehend\b/i, 4: /\bbuchhaltung\b/i, 5: /\b(sonstiges|etwas anderes|andere|claude|ai)\b/i },
  fr: { 1: /\bobjectifs?\b/i, 2: /\babonn[ée]s?(?!\w)/i, 3: /\bmanqu[ée]s?(?!\w)|\battente\b/i, 4: /\bcomptabilit[ée](?!\w)/i, 5: /\b(autre chose|autre|claude|ai)\b/i },
  es: { 1: /\bmetas?\b/i, 2: /\bsuscriptor(es)?\b/i, 3: /\bpendientes?\b|\bperdidos?\b/i, 4: /\bcontabilidad\b/i, 5: /\b(otra cosa|otro|claude|ai)\b/i },
  ar: { 1: /الأهداف|هدف/, 2: /مشترك/, 3: /فائت|معلق|معلّق/, 4: /محاسبة/, 5: /أخرى|claude|ai/i },
  ru: { 1: /цел(и|ь)/i, 2: /подписчик/i, 3: /пропущено|ожидает/i, 4: /бухгалтери/i, 5: /другое|claude|ai/i },
  pt: { 1: /\bmetas?\b/i, 2: /\bassinante(s)?\b/i, 3: /\bperdidos?\b|\bpendentes?\b/i, 4: /\bcontabilidade\b/i, 5: /\b(outra coisa|outro|claude|ai)\b/i },
  zh: { 1: /目标/, 2: /订阅/, 3: /待处理|错过/, 4: /账务|财务/, 5: /其他|claude|ai/i }
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Compiles a '{token}' template string into a render function (fills the
// tokens for display) and an exec function (recognizes the SAME question
// coming back as the assistant's own prior message, extracting whatever
// was embedded in it — e.g. a name mentioned earlier in the flow). Used
// throughout the deeper multi-turn flows below so each one only has to
// state its questions once per language rather than hand-writing a
// capture-group regex per phrasing. Compiled fresh on each call — fine at
// this call volume (a chat backend, not a hot loop).
function compileTemplate(template) {
  const tokens = [];
  const pattern = escapeRegExp(template).replace(/\\\{(\w+)\\\}/g, (_, key) => {
    tokens.push(key);
    return '(.+?)';
  });
  const regex = new RegExp(`^${pattern}$`, 'i');
  return {
    render: (params) => template.replace(/\{(\w+)\}/g, (_, key) => (params && params[key] != null ? params[key] : '')),
    test: (text) => regex.test(text),
    exec: (text) => {
      const m = text.match(regex);
      if (!m) return null;
      const result = {};
      tokens.forEach((t, i) => { result[t] = m[i + 1]; });
      return result;
    }
  };
}

// Renders a flow question in the current request's language (falls back to
// English if that key is missing for some reason).
function renderFlow(table, key, params) {
  const t = table[currentLang] || table.en;
  return compileTemplate(t[key]).render(params);
}

// Tests whether `text` is ANY language's version of this flow question —
// used for the "is this flow currently active" marker checks, so a session
// that started in one language still recognizes its own question even in
// an edge case where the language setting changed mid-flow.
function testFlowAnyLang(table, key, text) {
  return Object.values(table).some(t => t[key] && compileTemplate(t[key]).test(text));
}

// Extracts embedded values from `text` assuming it's this flow's question
// — tries currentLang first (the common case), then falls back to every
// other language for robustness (see testFlowAnyLang).
function execFlowAnyLang(table, key, text) {
  const order = [currentLang, ...Object.keys(table).filter(l => l !== currentLang)];
  for (const l of order) {
    const t = table[l];
    if (!t || !t[key]) continue;
    const r = compileTemplate(t[key]).exec(text);
    if (r) return r;
  }
  return null;
}

function rootMenuQuestion(lang) {
  const t = ROOT_MENU_TEXT[lang] || ROOT_MENU_TEXT.en;
  return `${t.greeting}\n${t.pickLine}\n1. ${t.goals}\n2. ${t.subscribers}\n3. ${t.pending}\n4. ${t.accounting}\n5. ${t.other}`;
}

// The single module-level "current request's language" — safe because
// this whole file is 100% synchronous (no await anywhere), so it's set
// once at the top of parseLocalIntent and only ever read again later in
// that same synchronous call before the next request could touch it.
// Avoids threading a `lang` parameter through every one of the ~20
// FLOW_OWNERS parser functions just for the root menu's sake.
let currentLang = 'en';

const AMOUNT_RE = /(?:target|amount)\s*(?:of)?\s*(?:rs\.?|inr|₹|\$|£|€)?\s*(\d+(?:\.\d+)?)|(?:₹|\$|£|€|rs\.?)\s*(\d+(?:\.\d+)?)/i;

function extractAmount(msg) {
  const m = msg.match(AMOUNT_RE);
  if (!m) return 0;
  return Number(m[1] || m[2]) || 0;
}

// No default here on purpose — a missing/unclear category means the AI
// (local or Claude) must ask, never silently assume "event".
// Recognizes the goal-type words in any of the 8 UI languages, not just
// English — a French/Chinese/etc. reply to "monthly, yearly, or pledge?"
// needs to resolve to the same 'monthly'/'yearly'/'event' category value
// the rest of the app already uses, regardless of what language it's typed
// in (this doesn't need to know currentLang — just recognize the word).
function extractCategory(msg) {
  if (/\bmonthly\b|\bmonatlich\b|\bmensuel(?:le)?\b|\bmensual(?:es)?\b|شهري|ежемесячн|\bmensal(?:is)?\b|月度|每月/i.test(msg)) return 'monthly';
  if (/\byearly\b|\bannual(?:ly)?\b|\bjährlich\b|\bannuel(?:le)?\b|\banual(?:es)?\b|سنوي|ежегодн|年度|每年/i.test(msg)) return 'yearly';
  if (/\bevent\b|\bone[- ]?off\b|\bpledge\b|\beinmalig\w*\b|\bzusage\b|\bponctuel(?:le)?\b|\bpromesse\b|\búnic[oa]\b|\bpromesa\b|مرة واحدة|تعهد|разов|обещани|\bpromessa\b|一次性|认捐/i.test(msg)) return 'event';
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

// The "at <amount>" preposition, in any of the 8 UI languages (the
// examples this file's flow questions give users — "Diwali Fund at 500",
// "Fondo Diwali a 500", "Diwali-Fonds mit 500" — all need to parse back
// out correctly regardless of which language example the user followed).
const AT_WORD_RE = '(?:at|bei|mit|à|a|com|por|по|на|ب|بـ)';

// A subscriber's per-goal amount is the recurring due THEY are on the hook
// for each period, not the goal's own (often unset) overall target — so
// every place that subscribes someone to a goal must get this explicitly
// from the user, via "... at 500", never default or guess it. Strips a
// trailing "at <amount>" clause so the remaining text (goal name, etc.)
// parses cleanly, and reports whichever amount it found either way. Falls
// back to a plain trailing number with NO preposition at all (e.g. "Diwali
// Fund 500") since Chinese in particular doesn't use a connector word here.
function stripTrailingAmount(msg) {
  let m = msg.match(new RegExp(`^(.*?)\\s+${AT_WORD_RE}\\s+(?:rs\\.?|inr|₹|\\$|£|€)?\\s*(\\d+(?:\\.\\d+)?)(?:\\s*(?:per\\s*(?:month|year|period))?)?[.?!]*$`, 'i'));
  if (m) return { rest: m[1].trim(), amount: Number(m[2]) || 0 };
  m = msg.match(/^(.+?)[\s,，]+(?:rs\.?|inr|₹|\$|£|€)?\s*(\d+(?:\.\d+)?)[.?!]*$/i);
  if (m) return { rest: m[1].trim(), amount: Number(m[2]) || 0 };
  return { rest: msg, amount: extractAmount(msg) };
}

// For a follow-up turn that's expected to be *just* the amount (a reply to
// our own "how much should X pay?" question) — accepts a bare number, an
// "at <number>" reply, or a currency-prefixed one.
function extractBareOrAtAmount(msg) {
  const m = msg.trim().match(new RegExp(`^(?:${AT_WORD_RE}\\s+)?(?:rs\\.?|inr|₹|\\$|£|€)?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:per\\s*(?:month|year|period))?[.?!]*$`, 'i'));
  if (m) return Number(m[1]) || 0;
  return extractAmount(msg);
}

function matchExpenseCategory(text) {
  const norm = text.toLowerCase();
  // Tries the current language's names first, then every other language's
  // (mirrors execFlowAnyLang's robustness) — always returns the canonical
  // English name regardless of which language matched.
  const order = [currentLang, ...Object.keys(EXPENSE_CATEGORY_TRANSLATIONS).filter(l => l !== currentLang)];
  for (const lang of order) {
    const names = EXPENSE_CATEGORY_TRANSLATIONS[lang] || EXPENSE_CATEGORIES;
    const idx = names.findIndex(c => norm.includes(c.toLowerCase()) || c.toLowerCase().includes(norm.trim()));
    if (idx !== -1) return EXPENSE_CATEGORIES[idx];
  }
  return null;
}

function matchCurrency(text) {
  const norm = text.toLowerCase();
  for (const code of SUPPORTED_CURRENCIES) {
    // Word-boundary match, not a bare substring check — otherwise 3-letter
    // codes like "ZAR" false-positive inside ordinary words in other
    // languages (e.g. Portuguese "atualizar" contains "zar").
    if (new RegExp(`\\b${code.toLowerCase()}\\b`).test(norm)) return code;
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
// Recognizes yes/no/cancel replies in any of the 8 UI languages — like
// extractCategory, this doesn't need currentLang: whichever language the
// user actually typed/spoke in should be recognized. \b only applies to
// the Latin-script alternatives (Cyrillic/Arabic/CJK aren't in \w, so \b
// silently fails to match around them — see the fix earlier for the menu
// keyword tables).
const AFFIRMATIVE_RE = /^\s*(?:(?:yes|yeah|yep|yup|correct|right|sure|ok(?:ay)?|confirm|go ahead|please do|ja|jawohl|klar|genau|richtig|bestätigen|oui|ouais|exact|d'accord|vas-y|si|claro|vale|correcto|confirmar|adelante|sim|certo|vai)\b|sí|да|ага|верно|точно|ладно|хорошо|подтвердить|давай|نعم|أجل|تمام|صحيح|أكد|تفضل|是|对|好的|确认|没问题|继续)/i;
const CANCEL_RE = /^\s*(?:(?:no|nope|nah|never ?mind|don'?t|cancel|stop|back|exit|forget it|nein|abbrechen|stopp|zurück|raus|egal|vergiss es|non|laisse tomber|annuler|arrête|retour|sortir|olvídalo|cancelar|detener|atrás|salir|não|esquece|parar|voltar|sair)\b|нет|забудь|отмена|стоп|назад|выход|لا|انسَ الأمر|إلغاء|توقف|رجوع|خروج|不|算了|取消|停止|返回|退出)/i;
// A bare greeting with nothing else — answered locally (see parseLocalIntent)
// instead of spending a Claude call on "hi"/"hello" alone.
const GREETING_RE = /^\s*(hi+|hello+|hey+|hola|good\s?morning|good\s?afternoon|good\s?evening|hallo|guten\s?morgen|guten\s?tag|guten\s?abend|bonjour|salut|bonsoir|buenos\s?días|buenas\s?tardes|buenas\s?noches|привет|здравствуйте|добрый\s?день|доброе\s?утро|добрый\s?вечер|مرحبا|أهلا|السلام\s?عليكم|صباح\s?الخير|مساء\s?الخير|olá|oi|bom\s?dia|boa\s?tarde|boa\s?noite|你好|您好|早上好|下午好|晚上好)\s*[.!]*$/i;

// The three questions the create-goal flow asks, in order — recognized on
// the assistant's own prior message so a short follow-up reply ("yes", a
// bare goal name, or "monthly") can be understood without repeating the
// whole request, same pattern as every other multi-turn flow in this file.
// Localized to all 8 UI languages via CREATE_GOAL_TEXT + compileTemplate;
// CREATE_GOAL_CONFIRM_RE/NAME_RE stay plain combined regexes (no embedded
// dynamic value), CREATE_GOAL_TYPE_RE is a duck-typed { test } object since
// its question embeds the goal name — extraction happens via
// execFlowAnyLang inside parseCreateGoal itself, this only needs .test().
const CREATE_GOAL_TEXT = {
  en: { confirm: 'Are you saying you\'d like to create a new goal?', askName: 'Great — what should the goal be named?', askNameEmpty: 'What should the goal be named?', askType: 'What type of goal is "{name}" — monthly, yearly, or a one-off/event pledge?', typeRetry: 'Sorry, I didn\'t catch the type — is "{name}" a monthly goal, a yearly goal, or a one-off/event pledge?' },
  de: { confirm: 'Möchten Sie ein neues Ziel erstellen?', askName: 'Gut — wie soll das Ziel heißen?', askNameEmpty: 'Wie soll das Ziel heißen?', askType: 'Welcher Zieltyp ist "{name}" — monatlich, jährlich oder eine einmalige Zusage?', typeRetry: 'Entschuldigung, ich habe den Typ nicht verstanden — ist "{name}" ein monatliches Ziel, ein jährliches Ziel oder eine einmalige Zusage?' },
  fr: { confirm: 'Voulez-vous dire que vous souhaitez créer un nouvel objectif ?', askName: 'Très bien — comment doit s\'appeler l\'objectif ?', askNameEmpty: 'Comment doit s\'appeler l\'objectif ?', askType: 'Quel type d\'objectif est "{name}" — mensuel, annuel, ou une promesse ponctuelle ?', typeRetry: 'Désolé, je n\'ai pas compris le type — "{name}" est-il un objectif mensuel, annuel, ou une promesse ponctuelle ?' },
  es: { confirm: '¿Quieres decir que te gustaría crear una nueva meta?', askName: 'Genial — ¿cómo debería llamarse la meta?', askNameEmpty: '¿Cómo debería llamarse la meta?', askType: '¿Qué tipo de meta es "{name}" — mensual, anual, o una promesa única?', typeRetry: 'Lo siento, no entendí el tipo — ¿es "{name}" una meta mensual, anual, o una promesa única?' },
  ar: { confirm: 'هل تقصد أنك تريد إنشاء هدف جديد؟', askName: 'رائع — ما الاسم الذي تريده للهدف؟', askNameEmpty: 'ما الاسم الذي تريده للهدف؟', askType: 'ما نوع الهدف "{name}" — شهري، سنوي، أم تعهد لمرة واحدة؟', typeRetry: 'عذرًا، لم أفهم النوع — هل "{name}" هدف شهري، سنوي، أم تعهد لمرة واحدة؟' },
  ru: { confirm: 'Вы хотите создать новую цель?', askName: 'Отлично — как назвать цель?', askNameEmpty: 'Как назвать цель?', askType: 'Какой тип у цели «{name}» — ежемесячная, ежегодная или разовое обещание?', typeRetry: 'Извините, я не понял тип — «{name}» это ежемесячная цель, ежегодная, или разовое обещание?' },
  pt: { confirm: 'Você gostaria de criar uma nova meta?', askName: 'Ótimo — como a meta deve se chamar?', askNameEmpty: 'Como a meta deve se chamar?', askType: 'Que tipo de meta é "{name}" — mensal, anual, ou uma promessa única?', typeRetry: 'Desculpe, não entendi o tipo — "{name}" é uma meta mensal, anual, ou uma promessa única?' },
  zh: { confirm: '您是想创建一个新目标吗？', askName: '好的 — 这个目标叫什么名字？', askNameEmpty: '这个目标叫什么名字？', askType: '"{name}"是什么类型的目标 — 月度、年度，还是一次性认捐？', typeRetry: '抱歉，我没听清类型 — "{name}"是月度目标、年度目标，还是一次性认捐？' }
};
const CREATE_GOAL_CONFIRM_RE = new RegExp(Object.values(CREATE_GOAL_TEXT).map(t => escapeRegExp(t.confirm)).join('|'), 'i');
const CREATE_GOAL_NAME_RE = new RegExp(Object.values(CREATE_GOAL_TEXT).map(t => `^${escapeRegExp(t.askName)}$`).join('|'), 'i');
const CREATE_GOAL_TYPE_RE = { test: (text) => testFlowAnyLang(CREATE_GOAL_TEXT, 'askType', text) };

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
const STRICT_ABORT_RE = /^\s*(?:(?:cancel|stop|never ?mind|forget it|exit|back|abbrechen|stopp|zurück|raus|annuler|arrête|retour|sortir|cancelar|detener|atrás|salir|parar|voltar|sair)\b|отмена|стоп|назад|выход|إلغاء|توقف|رجوع|خروج|取消|停止|返回|退出)/i;
const PENDING_FLOW_STRICT_ABORT_MARKERS = [];

const CANCELLED_TEXT = {
  en: 'No problem — cancelled. Let me know if there\'s something else I can help with.',
  de: 'Kein Problem — abgebrochen. Sagen Sie mir, wenn ich sonst noch helfen kann.',
  fr: 'Pas de problème — annulé. Dites-moi si je peux vous aider avec autre chose.',
  es: 'Sin problema — cancelado. Avísame si puedo ayudarte con algo más.',
  ar: 'لا مشكلة — تم الإلغاء. أخبرني إذا كان بإمكاني مساعدتك في شيء آخر.',
  ru: 'Без проблем — отменено. Дайте знать, если нужна ещё какая-то помощь.',
  pt: 'Sem problemas — cancelado. Me avise se eu puder ajudar com mais alguma coisa.',
  zh: '没问题 — 已取消。如果还有什么需要帮忙的，请告诉我。'
};

function cancelledText() {
  return CANCELLED_TEXT[currentLang] || CANCELLED_TEXT.en;
}

function cancelPendingFlowIfAny(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');
  if (!lastAssistant) return null;
  if (PENDING_FLOW_MARKERS.some(re => re.test(lastAssistant.content)) && CANCEL_RE.test(msg)) {
    return { reply: cancelledText(), handled: true };
  }
  if (PENDING_FLOW_STRICT_ABORT_MARKERS.some(re => re.test(lastAssistant.content)) && STRICT_ABORT_RE.test(msg)) {
    return { reply: cancelledText(), handled: true };
  }
  return null;
}

// A "how do I ..." / "how to ..." question about creating a goal is asking
// for an explanation, not asking us to actually create one — must not
// trigger the confirm-first flow below (it used to, since it also contains
// "create" + "goal").
const HOW_TO_RE = /\bhow\s+(?:do|does|can|to)\b|\bwie\s+(?:kann|geht|mache)|\bcomment\s+(?:faire|puis-je)|\bcómo\s+(?:hago|puedo)|كيف|как|\bcomo\s+(?:faço|posso)|如何|怎么/i;

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
// Localized equivalents of the category words this flow strips back out of
// a name once a type has been detected in it (e.g. "Water Fund, monthly" ->
// name "Water Fund", category 'monthly') — mirrors extractCategory's word
// list so cleanup works regardless of which language the type was typed in.
const CATEGORY_WORDS_STRIP_RE = /\b(monthly|yearly|annual(?:ly)?|event|one[- ]?off|pledge|monatlich|jährlich|einmalig\w*|zusage|mensuel(?:le)?|annuel(?:le)?|ponctuel(?:le)?|promesse|mensual(?:es)?|anual(?:es)?|únic[oa]|promesa|mensal(?:is)?|anual|promessa)\b|شهري|سنوي|مرة واحدة|تعهد|ежемесячн\w*|ежегодн\w*|разов\w*|обещани\w*|月度|每月|年度|每年|一次性|认捐/gi;

function parseCreateGoal(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 4: answering "what type of goal is X — monthly, yearly, or pledge?"
  // (a "cancel"/"stop"/etc. reply here is already handled earlier, by
  // cancelPendingFlowIfAny in parseLocalIntent, before this is even reached)
  if (lastAssistant && CREATE_GOAL_TYPE_RE.test(lastAssistant.content)) {
    const extracted = execFlowAnyLang(CREATE_GOAL_TEXT, 'askType', lastAssistant.content);
    const name = extracted ? extracted.name : '';
    const category = extractCategory(msg);
    if (!category) {
      return { reply: renderFlow(CREATE_GOAL_TEXT, 'typeRetry', { name }), handled: true };
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
    if (!name) return { reply: renderFlow(CREATE_GOAL_TEXT, 'askNameEmpty'), handled: true };
    const category = extractCategory(name);
    if (category) {
      name = name.replace(CATEGORY_WORDS_STRIP_RE, '').replace(/[,\s]+$/, '').replace(/\s{2,}/g, ' ').trim();
      return {
        reply: 'Here\'s what I understood:',
        action: { type: 'create_goal', params: { name, category, targetAmount: 0 } },
        handled: true
      };
    }
    return { reply: renderFlow(CREATE_GOAL_TEXT, 'askType', { name }), handled: true };
  }

  // Step 2: answering "are you saying you'd like to create a new goal?"
  // ("cancel" is handled earlier by cancelPendingFlowIfAny; anything else
  // that isn't a recognizable "yes" just falls through to other intents)
  if (lastAssistant && CREATE_GOAL_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: renderFlow(CREATE_GOAL_TEXT, 'askName'), handled: true };
  }

  // Step 1: first mention — a keyword hit only, nothing is assumed yet.
  // Skipped for "how do I .../how to ..." questions, which want an
  // explanation (see the FAQ below), not to actually create anything.
  const wantsCreateGoal = !HOW_TO_RE.test(msg)
    && /\b(create|add|start|set ?up|make)\b|erstell|anlegen|hinzufüg|\bcré|\bajout|\bcommenc|\bcrear\b|\bagregar\b|\biniciar\b|إنشاء|إضافة|بدء|созда|добав|начать|\bcriar\b|\biniciar\b|创建|添加|开始/i.test(msg)
    && /\b(goal|target|fund|pledge)\b|\bziel\b|\bfonds\b|\bzusage\b|\bobjectif\b|\bfonds\b|\bpromesse\b|\bmeta\b|\bfondo\b|\bpromesa\b|هدف|صندوق|تعهد|цель|фонд|обещани|\bmeta\b|\bfundo\b|\bpromessa\b|目标|基金|认捐/i.test(msg);
  if (wantsCreateGoal) {
    return { reply: renderFlow(CREATE_GOAL_TEXT, 'confirm'), handled: true };
  }

  return null;
}

// The steps this flow asks, in order. Each question embeds whatever it
// already knows (name, then also mobile, then also goal) directly in its
// own text — recovered from there rather than re-scanning history, same
// approach as create_goal's CREATE_GOAL_TYPE_RE. Localized to all 8 UI
// languages via ADD_SUBSCRIBER_TEXT + compileTemplate. The "ask amount"
// question is unified to one wording used both the first time it's asked
// (after a goal name with no amount) and on retry (amount not understood)
// — the English original varied the example slightly between those two;
// simplified to one template to keep this tractable across 8 languages.
const ADD_SUBSCRIBER_TEXT = {
  en: { confirm: 'Are you saying you\'d like to add a new subscriber?', askName: 'Great — what\'s the subscriber\'s name?', askNameEmpty: 'What\'s the subscriber\'s name?', askMobile: 'What\'s {name}\'s mobile number?', goalOrNot: 'Got it — should I add {name} (mobile {mobile}) as a general subscriber only, or also subscribe them to a specific goal right away? Reply "just add" or say the goal name and their per-period amount, e.g. "Diwali Fund at 500".', askAmount: 'How much should {name} (mobile {mobile}) pay per period for "{goalName}"? Reply e.g. "500".' },
  de: { confirm: 'Möchten Sie einen neuen Abonnenten hinzufügen?', askName: 'Gut — wie heißt der Abonnent?', askNameEmpty: 'Wie heißt der Abonnent?', askMobile: 'Wie lautet die Mobilnummer von {name}?', goalOrNot: 'Verstanden — soll ich {name} (Mobil {mobile}) nur als allgemeinen Abonnenten hinzufügen, oder ihn/sie auch gleich einem bestimmten Ziel zuordnen? Antworten Sie mit "nur hinzufügen" oder nennen Sie den Zielnamen und den Betrag pro Zeitraum, z. B. "Diwali-Fonds mit 500".', askAmount: 'Wie viel soll {name} (Mobil {mobile}) pro Zeitraum für "{goalName}" zahlen? Antworten Sie z. B. mit "500".' },
  fr: { confirm: 'Voulez-vous dire que vous souhaitez ajouter un nouvel abonné ?', askName: 'Très bien — quel est le nom de l\'abonné ?', askNameEmpty: 'Quel est le nom de l\'abonné ?', askMobile: 'Quel est le numéro de mobile de {name} ?', goalOrNot: 'Compris — dois-je ajouter {name} (mobile {mobile}) comme abonné général uniquement, ou aussi l\'inscrire à un objectif précis dès maintenant ? Répondez "juste ajouter" ou indiquez le nom de l\'objectif et le montant par période, ex. "Fonds Diwali à 500".', askAmount: 'Combien {name} (mobile {mobile}) doit-il/elle payer par période pour "{goalName}" ? Répondez par ex. "500".' },
  es: { confirm: '¿Quieres decir que te gustaría agregar un nuevo suscriptor?', askName: 'Genial — ¿cuál es el nombre del suscriptor?', askNameEmpty: '¿Cuál es el nombre del suscriptor?', askMobile: '¿Cuál es el número de móvil de {name}?', goalOrNot: 'Entendido — ¿debo agregar a {name} (móvil {mobile}) solo como suscriptor general, o también suscribirlo a una meta específica ahora mismo? Responde "solo agregar" o indica el nombre de la meta y el monto por período, ej. "Fondo Diwali a 500".', askAmount: '¿Cuánto debería pagar {name} (móvil {mobile}) por período para "{goalName}"? Responde por ejemplo "500".' },
  ar: { confirm: 'هل تقصد أنك تريد إضافة مشترك جديد؟', askName: 'رائع — ما اسم المشترك؟', askNameEmpty: 'ما اسم المشترك؟', askMobile: 'ما رقم جوال {name}؟', goalOrNot: 'فهمت — هل أضيف {name} (الجوال {mobile}) كمشترك عام فقط، أم أشترك أيضًا في هدف محدد الآن؟ رد بـ "فقط أضف" أو اذكر اسم الهدف والمبلغ لكل فترة، مثال "صندوق ديوالي بـ 500".', askAmount: 'كم يجب أن يدفع {name} (الجوال {mobile}) لكل فترة مقابل "{goalName}"؟ رد مثلاً بـ "500".' },
  ru: { confirm: 'Вы хотите добавить нового подписчика?', askName: 'Отлично — как зовут подписчика?', askNameEmpty: 'Как зовут подписчика?', askMobile: 'Какой номер мобильного у {name}?', goalOrNot: 'Понял — добавить {name} (моб. {mobile}) только как обычного подписчика, или сразу подписать на конкретную цель? Ответьте «просто добавь» или укажите название цели и сумму за период, например «Фонд Дивали, 500».', askAmount: 'Сколько должен платить {name} (моб. {mobile}) за период за «{goalName}»? Ответьте, например, «500».' },
  pt: { confirm: 'Você gostaria de adicionar um novo assinante?', askName: 'Ótimo — qual é o nome do assinante?', askNameEmpty: 'Qual é o nome do assinante?', askMobile: 'Qual é o número de celular de {name}?', goalOrNot: 'Entendi — devo adicionar {name} (celular {mobile}) apenas como assinante geral, ou também inscrevê-lo em uma meta específica agora? Responda "apenas adicionar" ou diga o nome da meta e o valor por período, ex. "Fundo Diwali com 500".', askAmount: 'Quanto {name} (celular {mobile}) deve pagar por período para "{goalName}"? Responda, por exemplo, "500".' },
  zh: { confirm: '您是想添加一位新订阅者吗？', askName: '好的 — 订阅者叫什么名字？', askNameEmpty: '订阅者叫什么名字？', askMobile: '{name}的手机号是多少？', goalOrNot: '好的 — 是只将{name}（手机{mobile}）添加为普通订阅者，还是现在就将其订阅到某个具体目标？回复"直接添加"，或说明目标名称和每期金额，例如"排灯节基金 500"。', askAmount: '{name}（手机{mobile}）每期应为"{goalName}"支付多少？例如回复"500"。' }
};

// "no"/"no thanks"/etc. at the goal-or-not step means "no goal, just add
// them" — a normal answer to that specific question, not an abort — so
// that step goes in PENDING_FLOW_STRICT_ABORT_MARKERS (only unambiguous
// wording like "cancel"/"stop" backs out of it) rather than
// PENDING_FLOW_MARKERS (which would treat a bare "no" as an abort).
const ADD_SUBSCRIBER_SKIP_GOAL_RE = /^\s*(?:(?:just add|no goal|no thanks?|general only|none|no|nur hinzufügen|kein ziel|nein danke?|nur allgemein|keine|nein|juste ajouter|pas d'objectif|non merci|général seulement|aucun|non|solo agregar|sin meta|no gracias|solo general|ninguno)\s*[.?!]*|فقط أضف|بدون هدف|لا شكرا|عام فقط|لا شيء|لا|просто добавь|без цели|нет спасибо|только общий|никакой|нет|apenas adicionar|sem meta|não obrigado|apenas geral|nenhum|não|直接添加|不设目标|不用了|仅普通|无|不)\s*$/i;

const ADD_SUBSCRIBER_CONFIRM_RE = new RegExp(Object.values(ADD_SUBSCRIBER_TEXT).map(t => escapeRegExp(t.confirm)).join('|'), 'i');
const ADD_SUBSCRIBER_NAME_RE = new RegExp(Object.values(ADD_SUBSCRIBER_TEXT).map(t => `^${escapeRegExp(t.askName)}$`).join('|'), 'i');
const ADD_SUBSCRIBER_MOBILE_RE = { test: (text) => testFlowAnyLang(ADD_SUBSCRIBER_TEXT, 'askMobile', text) };
const ADD_SUBSCRIBER_GOAL_OR_NOT_RE = { test: (text) => testFlowAnyLang(ADD_SUBSCRIBER_TEXT, 'goalOrNot', text) };
const ADD_SUBSCRIBER_AMOUNT_RE = { test: (text) => testFlowAnyLang(ADD_SUBSCRIBER_TEXT, 'askAmount', text) };

function goalOrNotQuestion(name, mobile) {
  return renderFlow(ADD_SUBSCRIBER_TEXT, 'goalOrNot', { name, mobile });
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
    const extracted = execFlowAnyLang(ADD_SUBSCRIBER_TEXT, 'askAmount', lastAssistant.content);
    const { name, mobile, goalName } = extracted || {};
    const amount = extractBareOrAtAmount(msg);
    if (!amount) {
      return { reply: renderFlow(ADD_SUBSCRIBER_TEXT, 'askAmount', { name, mobile, goalName }), handled: true };
    }
    return { reply: 'Here\'s what I understood:', action: { type: 'add_subscriber', params: { name, mobile, goalName, amount } }, handled: true };
  }

  // Step 5: answering "just add, or also subscribe them to a goal?"
  // ("cancel"/"stop"/etc. here is already handled by cancelPendingFlowIfAny
  // in parseLocalIntent, before this is even reached)
  if (lastAssistant && ADD_SUBSCRIBER_GOAL_OR_NOT_RE.test(lastAssistant.content)) {
    const extracted = execFlowAnyLang(ADD_SUBSCRIBER_TEXT, 'goalOrNot', lastAssistant.content);
    const { name, mobile } = extracted || {};
    if (ADD_SUBSCRIBER_SKIP_GOAL_RE.test(msg)) {
      return { reply: 'Here\'s what I understood:', action: { type: 'add_subscriber', params: { name, mobile } }, handled: true };
    }
    const { rest, amount } = stripTrailingAmount(msg);
    const goalName = rest.trim();
    if (!goalName) return { reply: goalOrNotQuestion(name, mobile), handled: true };
    if (!amount) {
      return { reply: renderFlow(ADD_SUBSCRIBER_TEXT, 'askAmount', { name, mobile, goalName }), handled: true };
    }
    return { reply: 'Here\'s what I understood:', action: { type: 'add_subscriber', params: { name, mobile, goalName, amount } }, handled: true };
  }

  // Step 4: answering "what's X's mobile number?"
  if (lastAssistant && ADD_SUBSCRIBER_MOBILE_RE.test(lastAssistant.content)) {
    const extracted = execFlowAnyLang(ADD_SUBSCRIBER_TEXT, 'askMobile', lastAssistant.content);
    const name = extracted ? extracted.name : '';
    const mobileMatch = msg.match(/\b(\d{6,15})\b/);
    if (!mobileMatch) return { reply: renderFlow(ADD_SUBSCRIBER_TEXT, 'askMobile', { name }), handled: true };
    return { reply: goalOrNotQuestion(name, mobileMatch[1]), handled: true };
  }

  // Step 3: answering "what should the subscriber's name be?" — also
  // accepts the mobile number in the same reply (e.g. "Priya, 9876543210").
  if (lastAssistant && ADD_SUBSCRIBER_NAME_RE.test(lastAssistant.content)) {
    const mobileMatch = msg.match(/\b(\d{6,15})\b/);
    let name = msg.replace(/^(?:it'?s|its|name is|call(?:ed)?)\s+/i, '').replace(/[.?!]+$/, '').trim();
    if (mobileMatch) name = name.replace(mobileMatch[0], '').replace(/[,\s]+$/, '').trim();
    if (!name) return { reply: renderFlow(ADD_SUBSCRIBER_TEXT, 'askNameEmpty'), handled: true };
    if (mobileMatch) return { reply: goalOrNotQuestion(name, mobileMatch[1]), handled: true };
    return { reply: renderFlow(ADD_SUBSCRIBER_TEXT, 'askMobile', { name }), handled: true };
  }

  // Step 2: answering "are you saying you'd like to add a new subscriber?"
  if (lastAssistant && ADD_SUBSCRIBER_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: renderFlow(ADD_SUBSCRIBER_TEXT, 'askName'), handled: true };
  }

  // Step 1: first mention — a keyword hit only, nothing is assumed yet.
  const addSubscriberActionRe = /\b(add|create|register)\b|hinzufüg|registrier|\bajout|\benregistr|\bagregar\b|\bregistrar\b|إضافة|تسجيل|добав|регистр|添加|注册/i;
  const subscriberWordRe = /\b(subscriber|contributor)\b|abonnent|\babonn[ée]|suscriptor|مشترك|подписчик|assinante|订阅者/i;
  const wantsAdd = !HOW_TO_RE.test(msg) && addSubscriberActionRe.test(msg) && subscriberWordRe.test(msg);
  if (wantsAdd) {
    return { reply: renderFlow(ADD_SUBSCRIBER_TEXT, 'confirm'), handled: true };
  }

  return null;
}

const SUBSCRIBE_RE = /\bsubscribe\b\s+([a-z0-9 .'-]+?)\s+\bto\b\s+(?:the\s+)?(?:goal\s+)?["“]?([a-z0-9][a-z0-9 &'-]*?)["”]?(?:\s+goal)?[.?!]*$/i;

// Steps: confirm -> which subscriber -> which goal -> per-period amount.
// The fast path (SUBSCRIBE_RE matching in one shot, e.g. "subscribe Ramesh
// to Diwali Fund at 500") is intentionally NOT localized — it's a one-shot
// English sentence shape that doesn't translate to a single regex across 8
// languages' grammars; non-English users still reach the same result via
// the step-by-step flow below, which IS fully localized. Deliberately keyed
// off the word "subscribe" only (not "add ... to ... goal") to avoid
// colliding with add_subscriber's own trigger words.
const SUBSCRIBE_TO_GOAL_TEXT = {
  en: { confirm: 'Are you saying you\'d like to subscribe someone to a goal?', askWho: 'Great — who should I subscribe?', askWhoEmpty: 'Who should I subscribe?', askGoal: 'Which goal should I subscribe {subscriberName} to?', askAmount: 'How much should {subscriberName} pay per period for "{goalName}"? Reply e.g. "500".' },
  de: { confirm: 'Möchten Sie jemanden für ein Ziel anmelden?', askWho: 'Gut — wen soll ich anmelden?', askWhoEmpty: 'Wen soll ich anmelden?', askGoal: 'Für welches Ziel soll ich {subscriberName} anmelden?', askAmount: 'Wie viel soll {subscriberName} pro Zeitraum für "{goalName}" zahlen? Antworten Sie z. B. mit "500".' },
  fr: { confirm: 'Voulez-vous dire que vous souhaitez inscrire quelqu\'un à un objectif ?', askWho: 'Très bien — qui dois-je inscrire ?', askWhoEmpty: 'Qui dois-je inscrire ?', askGoal: 'À quel objectif dois-je inscrire {subscriberName} ?', askAmount: 'Combien {subscriberName} doit-il/elle payer par période pour "{goalName}" ? Répondez par ex. "500".' },
  es: { confirm: '¿Quieres decir que te gustaría suscribir a alguien a una meta?', askWho: 'Genial — ¿a quién debo suscribir?', askWhoEmpty: '¿A quién debo suscribir?', askGoal: '¿A qué meta debo suscribir a {subscriberName}?', askAmount: '¿Cuánto debería pagar {subscriberName} por período para "{goalName}"? Responde por ejemplo "500".' },
  ar: { confirm: 'هل تقصد أنك تريد اشتراك شخص ما في هدف؟', askWho: 'رائع — من الذي يجب أن أشترك؟', askWhoEmpty: 'من الذي يجب أن أشترك؟', askGoal: 'في أي هدف يجب أن أشترك {subscriberName}؟', askAmount: 'كم يجب أن يدفع {subscriberName} لكل فترة مقابل "{goalName}"؟ رد مثلاً بـ "500".' },
  ru: { confirm: 'Вы хотите подписать кого-то на цель?', askWho: 'Отлично — кого подписать?', askWhoEmpty: 'Кого подписать?', askGoal: 'На какую цель подписать {subscriberName}?', askAmount: 'Сколько должен платить {subscriberName} за период за «{goalName}»? Ответьте, например, «500».' },
  pt: { confirm: 'Você gostaria de inscrever alguém em uma meta?', askWho: 'Ótimo — quem devo inscrever?', askWhoEmpty: 'Quem devo inscrever?', askGoal: 'Em qual meta devo inscrever {subscriberName}?', askAmount: 'Quanto {subscriberName} deve pagar por período para "{goalName}"? Responda, por exemplo, "500".' },
  zh: { confirm: '您是想将某人订阅到一个目标吗？', askWho: '好的 — 应该订阅谁？', askWhoEmpty: '应该订阅谁？', askGoal: '应将{subscriberName}订阅到哪个目标？', askAmount: '{subscriberName}每期应为"{goalName}"支付多少？例如回复"500"。' }
};

const SUBSCRIBE_CONFIRM_RE = new RegExp(Object.values(SUBSCRIBE_TO_GOAL_TEXT).map(t => escapeRegExp(t.confirm)).join('|'), 'i');
const SUBSCRIBE_WHO_RE = new RegExp(Object.values(SUBSCRIBE_TO_GOAL_TEXT).map(t => `^${escapeRegExp(t.askWho)}$`).join('|'), 'i');
const SUBSCRIBE_GOAL_RE = { test: (text) => testFlowAnyLang(SUBSCRIBE_TO_GOAL_TEXT, 'askGoal', text) };
const SUBSCRIBE_AMOUNT_RE = { test: (text) => testFlowAnyLang(SUBSCRIBE_TO_GOAL_TEXT, 'askAmount', text) };
PENDING_FLOW_MARKERS.push(SUBSCRIBE_CONFIRM_RE, SUBSCRIBE_WHO_RE, SUBSCRIBE_GOAL_RE, SUBSCRIBE_AMOUNT_RE);

function parseSubscribeToGoal(msg, history) {
  const { rest, amount: strippedAmount } = stripTrailingAmount(msg);
  const fastMatch = rest.match(SUBSCRIBE_RE) || msg.match(SUBSCRIBE_RE);
  if (fastMatch) {
    const subscriberName = fastMatch[1].trim();
    const goalName = fastMatch[2].trim();
    if (!strippedAmount) {
      return { reply: renderFlow(SUBSCRIBE_TO_GOAL_TEXT, 'askAmount', { subscriberName, goalName }), handled: true };
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
    const extracted = execFlowAnyLang(SUBSCRIBE_TO_GOAL_TEXT, 'askAmount', lastAssistant.content);
    const { subscriberName, goalName } = extracted || {};
    const amount = extractBareOrAtAmount(msg);
    if (!amount) return { reply: renderFlow(SUBSCRIBE_TO_GOAL_TEXT, 'askAmount', { subscriberName, goalName }), handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'subscribe_to_goal', params: { subscriberName, goalName, amount } }, handled: true };
  }

  // Step 3: answering "which goal should I subscribe X to?"
  if (lastAssistant && SUBSCRIBE_GOAL_RE.test(lastAssistant.content)) {
    const extracted = execFlowAnyLang(SUBSCRIBE_TO_GOAL_TEXT, 'askGoal', lastAssistant.content);
    const subscriberName = extracted ? extracted.subscriberName : '';
    const { rest: goalRest, amount } = stripTrailingAmount(msg);
    const goalName = goalRest.replace(/[.?!]+$/, '').trim();
    if (!goalName) return { reply: renderFlow(SUBSCRIBE_TO_GOAL_TEXT, 'askGoal', { subscriberName }), handled: true };
    if (!amount) return { reply: renderFlow(SUBSCRIBE_TO_GOAL_TEXT, 'askAmount', { subscriberName, goalName }), handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'subscribe_to_goal', params: { subscriberName, goalName, amount } }, handled: true };
  }

  // Step 2: answering "who should I subscribe?"
  if (lastAssistant && SUBSCRIBE_WHO_RE.test(lastAssistant.content)) {
    const subscriberName = msg.replace(/[.?!]+$/, '').trim();
    if (!subscriberName) return { reply: renderFlow(SUBSCRIBE_TO_GOAL_TEXT, 'askWhoEmpty'), handled: true };
    return { reply: renderFlow(SUBSCRIBE_TO_GOAL_TEXT, 'askGoal', { subscriberName }), handled: true };
  }

  // Step 1 (confirm): answering "are you saying you'd like to subscribe someone to a goal?"
  if (lastAssistant && SUBSCRIBE_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: renderFlow(SUBSCRIBE_TO_GOAL_TEXT, 'askWho'), handled: true };
  }

  // Step 0: loose keyword hit — "subscribe" without the full one-shot shape
  const subscribeWordRe = /\bsubscribe\b|\banmelden\b|\bs'abonner\b|\binscrire\b|\bsuscribir\b|اشتراك|подписать|\binscrever\b|订阅/i;
  if (!HOW_TO_RE.test(msg) && subscribeWordRe.test(msg)) {
    return { reply: renderFlow(SUBSCRIBE_TO_GOAL_TEXT, 'confirm'), handled: true };
  }

  return null;
}

// Steps: confirm -> who -> which goal -> pledge amount. The fast path
// ("pledge 1000 for Ramesh towards Diwali Fund") is intentionally NOT
// localized — same reasoning as SUBSCRIBE_RE above; non-English users
// still reach the same result via the fully-localized step-by-step flow.
const CREATE_PLEDGE_RE = /\bpledge\b\s+(?:of\s+)?(?:rs\.?|inr|₹|\$|£|€)?\s*(\d+(?:\.\d+)?)\s+for\s+([a-z0-9 .'-]+?)\s+(?:towards|for|to)\s+([a-z0-9 &.'-]+?)[.?!]*$/i;
const CREATE_PLEDGE_TEXT = {
  en: { confirm: 'Are you saying you\'d like to create a pledge?', askWho: 'Great — who is this pledge for?', askWhoEmpty: 'Who is this pledge for?', askGoal: 'Which event/pledge goal is {subscriberName}\'s pledge for?', askAmount: 'How much is {subscriberName} pledging towards "{goalName}"?' },
  de: { confirm: 'Möchten Sie eine Zusage erfassen?', askWho: 'Gut — für wen ist diese Zusage?', askWhoEmpty: 'Für wen ist diese Zusage?', askGoal: 'Für welches Event-/Zusage-Ziel ist die Zusage von {subscriberName}?', askAmount: 'Wie viel sagt {subscriberName} für "{goalName}" zu?' },
  fr: { confirm: 'Voulez-vous dire que vous souhaitez créer une promesse ?', askWho: 'Très bien — pour qui est cette promesse ?', askWhoEmpty: 'Pour qui est cette promesse ?', askGoal: 'Pour quel objectif événement/promesse est la promesse de {subscriberName} ?', askAmount: 'Combien {subscriberName} promet-il/elle pour "{goalName}" ?' },
  es: { confirm: '¿Quieres decir que te gustaría crear una promesa?', askWho: 'Genial — ¿para quién es esta promesa?', askWhoEmpty: '¿Para quién es esta promesa?', askGoal: '¿Para qué meta de evento/promesa es la promesa de {subscriberName}?', askAmount: '¿Cuánto está prometiendo {subscriberName} hacia "{goalName}"?' },
  ar: { confirm: 'هل تقصد أنك تريد إنشاء تعهد؟', askWho: 'رائع — لمن هذا التعهد؟', askWhoEmpty: 'لمن هذا التعهد؟', askGoal: 'لأي هدف فعالية/تعهد هو تعهد {subscriberName}؟', askAmount: 'كم يتعهد {subscriberName} مقابل "{goalName}"؟' },
  ru: { confirm: 'Вы хотите создать обещание?', askWho: 'Отлично — для кого это обещание?', askWhoEmpty: 'Для кого это обещание?', askGoal: 'Для какой цели-мероприятия/обещания это обещание {subscriberName}?', askAmount: 'Сколько обещает {subscriberName} для «{goalName}»?' },
  pt: { confirm: 'Você gostaria de criar uma promessa?', askWho: 'Ótimo — para quem é essa promessa?', askWhoEmpty: 'Para quem é essa promessa?', askGoal: 'Para qual meta de evento/promessa é a promessa de {subscriberName}?', askAmount: 'Quanto {subscriberName} está prometendo para "{goalName}"?' },
  zh: { confirm: '您是想创建一笔认捐吗？', askWho: '好的 — 这笔认捐是给谁的？', askWhoEmpty: '这笔认捐是给谁的？', askGoal: '{subscriberName}的认捐是针对哪个活动/认捐目标？', askAmount: '{subscriberName}为"{goalName}"认捐多少？' }
};

const CREATE_PLEDGE_CONFIRM_RE = new RegExp(Object.values(CREATE_PLEDGE_TEXT).map(t => escapeRegExp(t.confirm)).join('|'), 'i');
const CREATE_PLEDGE_WHO_RE = new RegExp(Object.values(CREATE_PLEDGE_TEXT).map(t => `^${escapeRegExp(t.askWho)}$`).join('|'), 'i');
const CREATE_PLEDGE_GOAL_RE = { test: (text) => testFlowAnyLang(CREATE_PLEDGE_TEXT, 'askGoal', text) };
const CREATE_PLEDGE_AMOUNT_RE = { test: (text) => testFlowAnyLang(CREATE_PLEDGE_TEXT, 'askAmount', text) };
PENDING_FLOW_MARKERS.push(CREATE_PLEDGE_CONFIRM_RE, CREATE_PLEDGE_WHO_RE, CREATE_PLEDGE_GOAL_RE, CREATE_PLEDGE_AMOUNT_RE);

// Shared with the pledge step-0 exclusion check below — "create a pledge"
// in any of the 8 languages means a new pledge-category GOAL (create_goal),
// not recording an existing subscriber's pledge amount.
const CREATE_ACTION_WORDS_RE = /\b(create|add|start|set ?up)\b|erstell|anlegen|hinzufüg|\bcré|\bajout|\bcommenc|\bcrear\b|\bagregar\b|\biniciar\b|إنشاء|إضافة|بدء|созда|добав|начать|\bcriar\b|创建|添加|开始/i;

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
    const extracted = execFlowAnyLang(CREATE_PLEDGE_TEXT, 'askAmount', lastAssistant.content);
    const { subscriberName, goalName } = extracted || {};
    const amount = extractBareOrAtAmount(msg);
    if (!amount) return { reply: renderFlow(CREATE_PLEDGE_TEXT, 'askAmount', { subscriberName, goalName }), handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'create_pledge', params: { amount, subscriberName, goalName } }, handled: true };
  }

  // Step 3: answering "which event/pledge goal is X's pledge for?"
  if (lastAssistant && CREATE_PLEDGE_GOAL_RE.test(lastAssistant.content)) {
    const extracted = execFlowAnyLang(CREATE_PLEDGE_TEXT, 'askGoal', lastAssistant.content);
    const subscriberName = extracted ? extracted.subscriberName : '';
    const { rest, amount } = stripTrailingAmount(msg);
    const goalName = rest.replace(/[.?!]+$/, '').trim();
    if (!goalName) return { reply: renderFlow(CREATE_PLEDGE_TEXT, 'askGoal', { subscriberName }), handled: true };
    if (!amount) return { reply: renderFlow(CREATE_PLEDGE_TEXT, 'askAmount', { subscriberName, goalName }), handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'create_pledge', params: { amount, subscriberName, goalName } }, handled: true };
  }

  // Step 2: answering "who is this pledge for?"
  if (lastAssistant && CREATE_PLEDGE_WHO_RE.test(lastAssistant.content)) {
    const subscriberName = msg.replace(/[.?!]+$/, '').trim();
    if (!subscriberName) return { reply: renderFlow(CREATE_PLEDGE_TEXT, 'askWhoEmpty'), handled: true };
    return { reply: renderFlow(CREATE_PLEDGE_TEXT, 'askGoal', { subscriberName }), handled: true };
  }

  // Step 1 (confirm)
  if (lastAssistant && CREATE_PLEDGE_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: renderFlow(CREATE_PLEDGE_TEXT, 'askWho'), handled: true };
  }

  // Step 0: loose "pledge" keyword hit, not matching the one-shot shape.
  // Excludes create/add/start/setup wording — "create a pledge" means a
  // new pledge-category GOAL (create_goal, handled by parseCreateGoal),
  // not recording an existing subscriber's pledge amount against one.
  const pledgeWordRe = /\bpledge\b|\bzusage\b|\bpromesse\b|\bpromesa\b|تعهد|обещани|\bpromessa\b|认捐/i;
  if (!HOW_TO_RE.test(msg) && pledgeWordRe.test(msg) && !CREATE_ACTION_WORDS_RE.test(msg)) {
    return { reply: renderFlow(CREATE_PLEDGE_TEXT, 'confirm'), handled: true };
  }

  return null;
}

// Steps: confirm -> which goal. Fast path ("mark Diwali Fund as complete" /
// "complete the Diwali Fund goal") is intentionally NOT localized — same
// reasoning as SUBSCRIBE_RE/CREATE_PLEDGE_RE, a one-shot English sentence
// shape that doesn't translate to a single regex across 8 languages;
// non-English users still reach the same result via the fully localized
// step-by-step flow below.
const MARK_COMPLETE_TEXT = {
  en: { confirm: 'Are you saying you\'d like to mark a goal complete?', askName: 'Great — which goal should I mark complete?', askNameEmpty: 'Which goal should I mark complete?' },
  de: { confirm: 'Möchten Sie ein Ziel als abgeschlossen markieren?', askName: 'Gut — welches Ziel soll ich als abgeschlossen markieren?', askNameEmpty: 'Welches Ziel soll ich als abgeschlossen markieren?' },
  fr: { confirm: 'Voulez-vous dire que vous souhaitez marquer un objectif comme terminé ?', askName: 'Très bien — quel objectif dois-je marquer comme terminé ?', askNameEmpty: 'Quel objectif dois-je marquer comme terminé ?' },
  es: { confirm: '¿Quieres decir que te gustaría marcar una meta como completada?', askName: 'Genial — ¿qué meta debo marcar como completada?', askNameEmpty: '¿Qué meta debo marcar como completada?' },
  ar: { confirm: 'هل تقصد أنك تريد وضع علامة على هدف كمكتمل؟', askName: 'رائع — ما الهدف الذي يجب أن أضع عليه علامة مكتمل؟', askNameEmpty: 'ما الهدف الذي يجب أن أضع عليه علامة مكتمل؟' },
  ru: { confirm: 'Вы хотите отметить цель как завершённую?', askName: 'Отлично — какую цель отметить завершённой?', askNameEmpty: 'Какую цель отметить завершённой?' },
  pt: { confirm: 'Você gostaria de marcar uma meta como concluída?', askName: 'Ótimo — qual meta devo marcar como concluída?', askNameEmpty: 'Qual meta devo marcar como concluída?' },
  zh: { confirm: '您是想将一个目标标记为已完成吗？', askName: '好的 — 应该将哪个目标标记为已完成？', askNameEmpty: '应该将哪个目标标记为已完成？' }
};
const MARK_COMPLETE_CONFIRM_RE = new RegExp(Object.values(MARK_COMPLETE_TEXT).map(t => escapeRegExp(t.confirm)).join('|'), 'i');
const MARK_COMPLETE_NAME_RE = new RegExp(Object.values(MARK_COMPLETE_TEXT).map(t => `^${escapeRegExp(t.askName)}$`).join('|'), 'i');
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
    if (!goalName) return { reply: renderFlow(MARK_COMPLETE_TEXT, 'askNameEmpty'), handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'mark_goal_complete', params: { goalName } }, handled: true };
  }

  if (lastAssistant && MARK_COMPLETE_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: renderFlow(MARK_COMPLETE_TEXT, 'askName'), handled: true };
  }

  const completeWordRe = /\bcomplete\b|abgeschlossen|erledigt|terminé|complété|completad[oa]|completa|مكتمل|завершен|заверш|concluíd[oa]|完成/i;
  const markOrGoalWordRe = /\bgoal\b|\bmark\b|\bziel\b|markier|\bobjectif\b|marquer|\bmeta\b|marcar|هدف|علامة|цел|отмет|目标|标记/i;
  if (!HOW_TO_RE.test(msg) && completeWordRe.test(msg) && markOrGoalWordRe.test(msg)) {
    return { reply: renderFlow(MARK_COMPLETE_TEXT, 'confirm'), handled: true };
  }

  return null;
}

// Steps: confirm -> which goal. Fast path ("stop Cleaning Charges from
// rolling over" / "turn off rollover for Cleaning Charges") is intentionally
// NOT localized — same one-shot-English-shape reasoning as above.
const STOP_ROLLOVER_TEXT = {
  en: { confirm: 'Are you saying you\'d like to stop a goal from rolling over?', askName: 'Great — which goal should I stop from rolling over?', askNameEmpty: 'Which goal should I stop from rolling over?' },
  de: { confirm: 'Möchten Sie verhindern, dass ein Ziel übertragen wird?', askName: 'Gut — bei welchem Ziel soll ich die Übertragung stoppen?', askNameEmpty: 'Bei welchem Ziel soll ich die Übertragung stoppen?' },
  fr: { confirm: 'Voulez-vous dire que vous souhaitez empêcher un objectif de se reporter ?', askName: 'Très bien — pour quel objectif dois-je arrêter le report ?', askNameEmpty: 'Pour quel objectif dois-je arrêter le report ?' },
  es: { confirm: '¿Quieres decir que te gustaría detener el traspaso de una meta?', askName: 'Genial — ¿para qué meta debo detener el traspaso?', askNameEmpty: '¿Para qué meta debo detener el traspaso?' },
  ar: { confirm: 'هل تقصد أنك تريد إيقاف ترحيل هدف؟', askName: 'رائع — لأي هدف يجب أن أوقف الترحيل؟', askNameEmpty: 'لأي هدف يجب أن أوقف الترحيل؟' },
  ru: { confirm: 'Вы хотите остановить перенос цели на следующий период?', askName: 'Отлично — для какой цели остановить перенос?', askNameEmpty: 'Для какой цели остановить перенос?' },
  pt: { confirm: 'Você gostaria de impedir que uma meta seja transferida para o próximo período?', askName: 'Ótimo — para qual meta devo impedir a transferência?', askNameEmpty: 'Para qual meta devo impedir a transferência?' },
  zh: { confirm: '您是想停止某个目标的结转吗？', askName: '好的 — 应该停止哪个目标的结转？', askNameEmpty: '应该停止哪个目标的结转？' }
};
const STOP_ROLLOVER_CONFIRM_RE = new RegExp(Object.values(STOP_ROLLOVER_TEXT).map(t => escapeRegExp(t.confirm)).join('|'), 'i');
const STOP_ROLLOVER_NAME_RE = new RegExp(Object.values(STOP_ROLLOVER_TEXT).map(t => `^${escapeRegExp(t.askName)}$`).join('|'), 'i');
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
    if (!goalName) return { reply: renderFlow(STOP_ROLLOVER_TEXT, 'askNameEmpty'), handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'stop_rollover', params: { goalName } }, handled: true };
  }

  if (lastAssistant && STOP_ROLLOVER_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: renderFlow(STOP_ROLLOVER_TEXT, 'askName'), handled: true };
  }

  const rolloverWordRe = /\brollover\b|\brolling over\b|übertrag|\breport\b|reporter|traspaso|ترحيل|перенос|transferência|结转/i;
  const stopWordRe = /\b(stop|turn off|disable)\b|stoppen|verhindern|arrêter|empêcher|\bdetener\b|\bimpedir\b|إيقاف|أوقف|остановить|停止/i;
  if (!HOW_TO_RE.test(msg) && rolloverWordRe.test(msg) && stopWordRe.test(msg)) {
    return { reply: renderFlow(STOP_ROLLOVER_TEXT, 'confirm'), handled: true };
  }

  return null;
}

// Steps: confirm -> amount -> category (-> optional description folded into
// the category answer if present). Fast path ("add an expense of 2000 for
// flowers, category event expenses") is intentionally NOT localized — same
// one-shot-English-shape reasoning as mark_goal_complete/stop_rollover.
// The category question embeds the amount mid-sentence, so — like
// CREATE_GOAL_TEXT.askType — it's built from a prefix/middle/suffix split
// around the {amount} token rather than a single compileTemplate token,
// since the category LIST after it is itself a dynamic, translated join.
const ADD_EXPENSE_TEXT = {
  en: { confirm: 'Are you saying you\'d like to add an expense?', askAmount: 'Great — how much was the expense?', askAmountEmpty: 'How much was the expense?', categoryQPrefix: 'What category is this ', categoryQMiddle: ' expense — one of: ', categoryQSuffix: '?' },
  de: { confirm: 'Möchten Sie eine Ausgabe hinzufügen?', askAmount: 'Gut — wie hoch war die Ausgabe?', askAmountEmpty: 'Wie hoch war die Ausgabe?', categoryQPrefix: 'Welcher Kategorie gehört diese Ausgabe über ', categoryQMiddle: ' an — eine von: ', categoryQSuffix: '?' },
  fr: { confirm: 'Voulez-vous dire que vous souhaitez ajouter une dépense ?', askAmount: 'Très bien — combien s\'élevait la dépense ?', askAmountEmpty: 'Combien s\'élevait la dépense ?', categoryQPrefix: 'À quelle catégorie appartient cette dépense de ', categoryQMiddle: ' — l\'une de : ', categoryQSuffix: ' ?' },
  es: { confirm: '¿Quieres decir que te gustaría agregar un gasto?', askAmount: 'Genial — ¿cuánto fue el gasto?', askAmountEmpty: '¿Cuánto fue el gasto?', categoryQPrefix: '¿A qué categoría pertenece este gasto de ', categoryQMiddle: ' — una de: ', categoryQSuffix: '?' },
  ar: { confirm: 'هل تقصد أنك تريد إضافة مصروف؟', askAmount: 'رائع — كم كان المصروف؟', askAmountEmpty: 'كم كان المصروف؟', categoryQPrefix: 'ما فئة هذا المصروف البالغ ', categoryQMiddle: ' — واحدة من: ', categoryQSuffix: '؟' },
  ru: { confirm: 'Вы хотите добавить расход?', askAmount: 'Отлично — сколько составил расход?', askAmountEmpty: 'Сколько составил расход?', categoryQPrefix: 'К какой категории относится этот расход на сумму ', categoryQMiddle: ' — одна из: ', categoryQSuffix: '?' },
  pt: { confirm: 'Você gostaria de adicionar uma despesa?', askAmount: 'Ótimo — qual foi o valor da despesa?', askAmountEmpty: 'Qual foi o valor da despesa?', categoryQPrefix: 'A qual categoria pertence esta despesa de ', categoryQMiddle: ' — uma de: ', categoryQSuffix: '?' },
  zh: { confirm: '您是想添加一笔支出吗？', askAmount: '好的 — 这笔支出是多少？', askAmountEmpty: '这笔支出是多少？', categoryQPrefix: '这笔', categoryQMiddle: '的支出属于哪个类别 — 以下之一：', categoryQSuffix: '？' }
};
const ADD_EXPENSE_CONFIRM_RE = new RegExp(Object.values(ADD_EXPENSE_TEXT).map(t => escapeRegExp(t.confirm)).join('|'), 'i');
const ADD_EXPENSE_AMOUNT_RE = new RegExp(Object.values(ADD_EXPENSE_TEXT).map(t => `^${escapeRegExp(t.askAmount)}$`).join('|'), 'i');
const ADD_EXPENSE_CATEGORY_RE = new RegExp(Object.values(ADD_EXPENSE_TEXT).map(t => `^${escapeRegExp(t.categoryQPrefix)}`).join('|'), 'i');
PENDING_FLOW_MARKERS.push(ADD_EXPENSE_CONFIRM_RE, ADD_EXPENSE_AMOUNT_RE, ADD_EXPENSE_CATEGORY_RE);

function expenseCategoryQuestion(amount) {
  const t = ADD_EXPENSE_TEXT[currentLang] || ADD_EXPENSE_TEXT.en;
  return `${t.categoryQPrefix}${formatMoney(amount)}${t.categoryQMiddle}${expenseCategoryNames().join(', ')}${t.categoryQSuffix}`;
}

function extractExpenseCategoryQuestionAmount(text) {
  for (const t of Object.values(ADD_EXPENSE_TEXT)) {
    const m = text.match(new RegExp(`^${escapeRegExp(t.categoryQPrefix)}([\\d,.]+)`, 'i'));
    if (m) return Number(m[1].replace(/,/g, '')) || 0;
  }
  return 0;
}

const ADD_EXPENSE_ACTION_WORDS_RE = /\b(add|log|record)\b|hinzufüg|\bajout|\benregistr|\bagregar\b|\bregistrar\b|إضافة|تسجيل|добав|регистр|添加|记录/i;
const EXPENSE_WORD_RE = /\bexpense\b|ausgabe|dépense|gasto|مصروف|расход|despesa|支出/i;

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
    return { reply: expenseCategoryQuestion(amount), handled: true };
  }

  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 3: answering the category question
  if (lastAssistant && ADD_EXPENSE_CATEGORY_RE.test(lastAssistant.content)) {
    const amount = extractExpenseCategoryQuestionAmount(lastAssistant.content);
    const category = matchExpenseCategory(msg);
    if (!category) return { reply: expenseCategoryQuestion(amount), handled: true };
    const forMatch = msg.match(/\bfor\s+([a-z0-9 .'-]+?)[.?!]*$/i);
    const description = forMatch ? forMatch[1].trim() : '';
    return { reply: 'Here\'s what I understood:', action: { type: 'add_expense', params: { amount, description, category } }, handled: true };
  }

  // Step 2: answering "how much was the expense?"
  if (lastAssistant && ADD_EXPENSE_AMOUNT_RE.test(lastAssistant.content)) {
    const amount = extractBareOrAtAmount(msg);
    if (!amount) return { reply: renderFlow(ADD_EXPENSE_TEXT, 'askAmountEmpty'), handled: true };
    const category = matchExpenseCategory(msg);
    if (category) {
      return { reply: 'Here\'s what I understood:', action: { type: 'add_expense', params: { amount, description: '', category } }, handled: true };
    }
    return { reply: expenseCategoryQuestion(amount), handled: true };
  }

  // Step 1 (confirm)
  if (lastAssistant && ADD_EXPENSE_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: renderFlow(ADD_EXPENSE_TEXT, 'askAmount'), handled: true };
  }

  if (!HOW_TO_RE.test(msg) && EXPENSE_WORD_RE.test(msg) && ADD_EXPENSE_ACTION_WORDS_RE.test(msg)) {
    return { reply: renderFlow(ADD_EXPENSE_TEXT, 'confirm'), handled: true };
  }

  return null;
}

function formatMoney(n) {
  return (n || 0).toLocaleString('en-IN');
}

// Steps: confirm -> name -> mobile -> category. Fast path ("add a payee
// named XYZ Supplies, mobile 9998887776, category Maintenance") is
// intentionally NOT localized, same reasoning as the other flows above.
// The category question's option LIST is constant per language (not a
// runtime value), so it's baked directly into each language's template
// text via EXPENSE_CATEGORY_TRANSLATIONS rather than joined at render time.
const ADD_PAYEE_TEXT = {
  en: { confirm: 'Are you saying you\'d like to add a new payee?', askName: 'Great — what\'s the payee\'s name?', askNameEmpty: 'What\'s the payee\'s name?', askMobile: 'What\'s {name}\'s mobile number? (payee)', askCategory: `What category is {name} (mobile {mobile}) for — one of: ${EXPENSE_CATEGORY_TRANSLATIONS.en.join(', ')}?` },
  de: { confirm: 'Möchten Sie einen neuen Zahlungsempfänger hinzufügen?', askName: 'Gut — wie heißt der Zahlungsempfänger?', askNameEmpty: 'Wie heißt der Zahlungsempfänger?', askMobile: 'Wie lautet die Handynummer von {name}? (Zahlungsempfänger)', askCategory: `Welcher Kategorie gehört {name} (Handynummer {mobile}) an — eine von: ${EXPENSE_CATEGORY_TRANSLATIONS.de.join(', ')}?` },
  fr: { confirm: 'Voulez-vous dire que vous souhaitez ajouter un nouveau bénéficiaire ?', askName: 'Très bien — quel est le nom du bénéficiaire ?', askNameEmpty: 'Quel est le nom du bénéficiaire ?', askMobile: 'Quel est le numéro de mobile de {name} ? (bénéficiaire)', askCategory: `À quelle catégorie appartient {name} (mobile {mobile}) — l'une de : ${EXPENSE_CATEGORY_TRANSLATIONS.fr.join(', ')} ?` },
  es: { confirm: '¿Quieres decir que te gustaría agregar un nuevo beneficiario?', askName: 'Genial — ¿cuál es el nombre del beneficiario?', askNameEmpty: '¿Cuál es el nombre del beneficiario?', askMobile: '¿Cuál es el número de móvil de {name}? (beneficiario)', askCategory: `¿A qué categoría pertenece {name} (móvil {mobile}) — una de: ${EXPENSE_CATEGORY_TRANSLATIONS.es.join(', ')}?` },
  ar: { confirm: 'هل تقصد أنك تريد إضافة مستفيد جديد؟', askName: 'رائع — ما اسم المستفيد؟', askNameEmpty: 'ما اسم المستفيد؟', askMobile: 'ما رقم جوال {name}؟ (مستفيد)', askCategory: `ما فئة {name} (جوال {mobile}) — واحدة من: ${EXPENSE_CATEGORY_TRANSLATIONS.ar.join('، ')}؟` },
  ru: { confirm: 'Вы хотите добавить нового получателя?', askName: 'Отлично — как зовут получателя?', askNameEmpty: 'Как зовут получателя?', askMobile: 'Какой номер мобильного у {name}? (получатель)', askCategory: `К какой категории относится {name} (мобильный {mobile}) — одна из: ${EXPENSE_CATEGORY_TRANSLATIONS.ru.join(', ')}?` },
  pt: { confirm: 'Você gostaria de adicionar um novo beneficiário?', askName: 'Ótimo — qual é o nome do beneficiário?', askNameEmpty: 'Qual é o nome do beneficiário?', askMobile: 'Qual é o número de celular de {name}? (beneficiário)', askCategory: `A qual categoria pertence {name} (celular {mobile}) — uma de: ${EXPENSE_CATEGORY_TRANSLATIONS.pt.join(', ')}?` },
  zh: { confirm: '您是想添加一个新的收款人吗？', askName: '好的 — 收款人叫什么名字？', askNameEmpty: '收款人叫什么名字？', askMobile: '{name}的手机号是多少？（收款人）', askCategory: `{name}（手机{mobile}）属于哪个类别 — 以下之一：${EXPENSE_CATEGORY_TRANSLATIONS.zh.join('、')}？` }
};
const ADD_PAYEE_CONFIRM_RE = new RegExp(Object.values(ADD_PAYEE_TEXT).map(t => escapeRegExp(t.confirm)).join('|'), 'i');
const ADD_PAYEE_NAME_RE = new RegExp(Object.values(ADD_PAYEE_TEXT).map(t => `^${escapeRegExp(t.askName)}$`).join('|'), 'i');
const ADD_PAYEE_MOBILE_RE = { test: (text) => testFlowAnyLang(ADD_PAYEE_TEXT, 'askMobile', text) };
const ADD_PAYEE_CATEGORY_RE = { test: (text) => testFlowAnyLang(ADD_PAYEE_TEXT, 'askCategory', text) };
PENDING_FLOW_MARKERS.push(ADD_PAYEE_CONFIRM_RE, ADD_PAYEE_NAME_RE, ADD_PAYEE_MOBILE_RE, ADD_PAYEE_CATEGORY_RE);

const ADD_PAYEE_ACTION_WORDS_RE = /\b(add|create|register)\b|hinzufüg|\bajout|\benregistr|\bagregar\b|\bregistrar\b|إضافة|تسجيل|добав|регистр|添加|注册/i;
const PAYEE_WORD_RE = /\bpayee\b|zahlungsempfänger|bénéficiaire|beneficiario|مستفيد|получател|beneficiário|收款人/i;

function parseAddPayee(msg, history) {
  const fastNameMobile = extractNameMobile(msg, 'payee');
  if (fastNameMobile.name && fastNameMobile.mobile) {
    const catMatch = msg.match(/\bcategory\s+([a-z &]+?)[.?!]*$/i);
    const category = catMatch ? matchExpenseCategory(catMatch[1]) : matchExpenseCategory(msg);
    if (category) {
      return { reply: 'Here\'s what I understood:', action: { type: 'add_payee', params: { name: fastNameMobile.name, mobile: fastNameMobile.mobile, category } }, handled: true };
    }
    return { reply: renderFlow(ADD_PAYEE_TEXT, 'askCategory', { name: fastNameMobile.name, mobile: fastNameMobile.mobile }), handled: true };
  }

  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 4: answering the category question
  if (lastAssistant && ADD_PAYEE_CATEGORY_RE.test(lastAssistant.content)) {
    const extracted = execFlowAnyLang(ADD_PAYEE_TEXT, 'askCategory', lastAssistant.content);
    const { name, mobile } = extracted || {};
    const category = matchExpenseCategory(msg);
    if (!category) return { reply: renderFlow(ADD_PAYEE_TEXT, 'askCategory', { name, mobile }), handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'add_payee', params: { name, mobile, category } }, handled: true };
  }

  // Step 3: answering "what's X's mobile number?"
  if (lastAssistant && ADD_PAYEE_MOBILE_RE.test(lastAssistant.content)) {
    const extracted = execFlowAnyLang(ADD_PAYEE_TEXT, 'askMobile', lastAssistant.content);
    const name = extracted ? extracted.name : '';
    const mobileMatch = msg.match(/\b(\d{6,15})\b/);
    if (!mobileMatch) return { reply: renderFlow(ADD_PAYEE_TEXT, 'askMobile', { name }), handled: true };
    return { reply: renderFlow(ADD_PAYEE_TEXT, 'askCategory', { name, mobile: mobileMatch[1] }), handled: true };
  }

  // Step 2: answering "what's the payee's name?"
  if (lastAssistant && ADD_PAYEE_NAME_RE.test(lastAssistant.content)) {
    const mobileMatch = msg.match(/\b(\d{6,15})\b/);
    let name = msg.replace(/^(?:it'?s|its|name is|call(?:ed)?)\s+/i, '').replace(/[.?!]+$/, '').trim();
    if (mobileMatch) name = name.replace(mobileMatch[0], '').replace(/[,\s]+$/, '').trim();
    if (!name) return { reply: renderFlow(ADD_PAYEE_TEXT, 'askNameEmpty'), handled: true };
    if (mobileMatch) return { reply: renderFlow(ADD_PAYEE_TEXT, 'askCategory', { name, mobile: mobileMatch[1] }), handled: true };
    return { reply: renderFlow(ADD_PAYEE_TEXT, 'askMobile', { name }), handled: true };
  }

  // Step 1 (confirm)
  if (lastAssistant && ADD_PAYEE_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: renderFlow(ADD_PAYEE_TEXT, 'askName'), handled: true };
  }

  if (!HOW_TO_RE.test(msg) && PAYEE_WORD_RE.test(msg) && ADD_PAYEE_ACTION_WORDS_RE.test(msg)) {
    return { reply: renderFlow(ADD_PAYEE_TEXT, 'confirm'), handled: true };
  }

  return null;
}

function matchTicketCategory(text) {
  const norm = text.toLowerCase();
  if (/bill/.test(norm)) return 'billing';
  if (/collect|einzieh|encaiss|cobrar|تحصيل|прин[яи]|cobranç|收款|收取/i.test(norm)) return 'collection';
  if (/receipt|pdf|beleg|reçu|recibo|إيصال|квитанц|recibo|收据/i.test(norm)) return 'receipt_pdf';
  if (/import|importier|importer|importar|استيراد|импорт|导入/i.test(norm)) return 'import_subscribers';
  return 'other';
}

// Steps: confirm -> description (category classified from it, defaulting to
// "other" — low-stakes support routing, not a financial/data-shape
// decision, so unlike goal category this never blocks on a clarifying
// question). Fast path ("raise a support ticket about payment delay")
// is intentionally NOT localized, same reasoning as the other flows above
// — the free-text description itself is stored verbatim in whatever
// language the user typed it, regardless of which language triggered this.
const RAISE_TICKET_TEXT = {
  en: { confirm: 'Are you saying you\'d like to raise a support ticket?', askDesc: 'Great — what\'s the issue?', askDescEmpty: 'What\'s the issue?' },
  de: { confirm: 'Möchten Sie ein Support-Ticket erstellen?', askDesc: 'Gut — worum geht es?', askDescEmpty: 'Worum geht es?' },
  fr: { confirm: 'Voulez-vous dire que vous souhaitez ouvrir un ticket d\'assistance ?', askDesc: 'Très bien — quel est le problème ?', askDescEmpty: 'Quel est le problème ?' },
  es: { confirm: '¿Quieres decir que te gustaría abrir un ticket de soporte?', askDesc: 'Genial — ¿cuál es el problema?', askDescEmpty: '¿Cuál es el problema?' },
  ar: { confirm: 'هل تقصد أنك تريد فتح تذكرة دعم؟', askDesc: 'رائع — ما المشكلة؟', askDescEmpty: 'ما المشكلة؟' },
  ru: { confirm: 'Вы хотите создать заявку в поддержку?', askDesc: 'Отлично — в чём проблема?', askDescEmpty: 'В чём проблема?' },
  pt: { confirm: 'Você gostaria de abrir um chamado de suporte?', askDesc: 'Ótimo — qual é o problema?', askDescEmpty: 'Qual é o problema?' },
  zh: { confirm: '您是想提交一个支持工单吗？', askDesc: '好的 — 是什么问题？', askDescEmpty: '是什么问题？' }
};
const RAISE_TICKET_CONFIRM_RE = new RegExp(Object.values(RAISE_TICKET_TEXT).map(t => escapeRegExp(t.confirm)).join('|'), 'i');
const RAISE_TICKET_DESC_RE = new RegExp(Object.values(RAISE_TICKET_TEXT).map(t => `^${escapeRegExp(t.askDesc)}$`).join('|'), 'i');
PENDING_FLOW_MARKERS.push(RAISE_TICKET_CONFIRM_RE, RAISE_TICKET_DESC_RE);

const RAISE_TICKET_ACTION_WORDS_RE = /\b(raise|open|create|submit)\b|erstell|öffnen|\bouvrir\b|\bcréer\b|\babrir\b|\bcrear\b|فتح|إنشاء|создать|открыть|abrir|criar|提交|创建/i;
const TICKET_WORD_RE = /\bticket\b|تذكرة|заявк|工单/i;

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
    if (!msg.trim()) return { reply: renderFlow(RAISE_TICKET_TEXT, 'askDescEmpty'), handled: true };
    return raiseTicketFromText(msg);
  }

  if (lastAssistant && RAISE_TICKET_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: renderFlow(RAISE_TICKET_TEXT, 'askDesc'), handled: true };
  }

  if (!HOW_TO_RE.test(msg) && TICKET_WORD_RE.test(msg) && RAISE_TICKET_ACTION_WORDS_RE.test(msg)) {
    // If the message already carries a real description beyond just "raise
    // a ticket", skip the confirm question — it's unambiguous either way.
    // Checked by stripping the action/ticket words themselves (in whichever
    // language matched) plus common filler and seeing if anything is left,
    // rather than one fixed English sentence shape.
    const stripped = msg
      .replace(new RegExp(RAISE_TICKET_ACTION_WORDS_RE.source, 'gi'), '')
      .replace(new RegExp(TICKET_WORD_RE.source, 'gi'), '')
      .replace(/\b(a|the|please|support)\b/gi, '')
      .replace(/[.?!,]/g, '')
      .trim();
    if (stripped) return raiseTicketFromText(msg);
    return { reply: renderFlow(RAISE_TICKET_TEXT, 'confirm'), handled: true };
  }

  return null;
}

// Steps: confirm -> which field (mobile or name) -> new value. Fast path
// ("change Ramesh's mobile number to 9998887766" / "change Ramesh's name to
// Suresh") is intentionally NOT localized — same one-shot-English-shape
// reasoning as mark_goal_complete/stop_rollover/add_expense above. The
// value-question is split into two separate fixed templates (askValueMobile/
// askValueName) rather than one with an embedded {field} token, so the
// field type can be recovered from WHICH template matched instead of
// string-comparing a translated word — mirrors CREATE_GOAL_TEXT.askType.
const EDIT_SUBSCRIBER_TEXT = {
  en: { confirm: 'Are you saying you\'d like to edit a subscriber\'s details?', askWho: 'Great — which subscriber, and should I change their mobile number or their name?', askWhoEmpty: 'Which subscriber, and should I change their mobile number or their name?', askFieldOnly: 'Should I change {name}\'s mobile number or their name?', askValueMobile: 'What should {name}\'s mobile number be changed to?', askValueName: 'What should {name}\'s name be changed to?' },
  de: { confirm: 'Möchten Sie die Daten eines Abonnenten bearbeiten?', askWho: 'Gut — welcher Abonnent, und soll ich die Handynummer oder den Namen ändern?', askWhoEmpty: 'Welcher Abonnent, und soll ich die Handynummer oder den Namen ändern?', askFieldOnly: 'Soll ich die Handynummer oder den Namen von {name} ändern?', askValueMobile: 'Auf welche Handynummer soll die von {name} geändert werden?', askValueName: 'Wie soll der Name von {name} geändert werden?' },
  fr: { confirm: 'Voulez-vous dire que vous souhaitez modifier les informations d\'un abonné ?', askWho: 'Très bien — quel abonné, et dois-je modifier son numéro de mobile ou son nom ?', askWhoEmpty: 'Quel abonné, et dois-je modifier son numéro de mobile ou son nom ?', askFieldOnly: 'Dois-je modifier le numéro de mobile ou le nom de {name} ?', askValueMobile: 'Quel doit être le nouveau numéro de mobile de {name} ?', askValueName: 'Quel doit être le nouveau nom de {name} ?' },
  es: { confirm: '¿Quieres decir que te gustaría editar los datos de un suscriptor?', askWho: 'Genial — ¿qué suscriptor, y debo cambiar su número de móvil o su nombre?', askWhoEmpty: '¿Qué suscriptor, y debo cambiar su número de móvil o su nombre?', askFieldOnly: '¿Debo cambiar el número de móvil o el nombre de {name}?', askValueMobile: '¿A qué número de móvil se debe cambiar el de {name}?', askValueName: '¿A qué nombre se debe cambiar el de {name}?' },
  ar: { confirm: 'هل تقصد أنك تريد تعديل بيانات مشترك؟', askWho: 'رائع — أي مشترك، وهل يجب أن أغيّر رقم جواله أم اسمه؟', askWhoEmpty: 'أي مشترك، وهل يجب أن أغيّر رقم جواله أم اسمه؟', askFieldOnly: 'هل يجب أن أغيّر رقم جوال {name} أم اسمه؟', askValueMobile: 'إلام يجب تغيير رقم جوال {name}؟', askValueName: 'إلام يجب تغيير اسم {name}؟' },
  ru: { confirm: 'Вы хотите изменить данные подписчика?', askWho: 'Отлично — какой подписчик, и что изменить: номер мобильного или имя?', askWhoEmpty: 'Какой подписчик, и что изменить: номер мобильного или имя?', askFieldOnly: 'Изменить номер мобильного или имя {name}?', askValueMobile: 'На какой номер мобильного изменить номер {name}?', askValueName: 'На какое имя изменить имя {name}?' },
  pt: { confirm: 'Você gostaria de editar os dados de um assinante?', askWho: 'Ótimo — qual assinante, e devo alterar o número de celular ou o nome?', askWhoEmpty: 'Qual assinante, e devo alterar o número de celular ou o nome?', askFieldOnly: 'Devo alterar o número de celular ou o nome de {name}?', askValueMobile: 'Para qual número de celular devo alterar o de {name}?', askValueName: 'Para qual nome devo alterar o de {name}?' },
  zh: { confirm: '您是想编辑订阅者的信息吗？', askWho: '好的 — 是哪位订阅者，需要修改手机号还是姓名？', askWhoEmpty: '是哪位订阅者，需要修改手机号还是姓名？', askFieldOnly: '需要修改{name}的手机号还是姓名？', askValueMobile: '{name}的手机号应改为多少？', askValueName: '{name}的姓名应改为什么？' }
};
const EDIT_SUBSCRIBER_CONFIRM_RE = new RegExp(Object.values(EDIT_SUBSCRIBER_TEXT).map(t => escapeRegExp(t.confirm)).join('|'), 'i');
const EDIT_SUBSCRIBER_WHO_RE = new RegExp(Object.values(EDIT_SUBSCRIBER_TEXT).map(t => `^${escapeRegExp(t.askWho)}$`).join('|'), 'i');
const EDIT_SUBSCRIBER_VALUE_RE = { test: (text) => testFlowAnyLang(EDIT_SUBSCRIBER_TEXT, 'askValueMobile', text) || testFlowAnyLang(EDIT_SUBSCRIBER_TEXT, 'askValueName', text) };
PENDING_FLOW_MARKERS.push(EDIT_SUBSCRIBER_CONFIRM_RE, EDIT_SUBSCRIBER_WHO_RE, EDIT_SUBSCRIBER_VALUE_RE);

const EDIT_SUBSCRIBER_MOBILE_WORD_RE = /\bmobile\b|handynummer|\bnummer\b|numéro de mobile|numéro|número de móvil|número de celular|número|رقم الجوال|جوال|номер (?:мобильного|телефона)|номер|手机号|手机/i;
const EDIT_SUBSCRIBER_NAME_WORD_RE = /\bname\b|\bnom\b|\bnombre\b|الاسم|اسم|имя|\bnome\b|姓名|名字/i;
const EDIT_SUBSCRIBER_FIELD_STRIP_RE = new RegExp(`${EDIT_SUBSCRIBER_MOBILE_WORD_RE.source}|${EDIT_SUBSCRIBER_NAME_WORD_RE.source}`, 'gi');

function editSubscriberValueMatch(text) {
  const mobileMatch = execFlowAnyLang(EDIT_SUBSCRIBER_TEXT, 'askValueMobile', text);
  if (mobileMatch) return { name: mobileMatch.name, field: 'mobile' };
  const nameMatch = execFlowAnyLang(EDIT_SUBSCRIBER_TEXT, 'askValueName', text);
  if (nameMatch) return { name: nameMatch.name, field: 'name' };
  return null;
}

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
    const { name: subscriberName, field } = editSubscriberValueMatch(lastAssistant.content) || {};
    const value = msg.replace(/[.?!]+$/, '').trim();
    if (field === 'mobile') {
      if (!value) return { reply: renderFlow(EDIT_SUBSCRIBER_TEXT, 'askValueMobile', { name: subscriberName }), handled: true };
      const mobileMatch = value.match(/\d{6,15}/);
      if (!mobileMatch) return { reply: renderFlow(EDIT_SUBSCRIBER_TEXT, 'askValueMobile', { name: subscriberName }), handled: true };
      return { reply: 'Here\'s what I understood:', action: { type: 'edit_subscriber', params: { subscriberName, mobile: mobileMatch[0] } }, handled: true };
    }
    if (!value) return { reply: renderFlow(EDIT_SUBSCRIBER_TEXT, 'askValueName', { name: subscriberName }), handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'edit_subscriber', params: { subscriberName, name: value } }, handled: true };
  }

  // Step 2: answering "which subscriber, and mobile or name?"
  if (lastAssistant && EDIT_SUBSCRIBER_WHO_RE.test(lastAssistant.content)) {
    const isMobile = EDIT_SUBSCRIBER_MOBILE_WORD_RE.test(msg);
    const isName = !isMobile && EDIT_SUBSCRIBER_NAME_WORD_RE.test(msg);
    const subscriberName = msg
      .replace(EDIT_SUBSCRIBER_FIELD_STRIP_RE, '')
      .replace(/[,.]/g, '')
      .trim();
    if (!subscriberName) return { reply: renderFlow(EDIT_SUBSCRIBER_TEXT, 'askWhoEmpty'), handled: true };
    if (!isMobile && !isName) {
      return { reply: renderFlow(EDIT_SUBSCRIBER_TEXT, 'askFieldOnly', { name: subscriberName }), handled: true };
    }
    return { reply: renderFlow(EDIT_SUBSCRIBER_TEXT, isMobile ? 'askValueMobile' : 'askValueName', { name: subscriberName }), handled: true };
  }

  // Step 1 (confirm)
  if (lastAssistant && EDIT_SUBSCRIBER_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: renderFlow(EDIT_SUBSCRIBER_TEXT, 'askWho'), handled: true };
  }

  const editActionWordRe = /\b(change|update|edit)\b|ändern|aktualisier|\bmodifier\b|\bchanger\b|\bcambiar\b|\bmodificar\b|\beditar\b|تغيير|تعديل|измен|обновл|alterar|修改|更新/i;
  const subscriberWordRe = /\bsubscriber\b|\bcontributor\b|abonnent|\babonn[ée]|suscriptor|مشترك|подписчик|assinante|订阅者/i;
  if (!HOW_TO_RE.test(msg) && editActionWordRe.test(msg) && subscriberWordRe.test(msg)) {
    return { reply: renderFlow(EDIT_SUBSCRIBER_TEXT, 'confirm'), handled: true };
  }

  return null;
}

// Steps: confirm -> which payee -> which category -> link or unlink. A
// payee can have several categories at once (it's an array on the backend,
// see routes/web/expenses.js), so this is one flow with a branch at the
// end rather than two separate ones. Fast paths ("link XYZ Supplies to the
// Flowers category" / "unlink XYZ Supplies from Maintenance") are
// intentionally NOT localized, same reasoning as the other flows above.
const PAYEE_CATEGORY_TEXT = {
  en: { confirmLink: 'Are you saying you\'d like to link a payee to a category?', confirmUnlink: 'Are you saying you\'d like to unlink a payee from a category?', askWhichLink: 'Great — which payee, and should I link them to which category?', askWhichUnlink: 'Great — which payee, and should I remove them from which category?', askWhichLinkEmpty: 'Which payee, and which category should I link them to? Reply like "XYZ Supplies, Maintenance".', askWhichUnlinkEmpty: 'Which payee, and which category should I remove them from? Reply like "XYZ Supplies, Maintenance".' },
  de: { confirmLink: 'Möchten Sie einen Zahlungsempfänger mit einer Kategorie verknüpfen?', confirmUnlink: 'Möchten Sie die Verknüpfung eines Zahlungsempfängers mit einer Kategorie aufheben?', askWhichLink: 'Gut — welcher Zahlungsempfänger, und mit welcher Kategorie soll ich ihn verknüpfen?', askWhichUnlink: 'Gut — welcher Zahlungsempfänger, und von welcher Kategorie soll ich ihn trennen?', askWhichLinkEmpty: 'Welcher Zahlungsempfänger, und mit welcher Kategorie soll ich ihn verknüpfen? Antworten Sie z. B. mit "XYZ Lieferanten, Wartung".', askWhichUnlinkEmpty: 'Welcher Zahlungsempfänger, und von welcher Kategorie soll ich ihn trennen? Antworten Sie z. B. mit "XYZ Lieferanten, Wartung".' },
  fr: { confirmLink: 'Voulez-vous dire que vous souhaitez associer un bénéficiaire à une catégorie ?', confirmUnlink: 'Voulez-vous dire que vous souhaitez dissocier un bénéficiaire d\'une catégorie ?', askWhichLink: 'Très bien — quel bénéficiaire, et à quelle catégorie dois-je l\'associer ?', askWhichUnlink: 'Très bien — quel bénéficiaire, et de quelle catégorie dois-je le dissocier ?', askWhichLinkEmpty: 'Quel bénéficiaire, et à quelle catégorie dois-je l\'associer ? Répondez par ex. "Fournisseurs XYZ, Entretien".', askWhichUnlinkEmpty: 'Quel bénéficiaire, et de quelle catégorie dois-je le dissocier ? Répondez par ex. "Fournisseurs XYZ, Entretien".' },
  es: { confirmLink: '¿Quieres decir que te gustaría vincular un beneficiario a una categoría?', confirmUnlink: '¿Quieres decir que te gustaría desvincular un beneficiario de una categoría?', askWhichLink: 'Genial — ¿qué beneficiario, y a qué categoría debo vincularlo?', askWhichUnlink: 'Genial — ¿qué beneficiario, y de qué categoría debo desvincularlo?', askWhichLinkEmpty: '¿Qué beneficiario, y a qué categoría debo vincularlo? Responde por ejemplo "Proveedores XYZ, Mantenimiento".', askWhichUnlinkEmpty: '¿Qué beneficiario, y de qué categoría debo desvincularlo? Responde por ejemplo "Proveedores XYZ, Mantenimiento".' },
  ar: { confirmLink: 'هل تقصد أنك تريد ربط مستفيد بفئة؟', confirmUnlink: 'هل تقصد أنك تريد إلغاء ربط مستفيد بفئة؟', askWhichLink: 'رائع — أي مستفيد، وبأي فئة يجب أن أربطه؟', askWhichUnlink: 'رائع — أي مستفيد، ومن أي فئة يجب أن أزيله؟', askWhichLinkEmpty: 'أي مستفيد، وبأي فئة يجب أن أربطه؟ رد مثلاً بـ "موردو XYZ، الصيانة".', askWhichUnlinkEmpty: 'أي مستفيد، ومن أي فئة يجب أن أزيله؟ رد مثلاً بـ "موردو XYZ، الصيانة".' },
  ru: { confirmLink: 'Вы хотите привязать получателя к категории?', confirmUnlink: 'Вы хотите отвязать получателя от категории?', askWhichLink: 'Отлично — какой получатель, и к какой категории его привязать?', askWhichUnlink: 'Отлично — какой получатель, и от какой категории его отвязать?', askWhichLinkEmpty: 'Какой получатель, и к какой категории его привязать? Ответьте, например, «Поставщики XYZ, Обслуживание».', askWhichUnlinkEmpty: 'Какой получатель, и от какой категории его отвязать? Ответьте, например, «Поставщики XYZ, Обслуживание».' },
  pt: { confirmLink: 'Você gostaria de vincular um beneficiário a uma categoria?', confirmUnlink: 'Você gostaria de desvincular um beneficiário de uma categoria?', askWhichLink: 'Ótimo — qual beneficiário, e a qual categoria devo vinculá-lo?', askWhichUnlink: 'Ótimo — qual beneficiário, e de qual categoria devo desvinculá-lo?', askWhichLinkEmpty: 'Qual beneficiário, e a qual categoria devo vinculá-lo? Responda, por exemplo, "Fornecedores XYZ, Manutenção".', askWhichUnlinkEmpty: 'Qual beneficiário, e de qual categoria devo desvinculá-lo? Responda, por exemplo, "Fornecedores XYZ, Manutenção".' },
  zh: { confirmLink: '您是想将收款人关联到某个类别吗？', confirmUnlink: '您是想将收款人从某个类别取消关联吗？', askWhichLink: '好的 — 是哪位收款人，应关联到哪个类别？', askWhichUnlink: '好的 — 是哪位收款人，应从哪个类别取消关联？', askWhichLinkEmpty: '是哪位收款人，应关联到哪个类别？请回复例如"XYZ供应商，维护"。', askWhichUnlinkEmpty: '是哪位收款人，应从哪个类别取消关联？请回复例如"XYZ供应商，维护"。' }
};
const PAYEE_CATEGORY_CONFIRM_RE = new RegExp(Object.values(PAYEE_CATEGORY_TEXT).map(t => `${escapeRegExp(t.confirmLink)}|${escapeRegExp(t.confirmUnlink)}`).join('|'), 'i');
const PAYEE_CATEGORY_WHICH_PAYEE_RE = new RegExp(Object.values(PAYEE_CATEGORY_TEXT).map(t => `^${escapeRegExp(t.askWhichLink)}$|^${escapeRegExp(t.askWhichUnlink)}$`).join('|'), 'i');
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
    const isUnlink = testFlowAnyLang(PAYEE_CATEGORY_TEXT, 'askWhichUnlink', lastAssistant.content);
    const parts = msg.split(/[,،]/);
    const payeeName = (parts[0] || '').trim();
    const category = (parts[1] || '').replace(/[.?!]+$/, '').trim();
    if (!payeeName || !category) {
      return { reply: renderFlow(PAYEE_CATEGORY_TEXT, isUnlink ? 'askWhichUnlinkEmpty' : 'askWhichLinkEmpty'), handled: true };
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
    const isUnlink = testFlowAnyLang(PAYEE_CATEGORY_TEXT, 'confirmUnlink', lastAssistant.content);
    return { reply: renderFlow(PAYEE_CATEGORY_TEXT, isUnlink ? 'askWhichUnlink' : 'askWhichLink'), handled: true };
  }

  const linkUnlinkWordRe = /\b(link|unlink|remove|associate)\b|verknüpf|trennen|entfernen|\bassocier\b|\bdissocier\b|\bretirer\b|\bvincular\b|\bdesvincular\b|\bquitar\b|ربط|إلغاء|إزالة|привяз|отвяз|удал|vincul|desvincul|remover|关联|取消关联|移除/i;
  const categoryWordRe = /\bcategor(?:y|ies)\b|kategorie|catégorie|categoría|فئة|категор|categoria|类别/i;
  if (!HOW_TO_RE.test(msg) && PAYEE_WORD_RE.test(msg) && categoryWordRe.test(msg) && linkUnlinkWordRe.test(msg)) {
    const isUnlink = /\b(unlink|remove)\b|trennen|entfernen|\bdissocier\b|\bretirer\b|\bdesvincular\b|\bquitar\b|إلغاء|إزالة|отвяз|удал|desvincul|remover|取消关联|移除/i.test(msg);
    return { reply: renderFlow(PAYEE_CATEGORY_TEXT, isUnlink ? 'confirmUnlink' : 'confirmLink'), handled: true };
  }

  return null;
}

// Steps: confirm -> one free-form follow-up covering whichever of account
// type (individual/organization), category, and currency the user wants to
// change — all three are optional in that single reply (say as many as
// apply), and any field left unmentioned is filled in from the account's
// current value by the frontend, not guessed here.
const UPDATE_PROFILE_TEXT = {
  en: { confirm: 'Are you saying you\'d like to update your account profile?', askWhat: 'Great — what would you like to update? Tell me the account type (individual/organization), category, and/or currency — whatever\'s changing.', askWhatEmpty: 'What would you like to update — account type (individual/organization), category, and/or currency?' },
  de: { confirm: 'Möchten Sie Ihr Kontoprofil aktualisieren?', askWhat: 'Gut — was möchten Sie aktualisieren? Nennen Sie mir den Kontotyp (Einzelperson/Organisation), die Kategorie und/oder die Währung — was auch immer sich ändert.', askWhatEmpty: 'Was möchten Sie aktualisieren — Kontotyp (Einzelperson/Organisation), Kategorie und/oder Währung?' },
  fr: { confirm: 'Voulez-vous dire que vous souhaitez mettre à jour le profil de votre compte ?', askWhat: 'Très bien — que souhaitez-vous mettre à jour ? Indiquez-moi le type de compte (particulier/organisation), la catégorie et/ou la devise — ce qui change.', askWhatEmpty: 'Que souhaitez-vous mettre à jour — type de compte (particulier/organisation), catégorie et/ou devise ?' },
  es: { confirm: '¿Quieres decir que te gustaría actualizar el perfil de tu cuenta?', askWhat: 'Genial — ¿qué te gustaría actualizar? Dime el tipo de cuenta (individual/organización), la categoría y/o la moneda — lo que esté cambiando.', askWhatEmpty: '¿Qué te gustaría actualizar — tipo de cuenta (individual/organización), categoría y/o moneda?' },
  ar: { confirm: 'هل تقصد أنك تريد تحديث ملف حسابك؟', askWhat: 'رائع — ما الذي تريد تحديثه؟ أخبرني بنوع الحساب (فرد/منظمة)، الفئة، و/أو العملة — أيًا كان ما يتغير.', askWhatEmpty: 'ما الذي تريد تحديثه — نوع الحساب (فرد/منظمة)، الفئة، و/أو العملة؟' },
  ru: { confirm: 'Вы хотите обновить профиль своего аккаунта?', askWhat: 'Отлично — что вы хотите обновить? Укажите тип аккаунта (физлицо/организация), категорию и/или валюту — что меняется.', askWhatEmpty: 'Что вы хотите обновить — тип аккаунта (физлицо/организация), категорию и/или валюту?' },
  pt: { confirm: 'Você gostaria de atualizar o perfil da sua conta?', askWhat: 'Ótimo — o que você gostaria de atualizar? Me diga o tipo de conta (pessoa física/organização), a categoria e/ou a moeda — o que estiver mudando.', askWhatEmpty: 'O que você gostaria de atualizar — tipo de conta (pessoa física/organização), categoria e/ou moeda?' },
  zh: { confirm: '您是想更新账户资料吗？', askWhat: '好的 — 您想更新什么？请告诉我账户类型（个人/组织）、类别和/或货币 — 任何有变化的内容。', askWhatEmpty: '您想更新什么 — 账户类型（个人/组织）、类别和/或货币？' }
};
const UPDATE_PROFILE_CONFIRM_RE = new RegExp(Object.values(UPDATE_PROFILE_TEXT).map(t => escapeRegExp(t.confirm)).join('|'), 'i');
const UPDATE_PROFILE_WHAT_RE = new RegExp(Object.values(UPDATE_PROFILE_TEXT).map(t => `^${escapeRegExp(t.askWhat)}$`).join('|'), 'i');
PENDING_FLOW_MARKERS.push(UPDATE_PROFILE_CONFIRM_RE, UPDATE_PROFILE_WHAT_RE);

const ORG_WORD_RE = /\borgani[sz]ation\b|organisation|organización|منظمة|организаци\w*|organização|组织/i;
const INDIVIDUAL_WORD_RE = /\bindividual\b|einzelperson|\bparticulier\b|فرد|физ(?:ическое)?\s*лиц\w*|pessoa\s*física|个人/i;
const UPDATE_PROFILE_LABEL_STRIP_RE = /\bcategory\b|\bcurrency\b|\baccount type\b|kategorie|währung|kontotyp|catégorie|devise|type de compte|categoría|moneda|tipo de cuenta|فئة|عملة|نوع الحساب|категория|валюта|тип аккаунта|categoria|moeda|tipo de conta|类别|货币|账户类型/gi;

function parseUpdateProfile(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 2: answering "what would you like to update?"
  if (lastAssistant && UPDATE_PROFILE_WHAT_RE.test(lastAssistant.content)) {
    let accountType;
    if (ORG_WORD_RE.test(msg)) accountType = 'organization';
    else if (INDIVIDUAL_WORD_RE.test(msg)) accountType = 'individual';

    const currency = matchCurrency(msg);

    let category = msg
      .replace(ORG_WORD_RE, '')
      .replace(INDIVIDUAL_WORD_RE, '')
      .replace(new RegExp(`\\b(${SUPPORTED_CURRENCIES.join('|')})\\b`, 'gi'), '')
      .replace(UPDATE_PROFILE_LABEL_STRIP_RE, '')
      .replace(/[,.，、]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!category) category = undefined;

    if (!accountType && !currency && !category) {
      return { reply: renderFlow(UPDATE_PROFILE_TEXT, 'askWhatEmpty'), handled: true };
    }
    return { reply: 'Here\'s what I understood:', action: { type: 'update_profile', params: { accountType, category, currency } }, handled: true };
  }

  // Step 1 (confirm)
  if (lastAssistant && UPDATE_PROFILE_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: renderFlow(UPDATE_PROFILE_TEXT, 'askWhat'), handled: true };
  }

  const updateActionWordRe = /\b(update|change|edit)\b|aktualisier|ändern|\bmettre à jour\b|\bmodifier\b|\bactualizar\b|\bcambiar\b|تحديث|تغيير|обновл|измен|atualizar|alterar|更新|修改/i;
  const profileOrAccountWordRe = /\bprofile\b|\baccount\b|profil|konto|compte|perfil|cuenta|ملف|حساب|профил|аккаунт|conta|资料|账户/i;
  if (!HOW_TO_RE.test(msg) && updateActionWordRe.test(msg) && profileOrAccountWordRe.test(msg)) {
    return { reply: renderFlow(UPDATE_PROFILE_TEXT, 'confirm'), handled: true };
  }

  return null;
}

// Steps: confirm -> name -> email -> mobile (optional). The password is
// never asked for through chat — a random one is generated once everything
// else is known, and shown back in the confirmation so the treasurer can
// share it with the new staff member. Typing a password into a chat box
// is exactly the kind of thing this avoids on purpose.
const ADD_STAFF_TEXT = {
  en: { confirm: 'Are you saying you\'d like to add a new staff account?', askName: 'Great — what\'s the new staff member\'s name?', askNameEmpty: 'What\'s the new staff member\'s name?', askEmail: 'What\'s {name}\'s email address?', askMobile: '(optional) What\'s {name}\'s mobile number? Reply "skip" if you\'d rather leave it blank.' },
  de: { confirm: 'Möchten Sie ein neues Mitarbeiterkonto hinzufügen?', askName: 'Gut — wie heißt der neue Mitarbeiter?', askNameEmpty: 'Wie heißt der neue Mitarbeiter?', askEmail: 'Wie lautet die E-Mail-Adresse von {name}?', askMobile: '(optional) Wie lautet die Handynummer von {name}? Antworten Sie mit "überspringen", wenn Sie das Feld leer lassen möchten.' },
  fr: { confirm: 'Voulez-vous dire que vous souhaitez ajouter un nouveau compte du personnel ?', askName: 'Très bien — quel est le nom du nouveau membre du personnel ?', askNameEmpty: 'Quel est le nom du nouveau membre du personnel ?', askEmail: 'Quelle est l\'adresse e-mail de {name} ?', askMobile: '(facultatif) Quel est le numéro de mobile de {name} ? Répondez "passer" si vous préférez le laisser vide.' },
  es: { confirm: '¿Quieres decir que te gustaría agregar una nueva cuenta de personal?', askName: 'Genial — ¿cuál es el nombre del nuevo miembro del personal?', askNameEmpty: '¿Cuál es el nombre del nuevo miembro del personal?', askEmail: '¿Cuál es la dirección de correo electrónico de {name}?', askMobile: '(opcional) ¿Cuál es el número de móvil de {name}? Responde "omitir" si prefieres dejarlo en blanco.' },
  ar: { confirm: 'هل تقصد أنك تريد إضافة حساب موظف جديد؟', askName: 'رائع — ما اسم الموظف الجديد؟', askNameEmpty: 'ما اسم الموظف الجديد؟', askEmail: 'ما البريد الإلكتروني لـ {name}؟', askMobile: '(اختياري) ما رقم جوال {name}؟ رد بـ "تخطي" إذا كنت تفضل تركه فارغًا.' },
  ru: { confirm: 'Вы хотите добавить новую учётную запись сотрудника?', askName: 'Отлично — как зовут нового сотрудника?', askNameEmpty: 'Как зовут нового сотрудника?', askEmail: 'Какой адрес электронной почты у {name}?', askMobile: '(необязательно) Какой номер мобильного у {name}? Ответьте «пропустить», если хотите оставить это поле пустым.' },
  pt: { confirm: 'Você gostaria de adicionar uma nova conta de funcionário?', askName: 'Ótimo — qual é o nome do novo funcionário?', askNameEmpty: 'Qual é o nome do novo funcionário?', askEmail: 'Qual é o endereço de e-mail de {name}?', askMobile: '(opcional) Qual é o número de celular de {name}? Responda "pular" se preferir deixar em branco.' },
  zh: { confirm: '您是想添加一个新的员工账户吗？', askName: '好的 — 新员工叫什么名字？', askNameEmpty: '新员工叫什么名字？', askEmail: '{name}的电子邮箱地址是什么？', askMobile: '（可选）{name}的手机号是多少？如果想留空，请回复"跳过"。' }
};
const ADD_STAFF_CONFIRM_RE = new RegExp(Object.values(ADD_STAFF_TEXT).map(t => escapeRegExp(t.confirm)).join('|'), 'i');
const ADD_STAFF_NAME_RE = new RegExp(Object.values(ADD_STAFF_TEXT).map(t => `^${escapeRegExp(t.askName)}$`).join('|'), 'i');
const ADD_STAFF_EMAIL_RE = { test: (text) => testFlowAnyLang(ADD_STAFF_TEXT, 'askEmail', text) };
const ADD_STAFF_MOBILE_RE = { test: (text) => testFlowAnyLang(ADD_STAFF_TEXT, 'askMobile', text) };
PENDING_FLOW_MARKERS.push(ADD_STAFF_CONFIRM_RE, ADD_STAFF_NAME_RE, ADD_STAFF_EMAIL_RE, ADD_STAFF_MOBILE_RE);

function generateStaffPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const SKIP_WORD_RE = /^\s*(?:skip|überspringen|passer|omitir|تخطي|пропустить|pular|跳过)\b/i;
const ADD_STAFF_ACTION_WORDS_RE = /\b(add|create|register|new)\b|hinzufüg|\bneu\b|\bajout|\bnouveau\b|\benregistr|\bagregar\b|\bnuevo\b|\bregistrar\b|إضافة|جديد|تسجيل|добав|нов|регистр|adicionar|novo|添加|新|注册/i;
const STAFF_WORD_RE = /\bstaff\b|mitarbeiter|personnel|\bpersonal\b|موظف|сотрудник|funcionário|员工/i;

function parseAddStaff(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 4: answering the (optional) mobile question
  if (lastAssistant && ADD_STAFF_MOBILE_RE.test(lastAssistant.content)) {
    const extracted = execFlowAnyLang(ADD_STAFF_TEXT, 'askMobile', lastAssistant.content);
    const name = extracted ? extracted.name : '';
    const skip = SKIP_WORD_RE.test(msg);
    const mobileMatch = msg.match(/\d{6,15}/);
    if (!skip && !mobileMatch) return { reply: renderFlow(ADD_STAFF_TEXT, 'askMobile', { name }), handled: true };
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
    const extracted = execFlowAnyLang(ADD_STAFF_TEXT, 'askEmail', lastAssistant.content);
    const name = extracted ? extracted.name : '';
    const emailMatch = msg.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
    if (!emailMatch) return { reply: renderFlow(ADD_STAFF_TEXT, 'askEmail', { name }), handled: true };
    return { reply: renderFlow(ADD_STAFF_TEXT, 'askMobile', { name }), handled: true };
  }

  // Step 2: answering "what's the new staff member's name?"
  if (lastAssistant && ADD_STAFF_NAME_RE.test(lastAssistant.content)) {
    const name = msg.replace(/[.?!]+$/, '').trim();
    if (!name) return { reply: renderFlow(ADD_STAFF_TEXT, 'askNameEmpty'), handled: true };
    return { reply: renderFlow(ADD_STAFF_TEXT, 'askEmail', { name }), handled: true };
  }

  // Step 1 (confirm)
  if (lastAssistant && ADD_STAFF_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: renderFlow(ADD_STAFF_TEXT, 'askName'), handled: true };
  }

  if (!HOW_TO_RE.test(msg) && STAFF_WORD_RE.test(msg) && ADD_STAFF_ACTION_WORDS_RE.test(msg)) {
    return { reply: renderFlow(ADD_STAFF_TEXT, 'confirm'), handled: true };
  }

  return null;
}

// Steps: confirm -> which staff member -> enable or disable. Removing
// staff is destructive and stays refused (see DELETE_STEPS/'staff' below)
// — only enable/disable (a reversible status flip) is a real action here.
// Fast paths ("disable Priya's staff account") are intentionally NOT
// localized, same reasoning as the other flows above.
const TOGGLE_STAFF_TEXT = {
  en: { confirm: 'Are you saying you\'d like to enable or disable a staff account?', askWhich: 'Great — which staff member, and should I enable or disable them?', askWhichEmpty: 'Which staff member, and should I enable or disable them?', askFieldOnly: 'Should I enable or disable {name}?' },
  de: { confirm: 'Möchten Sie ein Mitarbeiterkonto aktivieren oder deaktivieren?', askWhich: 'Gut — welcher Mitarbeiter, und soll ich ihn aktivieren oder deaktivieren?', askWhichEmpty: 'Welcher Mitarbeiter, und soll ich ihn aktivieren oder deaktivieren?', askFieldOnly: 'Soll ich {name} aktivieren oder deaktivieren?' },
  fr: { confirm: 'Voulez-vous dire que vous souhaitez activer ou désactiver un compte du personnel ?', askWhich: 'Très bien — quel membre du personnel, et dois-je l\'activer ou le désactiver ?', askWhichEmpty: 'Quel membre du personnel, et dois-je l\'activer ou le désactiver ?', askFieldOnly: 'Dois-je activer ou désactiver {name} ?' },
  es: { confirm: '¿Quieres decir que te gustaría activar o desactivar una cuenta de personal?', askWhich: 'Genial — ¿qué miembro del personal, y debo activarlo o desactivarlo?', askWhichEmpty: '¿Qué miembro del personal, y debo activarlo o desactivarlo?', askFieldOnly: '¿Debo activar o desactivar a {name}?' },
  ar: { confirm: 'هل تقصد أنك تريد تفعيل أو تعطيل حساب موظف؟', askWhich: 'رائع — أي موظف، وهل يجب أن أفعّله أم أعطّله؟', askWhichEmpty: 'أي موظف، وهل يجب أن أفعّله أم أعطّله؟', askFieldOnly: 'هل يجب أن أفعّل {name} أم أعطّله؟' },
  ru: { confirm: 'Вы хотите включить или отключить учётную запись сотрудника?', askWhich: 'Отлично — какой сотрудник, и включить его или отключить?', askWhichEmpty: 'Какой сотрудник, и включить его или отключить?', askFieldOnly: 'Включить или отключить {name}?' },
  pt: { confirm: 'Você gostaria de ativar ou desativar uma conta de funcionário?', askWhich: 'Ótimo — qual funcionário, e devo ativá-lo ou desativá-lo?', askWhichEmpty: 'Qual funcionário, e devo ativá-lo ou desativá-lo?', askFieldOnly: 'Devo ativar ou desativar {name}?' },
  zh: { confirm: '您是想启用或禁用一个员工账户吗？', askWhich: '好的 — 是哪位员工，应该启用还是禁用？', askWhichEmpty: '是哪位员工，应该启用还是禁用？', askFieldOnly: '应该启用还是禁用{name}？' }
};
const TOGGLE_STAFF_CONFIRM_RE = new RegExp(Object.values(TOGGLE_STAFF_TEXT).map(t => escapeRegExp(t.confirm)).join('|'), 'i');
const TOGGLE_STAFF_WHICH_RE = new RegExp(Object.values(TOGGLE_STAFF_TEXT).map(t => `^${escapeRegExp(t.askWhich)}$`).join('|'), 'i');
PENDING_FLOW_MARKERS.push(TOGGLE_STAFF_CONFIRM_RE, TOGGLE_STAFF_WHICH_RE);

const TOGGLE_STAFF_BAD_NAME_RE = /\b(or|enable|disable|activate|deactivate)\b/i;
const ENABLE_WORD_RE = /\b(?:enable|activate|reactivate)\b|aktivier|\bactiver\b|\bréactiver\b|\bactivar\b|\breactivar\b|تفعيل|تنشيط|активир|включ|ativar|reativar|启用|激活/i;
const DISABLE_WORD_RE = /\b(?:disable|deactivate)\b|deaktivier|\bdésactiver\b|\bdesactivar\b|تعطيل|إيقاف|деактивир|отключ|desativar|禁用|停用/i;

function parseToggleStaff(msg, history) {
  // Fast path — "disable Priya's staff account" / "enable Priya as staff".
  // Guarded against generic trigger phrasing like "enable or disable staff"
  // (a question, not a real instruction naming someone) being mistaken for
  // a real staff name, and against "as" being swallowed into the name.
  let fastMatch = !/\bor\s+(?:disable|deactivate)\b/i.test(msg) && msg.match(/\b(disable|deactivate)\b\s+([a-z0-9 .'-]+?)(?:'s|\s+as)?\s+staff\b/i);
  if (fastMatch && !TOGGLE_STAFF_BAD_NAME_RE.test(fastMatch[2].trim())) {
    return { reply: 'Here\'s what I understood:', action: { type: 'toggle_staff', params: { staffName: fastMatch[2].trim(), enable: false } }, handled: true };
  }
  fastMatch = !/\bor\s+(?:enable|activate|reactivate)\b/i.test(msg) && msg.match(/\b(enable|activate|reactivate)\b\s+([a-z0-9 .'-]+?)(?:'s|\s+as)?\s+staff\b/i);
  if (fastMatch && !TOGGLE_STAFF_BAD_NAME_RE.test(fastMatch[2].trim())) {
    return { reply: 'Here\'s what I understood:', action: { type: 'toggle_staff', params: { staffName: fastMatch[2].trim(), enable: true } }, handled: true };
  }

  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 2: answering "which staff member, and enable or disable?"
  if (lastAssistant && TOGGLE_STAFF_WHICH_RE.test(lastAssistant.content)) {
    const isEnable = ENABLE_WORD_RE.test(msg);
    const isDisable = !isEnable && DISABLE_WORD_RE.test(msg);
    const staffName = msg.replace(ENABLE_WORD_RE, '').replace(DISABLE_WORD_RE, '').replace(/[,.]/g, '').trim();
    if (!staffName) return { reply: renderFlow(TOGGLE_STAFF_TEXT, 'askWhichEmpty'), handled: true };
    if (!isEnable && !isDisable) return { reply: renderFlow(TOGGLE_STAFF_TEXT, 'askFieldOnly', { name: staffName }), handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'toggle_staff', params: { staffName, enable: isEnable } }, handled: true };
  }

  // Step 1 (confirm)
  if (lastAssistant && TOGGLE_STAFF_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: renderFlow(TOGGLE_STAFF_TEXT, 'askWhich'), handled: true };
  }

  if (!HOW_TO_RE.test(msg) && STAFF_WORD_RE.test(msg) && (ENABLE_WORD_RE.test(msg) || DISABLE_WORD_RE.test(msg))) {
    return { reply: renderFlow(TOGGLE_STAFF_TEXT, 'confirm'), handled: true };
  }

  return null;
}

// Steps: confirm -> who -> which goal (optional, mirrors collect_payment's
// "omit it and the app shows a dues list to pick from" behavior). The
// actual gateway-connected check happens server-side when the frontend
// calls /pro/create-payment-link — this flow just gathers who/what. Fast
// paths ("send Ramesh a payment link for Diwali Fund") are intentionally
// NOT localized, same reasoning as the other flows above.
const PAYMENT_LINK_TEXT = {
  en: { confirm: 'Are you saying you\'d like to generate a payment link?', askWho: 'Great — who should the payment link be for?', askWhoEmpty: 'Who should the payment link be for?', askWhoViaMenu: 'Great — what\'s the subscriber\'s mobile number so I can look up their due and generate the link?' },
  de: { confirm: 'Möchten Sie einen Zahlungslink erstellen?', askWho: 'Gut — für wen soll der Zahlungslink sein?', askWhoEmpty: 'Für wen soll der Zahlungslink sein?', askWhoViaMenu: 'Gut — wie lautet die Handynummer des Abonnenten, damit ich seinen ausstehenden Betrag nachschlagen und den Link erstellen kann?' },
  fr: { confirm: 'Voulez-vous dire que vous souhaitez générer un lien de paiement ?', askWho: 'Très bien — pour qui est le lien de paiement ?', askWhoEmpty: 'Pour qui est le lien de paiement ?', askWhoViaMenu: 'Très bien — quel est le numéro de mobile de l\'abonné pour que je puisse consulter son solde dû et générer le lien ?' },
  es: { confirm: '¿Quieres decir que te gustaría generar un enlace de pago?', askWho: 'Genial — ¿para quién es el enlace de pago?', askWhoEmpty: '¿Para quién es el enlace de pago?', askWhoViaMenu: 'Genial — ¿cuál es el número de móvil del suscriptor para poder consultar su saldo pendiente y generar el enlace?' },
  ar: { confirm: 'هل تقصد أنك تريد إنشاء رابط دفع؟', askWho: 'رائع — لمن رابط الدفع؟', askWhoEmpty: 'لمن رابط الدفع؟', askWhoViaMenu: 'رائع — ما رقم جوال المشترك حتى أتمكن من الاطلاع على مستحقاته وإنشاء الرابط؟' },
  ru: { confirm: 'Вы хотите создать ссылку на оплату?', askWho: 'Отлично — для кого нужна ссылка на оплату?', askWhoEmpty: 'Для кого нужна ссылка на оплату?', askWhoViaMenu: 'Отлично — какой номер мобильного у подписчика, чтобы я мог посмотреть его задолженность и создать ссылку?' },
  pt: { confirm: 'Você gostaria de gerar um link de pagamento?', askWho: 'Ótimo — para quem é o link de pagamento?', askWhoEmpty: 'Para quem é o link de pagamento?', askWhoViaMenu: 'Ótimo — qual é o número de celular do assinante para eu consultar o valor devido e gerar o link?' },
  zh: { confirm: '您是想生成一个付款链接吗？', askWho: '好的 — 这个付款链接是给谁的？', askWhoEmpty: '这个付款链接是给谁的？', askWhoViaMenu: '好的 — 订阅者的手机号是多少，这样我才能查询其欠款并生成链接？' }
};
const PAYMENT_LINK_CONFIRM_RE = new RegExp(Object.values(PAYMENT_LINK_TEXT).map(t => escapeRegExp(t.confirm)).join('|'), 'i');
// Two different questions dovetail into this same step: the flow's own
// direct trigger (askWho) and the collect fallback menu's option 1, worded
// around a mobile lookup instead (askWhoViaMenu) — kept textually distinct
// from DOWNLOAD_RECEIPT_TEXT.askMobile below (also a "what's the
// subscriber's mobile number" question) so FLOW_OWNERS never confuses
// which flow a reply belongs to.
const PAYMENT_LINK_WHO_RE = { test: (text) => testFlowAnyLang(PAYMENT_LINK_TEXT, 'askWho', text) || testFlowAnyLang(PAYMENT_LINK_TEXT, 'askWhoViaMenu', text) };
PENDING_FLOW_MARKERS.push(PAYMENT_LINK_CONFIRM_RE, PAYMENT_LINK_WHO_RE);

const PAYMENT_LINK_FAKE_GOAL_RE = /^(?:his|her|their|its)\s+(?:due|dues|payment|account)s?$/i;
const PAYMENT_LINK_WORD_RE = /\bpayment link\b|zahlungslink|lien de paiement|enlace de pago|رابط دفع|ссылк\w*\s*на\s*оплату|link de pagamento|付款链接/i;

function paymentLinkViaMenuQuestion() {
  return renderFlow(PAYMENT_LINK_TEXT, 'askWhoViaMenu');
}

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
    if (!subscriberName) return { reply: renderFlow(PAYMENT_LINK_TEXT, 'askWhoEmpty'), handled: true };
    const goalName = m && m[2] ? m[2].trim() : undefined;
    return { reply: 'Here\'s what I understood:', action: { type: 'create_payment_link', params: { subscriberName, goalName } }, handled: true };
  }

  // Step 1 (confirm)
  if (lastAssistant && PAYMENT_LINK_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: renderFlow(PAYMENT_LINK_TEXT, 'askWho'), handled: true };
  }

  if (!HOW_TO_RE.test(msg) && PAYMENT_LINK_WORD_RE.test(msg) && !/\bhow\b/i.test(msg)) {
    return { reply: renderFlow(PAYMENT_LINK_TEXT, 'confirm'), handled: true };
  }

  return null;
}

// Steps: confirm -> which goal (optional — omit for "everyone with any
// pending due", mirroring the app's own "remind all" convention). The
// actual send requires the treasurer's own WhatsApp Business API to
// already be connected — enforced server-side by /web-send-whatsapp-bulk.
// Fast paths are intentionally NOT localized, same reasoning as above.
const WHATSAPP_BULK_TEXT = {
  en: { confirm: 'Are you saying you\'d like to send WhatsApp reminders?', askWhich: 'Great — remind everyone with a pending due, or just one goal? Say "everyone" or name the goal.', askWhichEmpty: 'Remind everyone with a pending due, or just one goal? Say "everyone" or name the goal.' },
  de: { confirm: 'Möchten Sie WhatsApp-Erinnerungen senden?', askWhich: 'Gut — alle mit ausstehendem Betrag erinnern, oder nur für ein Ziel? Sagen Sie "alle" oder nennen Sie das Ziel.', askWhichEmpty: 'Alle mit ausstehendem Betrag erinnern, oder nur für ein Ziel? Sagen Sie "alle" oder nennen Sie das Ziel.' },
  fr: { confirm: 'Voulez-vous dire que vous souhaitez envoyer des rappels WhatsApp ?', askWhich: 'Très bien — rappeler tout le monde ayant un solde dû, ou juste un objectif ? Dites "tout le monde" ou nommez l\'objectif.', askWhichEmpty: 'Rappeler tout le monde ayant un solde dû, ou juste un objectif ? Dites "tout le monde" ou nommez l\'objectif.' },
  es: { confirm: '¿Quieres decir que te gustaría enviar recordatorios de WhatsApp?', askWhich: 'Genial — ¿recordar a todos los que tienen un saldo pendiente, o solo una meta? Di "todos" o nombra la meta.', askWhichEmpty: '¿Recordar a todos los que tienen un saldo pendiente, o solo una meta? Di "todos" o nombra la meta.' },
  ar: { confirm: 'هل تقصد أنك تريد إرسال تذكيرات واتساب؟', askWhich: 'رائع — تذكير الجميع ممن لديهم مبلغ معلّق، أم هدف واحد فقط؟ قل "الجميع" أو اذكر اسم الهدف.', askWhichEmpty: 'تذكير الجميع ممن لديهم مبلغ معلّق، أم هدف واحد فقط؟ قل "الجميع" أو اذكر اسم الهدف.' },
  ru: { confirm: 'Вы хотите отправить напоминания в WhatsApp?', askWhich: 'Отлично — напомнить всем с задолженностью или только по одной цели? Скажите «всем» или назовите цель.', askWhichEmpty: 'Напомнить всем с задолженностью или только по одной цели? Скажите «всем» или назовите цель.' },
  pt: { confirm: 'Você gostaria de enviar lembretes pelo WhatsApp?', askWhich: 'Ótimo — lembrar todos com um valor pendente, ou apenas uma meta? Diga "todos" ou nomeie a meta.', askWhichEmpty: 'Lembrar todos com um valor pendente, ou apenas uma meta? Diga "todos" ou nomeie a meta.' },
  zh: { confirm: '您是想发送WhatsApp提醒吗？', askWhich: '好的 — 提醒所有有待付款的人，还是仅针对一个目标？请说"所有人"或说出目标名称。', askWhichEmpty: '提醒所有有待付款的人，还是仅针对一个目标？请说"所有人"或说出目标名称。' }
};
const WHATSAPP_BULK_CONFIRM_RE = new RegExp(Object.values(WHATSAPP_BULK_TEXT).map(t => escapeRegExp(t.confirm)).join('|'), 'i');
const WHATSAPP_BULK_WHICH_RE = new RegExp(Object.values(WHATSAPP_BULK_TEXT).map(t => `^${escapeRegExp(t.askWhich)}$`).join('|'), 'i');
PENDING_FLOW_MARKERS.push(WHATSAPP_BULK_CONFIRM_RE, WHATSAPP_BULK_WHICH_RE);

const WHATSAPP_EVERYONE_WORD_RE = /\beveryone\b|^alle\b|\btout le monde\b|\btodos\b|الجميع|\bвсем\b|\bвсех\b|所有人/i;
const REMINDER_WORD_RE = /\breminders?\b|erinnerung|\brappels?\b|recordatorios?|تذكير|напомин|lembretes?|提醒/i;

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
    if (WHATSAPP_EVERYONE_WORD_RE.test(msg.trim())) {
      return { reply: 'Here\'s what I understood:', action: { type: 'send_whatsapp_reminders', params: {} }, handled: true };
    }
    const goalName = msg.replace(/[.?!]+$/, '').trim();
    if (!goalName) return { reply: renderFlow(WHATSAPP_BULK_TEXT, 'askWhichEmpty'), handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'send_whatsapp_reminders', params: { goalName } }, handled: true };
  }

  // Step 1 (confirm)
  if (lastAssistant && WHATSAPP_BULK_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: renderFlow(WHATSAPP_BULK_TEXT, 'askWhich'), handled: true };
  }

  if (!HOW_TO_RE.test(msg) && /\bwhatsapp\b/i.test(msg) && REMINDER_WORD_RE.test(msg)) {
    return { reply: renderFlow(WHATSAPP_BULK_TEXT, 'confirm'), handled: true };
  }

  return null;
}

// Steps: mobile number -> goal name -> done. Only ever entered via the
// collect fallback menu's option 2 below (no standalone keyword trigger of
// its own) — "download the receipt" alone is too generic a phrase to guess
// at reliably, whereas the menu already established the user meant this.
const DOWNLOAD_RECEIPT_TEXT = {
  en: { askMobile: 'Great — what\'s the subscriber\'s mobile number so I can find their receipt?', askMobileEmpty: 'What\'s the subscriber\'s mobile number?', askGoal: 'What\'s the goal name for {name}\'s receipt?' },
  de: { askMobile: 'Gut — wie lautet die Handynummer des Abonnenten, damit ich seinen Beleg finden kann?', askMobileEmpty: 'Wie lautet die Handynummer des Abonnenten?', askGoal: 'Wie heißt das Ziel für den Beleg von {name}?' },
  fr: { askMobile: 'Très bien — quel est le numéro de mobile de l\'abonné pour que je puisse trouver son reçu ?', askMobileEmpty: 'Quel est le numéro de mobile de l\'abonné ?', askGoal: 'Quel est le nom de l\'objectif pour le reçu de {name} ?' },
  es: { askMobile: 'Genial — ¿cuál es el número de móvil del suscriptor para poder encontrar su recibo?', askMobileEmpty: '¿Cuál es el número de móvil del suscriptor?', askGoal: '¿Cuál es el nombre de la meta para el recibo de {name}?' },
  ar: { askMobile: 'رائع — ما رقم جوال المشترك حتى أتمكن من العثور على إيصاله؟', askMobileEmpty: 'ما رقم جوال المشترك؟', askGoal: 'ما اسم الهدف الخاص بإيصال {name}؟' },
  ru: { askMobile: 'Отлично — какой номер мобильного у подписчика, чтобы я мог найти его квитанцию?', askMobileEmpty: 'Какой номер мобильного у подписчика?', askGoal: 'Как называется цель для квитанции {name}?' },
  pt: { askMobile: 'Ótimo — qual é o número de celular do assinante para eu encontrar o recibo dele?', askMobileEmpty: 'Qual é o número de celular do assinante?', askGoal: 'Qual é o nome da meta para o recibo de {name}?' },
  zh: { askMobile: '好的 — 订阅者的手机号是多少，这样我才能找到他们的收据？', askMobileEmpty: '订阅者的手机号是多少？', askGoal: '{name}的收据对应哪个目标？' }
};
const DOWNLOAD_RECEIPT_MOBILE_RE = new RegExp(Object.values(DOWNLOAD_RECEIPT_TEXT).map(t => `^${escapeRegExp(t.askMobile)}$`).join('|'), 'i');
const DOWNLOAD_RECEIPT_GOAL_RE = { test: (text) => testFlowAnyLang(DOWNLOAD_RECEIPT_TEXT, 'askGoal', text) };
PENDING_FLOW_MARKERS.push(DOWNLOAD_RECEIPT_MOBILE_RE, DOWNLOAD_RECEIPT_GOAL_RE);

function downloadReceiptMobileQuestion() {
  return renderFlow(DOWNLOAD_RECEIPT_TEXT, 'askMobile');
}

function parseDownloadReceipt(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  // Step 2: answering "what's the goal name for <mobile>'s receipt?"
  if (lastAssistant && DOWNLOAD_RECEIPT_GOAL_RE.test(lastAssistant.content)) {
    const extracted = execFlowAnyLang(DOWNLOAD_RECEIPT_TEXT, 'askGoal', lastAssistant.content);
    const subscriberName = extracted ? extracted.name : '';
    const goalName = msg.replace(/[.?!]+$/, '').trim();
    if (!goalName) return { reply: renderFlow(DOWNLOAD_RECEIPT_TEXT, 'askGoal', { name: subscriberName }), handled: true };
    return { reply: 'Here\'s what I understood:', action: { type: 'download_receipt', params: { subscriberName, goalName } }, handled: true };
  }

  // Step 1: answering "what's the subscriber's mobile number...?"
  if (lastAssistant && DOWNLOAD_RECEIPT_MOBILE_RE.test(lastAssistant.content)) {
    const mobileMatch = msg.match(/\b(\d{6,15})\b/);
    const subscriberName = mobileMatch ? mobileMatch[1] : msg.replace(/[.?!]+$/, '').trim();
    if (!subscriberName) return { reply: renderFlow(DOWNLOAD_RECEIPT_TEXT, 'askMobileEmpty'), handled: true };
    return { reply: renderFlow(DOWNLOAD_RECEIPT_TEXT, 'askGoal', { name: subscriberName }), handled: true };
  }

  return null;
}

// "reopen my last support ticket" / "reopen my ticket" — always resolved
// against the account's own most-recently-solved ticket, never guessed by
// description (too error-prone from voice), so no name/id extraction here.
// Confirm-first like everything else, but has no fields to collect after
// that — a "yes" goes straight to proposing the action.
const REOPEN_TICKET_TEXT = {
  en: 'Are you saying you\'d like to reopen your last support ticket?',
  de: 'Möchten Sie Ihr letztes Support-Ticket wieder öffnen?',
  fr: 'Voulez-vous dire que vous souhaitez rouvrir votre dernier ticket d\'assistance ?',
  es: '¿Quieres decir que te gustaría reabrir tu último ticket de soporte?',
  ar: 'هل تقصد أنك تريد إعادة فتح آخر تذكرة دعم لك؟',
  ru: 'Вы хотите повторно открыть свою последнюю заявку в поддержку?',
  pt: 'Você gostaria de reabrir seu último chamado de suporte?',
  zh: '您是想重新打开您最近的支持工单吗？'
};
const REOPEN_TICKET_CONFIRM_RE = new RegExp(Object.values(REOPEN_TICKET_TEXT).map(t => escapeRegExp(t)).join('|'), 'i');
PENDING_FLOW_MARKERS.push(REOPEN_TICKET_CONFIRM_RE);

const REOPEN_WORD_RE = /\breopen\b|wieder öffnen|wiedereröffnen|\brouvrir\b|\breabrir\b|إعادة فتح|повторно открыть|重新打开/i;

function parseReopenTicket(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');
  if (lastAssistant && REOPEN_TICKET_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: 'Here\'s what I understood:', action: { type: 'reopen_ticket', params: {} }, handled: true };
  }
  if (!HOW_TO_RE.test(msg) && TICKET_WORD_RE.test(msg) && REOPEN_WORD_RE.test(msg)) {
    return { reply: REOPEN_TICKET_TEXT[currentLang] || REOPEN_TICKET_TEXT.en, handled: true };
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
// The currency LIST itself is universal currency codes (USD, EUR, ...), not
// translated, so only the surrounding question wording is localized.
const SET_CURRENCY_TEXT = {
  en: { confirm: 'Are you saying you\'d like to change your collection currency?', askWhich: `Great — which currency — one of: ${SUPPORTED_CURRENCIES.join(', ')}?`, askWhichEmpty: `Which currency — one of: ${SUPPORTED_CURRENCIES.join(', ')}?` },
  de: { confirm: 'Möchten Sie Ihre Inkassowährung ändern?', askWhich: `Gut — welche Währung — eine von: ${SUPPORTED_CURRENCIES.join(', ')}?`, askWhichEmpty: `Welche Währung — eine von: ${SUPPORTED_CURRENCIES.join(', ')}?` },
  fr: { confirm: 'Voulez-vous dire que vous souhaitez changer votre devise de collecte ?', askWhich: `Très bien — quelle devise — l'une de : ${SUPPORTED_CURRENCIES.join(', ')} ?`, askWhichEmpty: `Quelle devise — l'une de : ${SUPPORTED_CURRENCIES.join(', ')} ?` },
  es: { confirm: '¿Quieres decir que te gustaría cambiar tu moneda de cobro?', askWhich: `Genial — ¿qué moneda — una de: ${SUPPORTED_CURRENCIES.join(', ')}?`, askWhichEmpty: `¿Qué moneda — una de: ${SUPPORTED_CURRENCIES.join(', ')}?` },
  ar: { confirm: 'هل تقصد أنك تريد تغيير عملة التحصيل الخاصة بك؟', askWhich: `رائع — أي عملة — واحدة من: ${SUPPORTED_CURRENCIES.join('، ')}؟`, askWhichEmpty: `أي عملة — واحدة من: ${SUPPORTED_CURRENCIES.join('، ')}؟` },
  ru: { confirm: 'Вы хотите изменить валюту сбора?', askWhich: `Отлично — какая валюта — одна из: ${SUPPORTED_CURRENCIES.join(', ')}?`, askWhichEmpty: `Какая валюта — одна из: ${SUPPORTED_CURRENCIES.join(', ')}?` },
  pt: { confirm: 'Você gostaria de alterar sua moeda de cobrança?', askWhich: `Ótimo — qual moeda — uma de: ${SUPPORTED_CURRENCIES.join(', ')}?`, askWhichEmpty: `Qual moeda — uma de: ${SUPPORTED_CURRENCIES.join(', ')}?` },
  zh: { confirm: '您是想更改您的收款货币吗？', askWhich: `好的 — 哪种货币 — 以下之一：${SUPPORTED_CURRENCIES.join('、')}？`, askWhichEmpty: `哪种货币 — 以下之一：${SUPPORTED_CURRENCIES.join('、')}？` }
};
const SET_CURRENCY_CONFIRM_RE = new RegExp(Object.values(SET_CURRENCY_TEXT).map(t => escapeRegExp(t.confirm)).join('|'), 'i');
const SET_CURRENCY_WHICH_RE = new RegExp(Object.values(SET_CURRENCY_TEXT).map(t => `^${escapeRegExp(t.askWhich)}$`).join('|'));
PENDING_FLOW_MARKERS.push(SET_CURRENCY_CONFIRM_RE, SET_CURRENCY_WHICH_RE);

const CURRENCY_WORD_RE = /\bcurrency\b|währung|\bdevise\b|\bmoneda\b|عملة|валюта|moeda|货币/i;
const CHANGE_SET_WORD_RE = /\b(change|set|switch)\b|ändern|festlegen|\bchanger\b|\bdéfinir\b|\bcambiar\b|\bestablecer\b|تغيير|تعيين|измен|установ|alterar|definir|更改|设置/i;

function parseSetCurrency(msg, history) {
  const fastCurrency = matchCurrency(msg);
  if (fastCurrency) {
    return { reply: 'Here\'s what I understood:', action: { type: 'set_currency', params: { currency: fastCurrency } }, handled: true };
  }

  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  if (lastAssistant && SET_CURRENCY_WHICH_RE.test(lastAssistant.content)) {
    return { reply: renderFlow(SET_CURRENCY_TEXT, 'askWhichEmpty'), handled: true };
  }

  if (lastAssistant && SET_CURRENCY_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    return { reply: renderFlow(SET_CURRENCY_TEXT, 'askWhich'), handled: true };
  }

  if (!HOW_TO_RE.test(msg) && CURRENCY_WORD_RE.test(msg) && CHANGE_SET_WORD_RE.test(msg)) {
    return { reply: renderFlow(SET_CURRENCY_TEXT, 'confirm'), handled: true };
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
const ANY_OTHER_TEXT = {
  en: 'Please enter your requirement below.',
  de: 'Bitte geben Sie unten Ihr Anliegen ein.',
  fr: 'Veuillez saisir votre demande ci-dessous.',
  es: 'Por favor, escribe tu solicitud a continuación.',
  ar: 'يرجى إدخال طلبك أدناه.',
  ru: 'Пожалуйста, введите ваш запрос ниже.',
  pt: 'Por favor, insira sua solicitação abaixo.',
  zh: '请在下方输入您的需求。'
};
const ANY_OTHER_ASK_RE = new RegExp(
  Object.values(ANY_OTHER_TEXT).map(t => `^${escapeRegExp(t)}$`).join('|'),
  'i'
);
PENDING_FLOW_MARKERS.push(ANY_OTHER_ASK_RE);

function anyOtherAskText() {
  return ANY_OTHER_TEXT[currentLang] || ANY_OTHER_TEXT.en;
}

function parseAnyOtherLookup(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');
  if (!(lastAssistant && ANY_OTHER_ASK_RE.test(lastAssistant.content))) return null;
  const trimmed = msg.trim();
  if (!trimmed) return { reply: anyOtherAskText(), handled: true };
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
// Menu text + option list localized to all 8 UI languages, same approach
// as ROOT_MENU_TEXT. The follow-up REPLIES for options 1/5/6/7 (which hand
// off into their own flows — create/complete/rollover/receipt-lookup)
// deliberately stay English literal below (CREATE_GOAL_NAME_RE etc. match
// that exact text elsewhere) — only the menu itself and the terminal
// options (2/3/4/8, which just loop back to this same menu) are fully
// localized both ways.
const GOAL_MENU_TEXT = {
  en: { intro: 'I\'m not quite sure what you\'d like to do with a goal. Please choose one:', options: ['Create a Goal', 'View Goals', 'List of Pending Subscribers', 'Delete a Goal', 'Mark Goal as Complete', 'Stop Rollover the Goal', 'Download Receipt', 'Any other'], openingGoals: 'Opening Goals for you.' },
  de: { intro: 'Ich bin nicht ganz sicher, was Sie mit einem Ziel tun möchten. Bitte wählen Sie eine Option:', options: ['Ziel erstellen', 'Ziele anzeigen', 'Liste ausstehender Abonnenten', 'Ziel löschen', 'Ziel als abgeschlossen markieren', 'Rollover des Ziels stoppen', 'Beleg herunterladen', 'Sonstiges'], openingGoals: 'Öffne Ziele für Sie.' },
  fr: { intro: 'Je ne suis pas sûr de ce que vous souhaitez faire avec un objectif. Veuillez choisir une option :', options: ['Créer un objectif', 'Voir les objectifs', 'Liste des abonnés en attente', 'Supprimer un objectif', 'Marquer l\'objectif comme terminé', 'Arrêter le report de l\'objectif', 'Télécharger le reçu', 'Autre chose'], openingGoals: 'Ouverture des Objectifs pour vous.' },
  es: { intro: 'No estoy seguro de qué quieres hacer con una meta. Elige una opción:', options: ['Crear una meta', 'Ver metas', 'Lista de suscriptores pendientes', 'Eliminar una meta', 'Marcar meta como completada', 'Detener la renovación de la meta', 'Descargar el recibo', 'Otra cosa'], openingGoals: 'Abriendo Metas para ti.' },
  ar: { intro: 'لست متأكدًا تمامًا مما تريد فعله بخصوص هدف. يرجى اختيار خيار:', options: ['إنشاء هدف', 'عرض الأهداف', 'قائمة المشتركين المعلّقين', 'حذف هدف', 'تعليم الهدف كمكتمل', 'إيقاف تدوير الهدف', 'تنزيل الإيصال', 'أخرى'], openingGoals: 'يتم فتح الأهداف من أجلك.' },
  ru: { intro: 'Я не совсем понял, что вы хотите сделать с целью. Пожалуйста, выберите вариант:', options: ['Создать цель', 'Просмотреть цели', 'Список ожидающих подписчиков', 'Удалить цель', 'Отметить цель как выполненную', 'Остановить перенос цели', 'Скачать квитанцию', 'Другое'], openingGoals: 'Открываю раздел «Цели» для вас.' },
  pt: { intro: 'Não tenho certeza do que você gostaria de fazer com uma meta. Por favor, escolha uma opção:', options: ['Criar uma meta', 'Ver metas', 'Lista de assinantes pendentes', 'Excluir uma meta', 'Marcar meta como concluída', 'Parar a renovação da meta', 'Baixar recibo', 'Outra coisa'], openingGoals: 'Abrindo Metas para você.' },
  zh: { intro: '我不太确定您想对目标做什么。请选择一项：', options: ['创建目标', '查看目标', '待处理订阅者列表', '删除目标', '将目标标记为已完成', '停止目标滚动', '下载收据', '其他'], openingGoals: '正在为您打开目标。' }
};

const GOAL_OPTION_KEYWORDS = {
  en: { 1: /\bcreate\b/i, 2: /\bview\b/i, 3: /\bpending\b|\bmissed\b/i, 4: /\bdelete\b/i, 5: /\bcomplete\b/i, 6: /\brollover\b|\brolling over\b/i, 7: /\breceipt\b|\bdownload\b/i, 8: /\b(something else|not covered|other|claude|ai)\b/i },
  de: { 1: /\berstell/i, 2: /\banzeig/i, 3: /\bverpasst\b|\bausstehend\b/i, 4: /\blösch/i, 5: /\babgeschlossen\b|\bkomplett/i, 6: /\brollover\b/i, 7: /\bbeleg\b|\bherunterlad/i, 8: /\b(sonstiges|etwas anderes|andere|claude|ai)\b/i },
  fr: { 1: /\bcré/i, 2: /\bvoir\b/i, 3: /\bmanqu[ée]s?(?!\w)|\battente\b/i, 4: /\bsupprim/i, 5: /\btermin/i, 6: /\breport\b/i, 7: /\breçu\b|\btélécharg/i, 8: /\b(autre chose|autre|claude|ai)\b/i },
  es: { 1: /\bcrear\b/i, 2: /\bver\b/i, 3: /\bpendientes?\b|\bperdidos?\b/i, 4: /\beliminar\b/i, 5: /\bcompletad/i, 6: /\brenovaci[oó]n\b/i, 7: /\brecibo\b|\bdescargar\b/i, 8: /\b(otra cosa|otro|claude|ai)\b/i },
  ar: { 1: /إنشاء/, 2: /عرض/, 3: /فائت|معلق|معلّق/, 4: /حذف/, 5: /مكتمل/, 6: /تدوير/, 7: /إيصال|تنزيل/, 8: /أخرى|claude|ai/i },
  ru: { 1: /созда/i, 2: /просмотр/i, 3: /пропущено|ожидает/i, 4: /удал/i, 5: /выполн/i, 6: /перенос/i, 7: /квитанц/i, 8: /другое|claude|ai/i },
  pt: { 1: /\bcriar\b/i, 2: /\bver\b/i, 3: /\bperdidos?\b|\bpendentes?\b/i, 4: /\bexcluir\b/i, 5: /\bconcluíd/i, 6: /\brenovaç/i, 7: /\brecibo\b|\bbaixar\b/i, 8: /\b(outra coisa|outro|claude|ai)\b/i },
  zh: { 1: /创建/, 2: /查看/, 3: /待处理|错过/, 4: /删除/, 5: /完成/, 6: /滚动/, 7: /收据|下载/, 8: /其他|claude|ai/i }
};

const GOAL_TOPIC_RE = { en: /\bgoal\b/i, de: /\bziel/i, fr: /\bobjectif/i, es: /\bmeta\b/i, ar: /هدف/, ru: /цел/i, pt: /\bmeta\b/i, zh: /目标/ };

function goalMenuQuestion() {
  const t = GOAL_MENU_TEXT[currentLang] || GOAL_MENU_TEXT.en;
  return `${t.intro}\n${t.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`;
}

const GOAL_MENU_RE = new RegExp(
  Object.values(GOAL_MENU_TEXT).map(t => escapeRegExp(t.intro)).join('|'),
  'i'
);
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
  const kw = GOAL_OPTION_KEYWORDS[currentLang] || GOAL_OPTION_KEYWORDS.en;
  const t = GOAL_MENU_TEXT[currentLang] || GOAL_MENU_TEXT.en;

  if (lastAssistant && GOAL_MENU_RE.test(lastAssistant.content)) {
    const choice = msg.trim().toLowerCase();

    // Option 7's reply text below stays English literal on purpose —
    // GOALS_LIST_RECEIPTS_WHO_RE matches that exact text elsewhere and
    // hands off into its own (not-yet-localized) flow. Options 1/5/6 hand
    // off into create_goal/mark_goal_complete/stop_rollover, which are now
    // fully localized, so their handoff text uses each flow's own TEXT
    // table instead of a hardcoded English literal.
    if (/^1\b/.test(choice) || (kw[1].test(choice) && !kw[4].test(choice))) {
      return { reply: renderFlow(CREATE_GOAL_TEXT, 'askName'), handled: true };
    }
    // Options 2-4 and 7 are terminal or hand off elsewhere without looping
    // back automatically on their own — the menu is re-appended after each
    // terminal reply so the next pick ("4", "6", etc.) still has the menu
    // question as the last assistant turn to match against, instead of
    // falling through to Claude with nothing to go on.
    if (/^2\b/.test(choice) || kw[2].test(choice)) {
      return { reply: `${t.openingGoals}\n\n${goalMenuQuestion()}`, action: { type: 'view_goals', params: {} }, handled: true };
    }
    if (/^3\b/.test(choice) || kw[3].test(choice)) {
      const rootT = ROOT_MENU_TEXT[currentLang] || ROOT_MENU_TEXT.en;
      return { reply: `${rootT.openingPending}\n\n${goalMenuQuestion()}`, action: { type: 'view_pending', params: {} }, handled: true };
    }
    if (/^4\b/.test(choice) || kw[4].test(choice)) {
      const deleteResult = handleDeleteIntent('delete goal');
      return { reply: `${deleteResult.reply}\n\n${goalMenuQuestion()}`, handled: true };
    }
    if (/^5\b/.test(choice) || kw[5].test(choice)) {
      return { reply: renderFlow(MARK_COMPLETE_TEXT, 'askName'), handled: true };
    }
    if (/^6\b/.test(choice) || kw[6].test(choice)) {
      return { reply: renderFlow(STOP_ROLLOVER_TEXT, 'askName'), handled: true };
    }
    if (/^7\b/.test(choice) || kw[7].test(choice)) {
      return { reply: 'Great — what\'s the subscriber\'s name or mobile number, so I can list their receipts?', handled: true };
    }
    if (/^8\b/.test(choice) || kw[8].test(choice)) {
      return { reply: anyOtherAskText(), handled: true };
    }

    // Unrecognized reply to the menu — re-ask rather than guess.
    return { reply: goalMenuQuestion(), handled: true };
  }

  const topicRe = GOAL_TOPIC_RE[currentLang] || GOAL_TOPIC_RE.en;
  if (!HOW_TO_RE.test(msg) && topicRe.test(msg)) {
    return { reply: goalMenuQuestion(), handled: true };
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
// Every option here is terminal (read-only reports/navigation, nothing
// hands off into another flow), so this menu is fully localized end to
// end — unlike Goals/Subscribers/Collect, there's no English-literal
// marker text downstream to preserve.
const ACCOUNTING_MENU_TEXT = {
  en: { intro: 'I\'m not quite sure what you\'d like to do in Accounting. Please choose one:', options: ['View Total Amount Collected', 'Download Total Collected — Day-wise', 'Download Total Collected — Goal-wise', 'List of Pending & Paid', 'Insights (charts & report)', 'Any other'], downloadingDaywise: 'Downloading your day-wise ledger.', downloadingGoalwise: 'Downloading your goal-wise ledger.', pickGoalForReport: 'Here are your active goals — pick one for the pending & paid report.', generatingInsights: 'Generating your insights report.' },
  de: { intro: 'Ich bin nicht ganz sicher, was Sie in der Buchhaltung tun möchten. Bitte wählen Sie eine Option:', options: ['Gesamtbetrag anzeigen', 'Gesamtbetrag herunterladen — nach Tag', 'Gesamtbetrag herunterladen — nach Ziel', 'Liste Ausstehend & Bezahlt', 'Einblicke (Diagramme & Bericht)', 'Sonstiges'], downloadingDaywise: 'Ihr tagesweises Kontobuch wird heruntergeladen.', downloadingGoalwise: 'Ihr zielweises Kontobuch wird heruntergeladen.', pickGoalForReport: 'Hier sind Ihre aktiven Ziele — wählen Sie eines für den Bericht über Ausstehend & Bezahlt.', generatingInsights: 'Ihr Einblicke-Bericht wird erstellt.' },
  fr: { intro: 'Je ne suis pas sûr de ce que vous souhaitez faire en Comptabilité. Veuillez choisir une option :', options: ['Voir le montant total collecté', 'Télécharger le total collecté — par jour', 'Télécharger le total collecté — par objectif', 'Liste En attente et Payé', 'Aperçus (graphiques et rapport)', 'Autre chose'], downloadingDaywise: 'Téléchargement de votre registre quotidien.', downloadingGoalwise: 'Téléchargement de votre registre par objectif.', pickGoalForReport: 'Voici vos objectifs actifs — choisissez-en un pour le rapport En attente et Payé.', generatingInsights: 'Génération de votre rapport d\'aperçus.' },
  es: { intro: 'No estoy seguro de qué quieres hacer en Contabilidad. Elige una opción:', options: ['Ver el monto total recaudado', 'Descargar total recaudado — por día', 'Descargar total recaudado — por meta', 'Lista de Pendientes y Pagados', 'Perspectivas (gráficos e informe)', 'Otra cosa'], downloadingDaywise: 'Descargando tu libro diario.', downloadingGoalwise: 'Descargando tu libro por meta.', pickGoalForReport: 'Aquí están tus metas activas — elige una para el informe de pendientes y pagados.', generatingInsights: 'Generando tu informe de perspectivas.' },
  ar: { intro: 'لست متأكدًا تمامًا مما تريد فعله في المحاسبة. يرجى اختيار خيار:', options: ['عرض إجمالي المبلغ المُحصَّل', 'تنزيل الإجمالي المُحصَّل — يوميًا', 'تنزيل الإجمالي المُحصَّل — حسب الهدف', 'قائمة المعلّق والمدفوع', 'رؤى (رسوم بيانية وتقرير)', 'أخرى'], downloadingDaywise: 'جارٍ تنزيل سجلك اليومي.', downloadingGoalwise: 'جارٍ تنزيل سجلك حسب الهدف.', pickGoalForReport: 'إليك أهدافك النشطة — اختر واحدًا لتقرير المعلّق والمدفوع.', generatingInsights: 'جارٍ إنشاء تقرير الرؤى الخاص بك.' },
  ru: { intro: 'Я не совсем понял, что вы хотите сделать в разделе Бухгалтерия. Пожалуйста, выберите вариант:', options: ['Посмотреть общую собранную сумму', 'Скачать общую сумму — по дням', 'Скачать общую сумму — по целям', 'Список Ожидает и Оплачено', 'Аналитика (графики и отчёт)', 'Другое'], downloadingDaywise: 'Скачиваю вашу книгу по дням.', downloadingGoalwise: 'Скачиваю вашу книгу по целям.', pickGoalForReport: 'Вот ваши активные цели — выберите одну для отчёта «Ожидает и Оплачено».', generatingInsights: 'Формирую ваш отчёт с аналитикой.' },
  pt: { intro: 'Não tenho certeza do que você gostaria de fazer na Contabilidade. Por favor, escolha uma opção:', options: ['Ver o valor total arrecadado', 'Baixar total arrecadado — por dia', 'Baixar total arrecadado — por meta', 'Lista de Pendentes e Pagos', 'Insights (gráficos e relatório)', 'Outra coisa'], downloadingDaywise: 'Baixando seu livro diário.', downloadingGoalwise: 'Baixando seu livro por meta.', pickGoalForReport: 'Aqui estão suas metas ativas — escolha uma para o relatório de pendentes e pagos.', generatingInsights: 'Gerando seu relatório de insights.' },
  zh: { intro: '我不太确定您想在账务中做什么。请选择一项：', options: ['查看已收总金额', '下载已收总额 — 按日', '下载已收总额 — 按目标', '待处理与已付款列表', '洞察（图表与报告）', '其他'], downloadingDaywise: '正在下载您的按日账本。', downloadingGoalwise: '正在下载您的按目标账本。', pickGoalForReport: '以下是您的活跃目标 — 选择一个用于待处理与已付款报告。', generatingInsights: '正在生成您的洞察报告。' }
};

const ACCOUNTING_OPTION_KEYWORDS = {
  en: { 1: /\btotal\b/i, 2: /\bday\b|\bdaywise\b/i, 3: /\bgoal\b|\bgoalwise\b/i, 4: /\bpending\b|\bpaid\b/i, 5: /\binsights?\b/i, 6: /\b(something else|not covered|other|claude|ai)\b/i },
  de: { 1: /\bgesamt/i, 2: /\btag\b/i, 3: /\bziel\b/i, 4: /\bausstehend\b|\bbezahlt\b/i, 5: /\beinblick/i, 6: /\b(sonstiges|etwas anderes|andere|claude|ai)\b/i },
  fr: { 1: /\btotal\b/i, 2: /\bjour\b/i, 3: /\bobjectif\b/i, 4: /\battente\b|\bpayé(?!\w)/i, 5: /\baperçus?\b/i, 6: /\b(autre chose|autre|claude|ai)\b/i },
  es: { 1: /\btotal\b/i, 2: /\bd[ií]a\b/i, 3: /\bmeta\b/i, 4: /\bpendientes?\b|\bpagados?\b/i, 5: /\bperspectivas?\b/i, 6: /\b(otra cosa|otro|claude|ai)\b/i },
  ar: { 1: /إجمالي/, 2: /يومي/, 3: /هدف/, 4: /معلّق|مدفوع/, 5: /رؤى/, 6: /أخرى|claude|ai/i },
  ru: { 1: /общ/i, 2: /дн[яеьи]/i, 3: /цел/i, 4: /ожидает|оплачено/i, 5: /аналитик/i, 6: /другое|claude|ai/i },
  pt: { 1: /\btotal\b/i, 2: /\bdia\b/i, 3: /\bmeta\b/i, 4: /\bpendentes?\b|\bpagos?\b/i, 5: /\binsights?\b/i, 6: /\b(outra coisa|outro|claude|ai)\b/i },
  zh: { 1: /总/, 2: /按日/, 3: /按目标/, 4: /待处理|已付款/, 5: /洞察/, 6: /其他|claude|ai/i }
};

const ACCOUNTING_TOPIC_RE = { en: /\baccounting\b|\baccounts?\b/i, de: /\bbuchhaltung\b/i, fr: /\bcomptabilit[ée](?!\w)/i, es: /\bcontabilidad\b/i, ar: /محاسبة/, ru: /бухгалтери/i, pt: /\bcontabilidade\b/i, zh: /账务|财务/ };

function accountingMenuQuestion() {
  const t = ACCOUNTING_MENU_TEXT[currentLang] || ACCOUNTING_MENU_TEXT.en;
  return `${t.intro}\n${t.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`;
}

const ACCOUNTING_MENU_RE = new RegExp(
  Object.values(ACCOUNTING_MENU_TEXT).map(t => escapeRegExp(t.intro)).join('|'),
  'i'
);
PENDING_FLOW_MARKERS.push(ACCOUNTING_MENU_RE);

function parseAccountingFallbackMenu(msg, history) {
  const safeHistory = Array.isArray(history) ? history : [];
  const lastAssistant = [...safeHistory].reverse().find(h => h.role === 'assistant');
  const kw = ACCOUNTING_OPTION_KEYWORDS[currentLang] || ACCOUNTING_OPTION_KEYWORDS.en;
  const t = ACCOUNTING_MENU_TEXT[currentLang] || ACCOUNTING_MENU_TEXT.en;

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
    if (/^1\b/.test(choice) || kw[1].test(choice)) {
      return { reply: '', action: { type: 'report_query', params: { metric: 'total_collected' } }, handled: true };
    }
    if (/^2\b/.test(choice) || kw[2].test(choice)) {
      return { reply: `${t.downloadingDaywise}\n\n${accountingMenuQuestion()}`, action: { type: 'download_daywise_ledger', params: {} }, handled: true };
    }
    if (/^3\b/.test(choice) || kw[3].test(choice)) {
      return { reply: `${t.downloadingGoalwise}\n\n${accountingMenuQuestion()}`, action: { type: 'download_goalwise_ledger', params: {} }, handled: true };
    }
    if (/^4\b/.test(choice) || kw[4].test(choice)) {
      return { reply: `${t.pickGoalForReport}\n\n${accountingMenuQuestion()}`, action: { type: 'list_goals_for_report', params: {} }, handled: true };
    }
    if (/^5\b/.test(choice) || kw[5].test(choice)) {
      return { reply: `${t.generatingInsights}\n\n${accountingMenuQuestion()}`, action: { type: 'download_insights_report', params: {} }, handled: true };
    }
    if (/^6\b/.test(choice) || kw[6].test(choice)) {
      return { reply: anyOtherAskText(), handled: true };
    }

    // Unrecognized reply to the menu — re-ask rather than guess.
    return { reply: accountingMenuQuestion(), handled: true };
  }

  const topicRe = ACCOUNTING_TOPIC_RE[currentLang] || ACCOUNTING_TOPIC_RE.en;
  if (!HOW_TO_RE.test(msg) && topicRe.test(msg)) {
    return { reply: accountingMenuQuestion(), handled: true };
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
//
// Localized to all 8 UI languages (see ROOT_MENU_TEXT above) — the marker
// regex matches ANY language's greeting line, and replies/keyword matching
// use `currentLang` (set once per request in parseLocalIntent) to reply in
// the same language the greeting was shown in.
// ---------------------------------------------------------------
const ROOT_MENU_RE = new RegExp(
  Object.values(ROOT_MENU_TEXT).map(t => escapeRegExp(t.pickLine)).join('|'),
  'i'
);
PENDING_FLOW_MARKERS.push(ROOT_MENU_RE);

// Shared between parseRootMenu (a menu pick) and parseBareNumberLookup
// below (a bare number typed with no menu actually showing) — both need
// to resolve "which root-menu option is this" to the exact same result.
// parseBareNumberLookup's confirmation question isn't localized yet (a
// narrower fallback, out of scope for this pass), so it always uses the
// English labels — rootOptionResult below still replies in currentLang.
const ROOT_OPTION_LABELS = { 1: 'Goals', 2: 'Subscribers', 3: 'Pending/Missed', 4: 'Accounting', 5: 'Any other' };

function rootOptionResult(num) {
  const t = ROOT_MENU_TEXT[currentLang] || ROOT_MENU_TEXT.en;
  switch (num) {
    case 1: return { reply: goalMenuQuestion(), handled: true };
    case 2: return { reply: subscriberMenuQuestion(), handled: true };
    case 3: return { reply: `${t.openingPending}\n\n${rootMenuQuestion(currentLang)}`, action: { type: 'view_pending', params: {} }, handled: true };
    case 4: return { reply: accountingMenuQuestion(), handled: true };
    case 5: return { reply: anyOtherAskText(), handled: true };
    default: return null;
  }
}

function parseRootMenu(msg, history) {
  const safeHistory = Array.isArray(history) ? history : [];
  const lastAssistant = [...safeHistory].reverse().find(h => h.role === 'assistant');
  if (!(lastAssistant && ROOT_MENU_RE.test(lastAssistant.content))) return null;

  const choice = msg.trim().toLowerCase();
  const kw = ROOT_OPTION_KEYWORDS[currentLang] || ROOT_OPTION_KEYWORDS.en;

  if (/^1\b/.test(choice) || kw[1].test(choice)) return rootOptionResult(1);
  if (/^2\b/.test(choice) || kw[2].test(choice)) return rootOptionResult(2);
  if (/^3\b/.test(choice) || kw[3].test(choice)) return rootOptionResult(3);
  if (/^4\b/.test(choice) || kw[4].test(choice)) return rootOptionResult(4);
  if (/^5\b/.test(choice) || kw[5].test(choice)) return rootOptionResult(5);

  // Unrecognized reply to the menu — re-ask rather than guess.
  return { reply: rootMenuQuestion(currentLang), handled: true };
}

// ---------------------------------------------------------------
// BARE NUMBER LOOKUP — a lone digit ("4") typed with NO menu actually
// pending (reaching this point at all already proves that — see the
// bare-cancel-word comment above). Rather than either guessing it means
// a root-menu pick or escalating a meaningless single digit to Claude,
// confirm which section it might mean first. If confirmed (yes), jump
// straight into that section's own menu, exactly as picking it from the
// root menu would. If not confirmed, this returns null and normal
// dispatch continues — which naturally ends in escalating to Claude if
// nothing else recognizes the message either, per "if uncertain, forward
// to Claude."
// ---------------------------------------------------------------
const BARE_NUMBER_CONFIRM_RE = /^are you saying you'd like to open option (\d+) — (.+?)\?$/i;
PENDING_FLOW_MARKERS.push(BARE_NUMBER_CONFIRM_RE);

function parseBareNumberLookup(msg, history) {
  const lastAssistant = [...(history || [])].reverse().find(h => h.role === 'assistant');

  if (lastAssistant && BARE_NUMBER_CONFIRM_RE.test(lastAssistant.content)) {
    if (!AFFIRMATIVE_RE.test(msg)) return null;
    const [, numStr] = lastAssistant.content.match(BARE_NUMBER_CONFIRM_RE);
    return rootOptionResult(Number(numStr));
  }

  const bareMatch = msg.trim().match(/^([1-5])$/);
  if (bareMatch && ROOT_OPTION_LABELS[bareMatch[1]]) {
    return { reply: `Are you saying you'd like to open option ${bareMatch[1]} — ${ROOT_OPTION_LABELS[bareMatch[1]]}?`, handled: true };
  }

  return null;
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
// Options 1/2 hand off into create_payment_link/download_receipt, both now
// fully localized, so their reply text uses each flow's own TEXT table
// instead of a hardcoded English literal — see paymentLinkViaMenuQuestion()/
// downloadReceiptMobileQuestion() below.
const COLLECT_MENU_TEXT = {
  en: { intro: 'I\'m not quite sure what you\'d like to do regarding a payment. Please choose one:', options: ['Collect payment (generate a payment link)', 'Download the receipt', 'Delete the payment/receipt', 'How to pay the amount', 'Something else'], howto: 'Open the relevant goal or subscriber (or the Pending tab) -> "Collect Payment" -> enter the amount -> Save. Or just say "collect 500 from <name> for <goal>" and I\'ll do it for you.' },
  de: { intro: 'Ich bin nicht ganz sicher, was Sie bezüglich einer Zahlung tun möchten. Bitte wählen Sie eine Option:', options: ['Zahlung einziehen (Zahlungslink erstellen)', 'Beleg herunterladen', 'Zahlung/Beleg löschen', 'Wie der Betrag bezahlt wird', 'Etwas anderes'], howto: 'Öffnen Sie das betreffende Ziel oder den Abonnenten (oder den Tab Ausstehend) -> "Zahlung einziehen" -> Betrag eingeben -> Speichern. Oder sagen Sie einfach "500 von <Name> für <Ziel> einziehen" und ich erledige es für Sie.' },
  fr: { intro: 'Je ne suis pas sûr de ce que vous souhaitez faire concernant un paiement. Veuillez choisir une option :', options: ['Encaisser un paiement (générer un lien de paiement)', 'Télécharger le reçu', 'Supprimer le paiement/reçu', 'Comment payer le montant', 'Autre chose'], howto: 'Ouvrez l\'objectif ou l\'abonné concerné (ou l\'onglet En attente) -> "Encaisser un paiement" -> saisissez le montant -> Enregistrer. Ou dites simplement "encaisser 500 de <nom> pour <objectif>" et je le ferai pour vous.' },
  es: { intro: 'No estoy seguro de qué quieres hacer con un pago. Elige una opción:', options: ['Cobrar pago (generar un enlace de pago)', 'Descargar el recibo', 'Eliminar el pago/recibo', 'Cómo pagar el monto', 'Otra cosa'], howto: 'Abre la meta o el suscriptor correspondiente (o la pestaña Pendientes) -> "Cobrar pago" -> ingresa el monto -> Guardar. O simplemente di "cobrar 500 de <nombre> para <meta>" y lo haré por ti.' },
  ar: { intro: 'لست متأكدًا تمامًا مما تريد فعله بخصوص دفعة. يرجى اختيار خيار:', options: ['تحصيل دفعة (إنشاء رابط دفع)', 'تنزيل الإيصال', 'حذف الدفعة/الإيصال', 'كيفية دفع المبلغ', 'شيء آخر'], howto: 'افتح الهدف أو المشترك المعني (أو تبويب المعلّق) -> "تحصيل دفعة" -> أدخل المبلغ -> حفظ. أو فقط قل "حصّل 500 من <الاسم> مقابل <الهدف>" وسأقوم بذلك نيابة عنك.' },
  ru: { intro: 'Я не совсем понял, что вы хотите сделать с платежом. Пожалуйста, выберите вариант:', options: ['Принять платёж (создать ссылку на оплату)', 'Скачать квитанцию', 'Удалить платёж/квитанцию', 'Как оплатить сумму', 'Другое'], howto: 'Откройте нужную цель или подписчика (или вкладку «Ожидает») -> «Принять платёж» -> введите сумму -> Сохранить. Или просто скажите «принять 500 от <имя> за <цель>», и я сделаю это за вас.' },
  pt: { intro: 'Não tenho certeza do que você gostaria de fazer em relação a um pagamento. Por favor, escolha uma opção:', options: ['Cobrar pagamento (gerar um link de pagamento)', 'Baixar o recibo', 'Excluir o pagamento/recibo', 'Como pagar o valor', 'Outra coisa'], howto: 'Abra a meta ou o assinante relevante (ou a aba Pendentes) -> "Cobrar pagamento" -> insira o valor -> Salvar. Ou apenas diga "cobrar 500 de <nome> para <meta>" e eu faço por você.' },
  zh: { intro: '我不太确定您想对付款做什么。请选择一项：', options: ['收款（生成付款链接）', '下载收据', '删除付款/收据', '如何支付金额', '其他'], howto: '打开相关目标或订阅者（或"待处理"标签页）-> "收款" -> 输入金额 -> 保存。或者直接说"从<姓名>收<目标>的500"，我会为您完成。' }
};

const COLLECT_OPTION_KEYWORDS = {
  en: { 1: /\bcollect\b/i, 2: /\breceipt\b|\bdownload\b/i, 3: /\bdelete\b/i, 4: /\bhow\b/i, 5: /\b(something else|not covered|other|claude|ai)\b/i },
  de: { 1: /\beinzieh/i, 2: /\bbeleg\b|\bherunterlad/i, 3: /\blösch/i, 4: /\bwie\b/i, 5: /\b(etwas anderes|sonstiges|andere|claude|ai)\b/i },
  fr: { 1: /\bencaiss/i, 2: /\breçu\b|\btélécharg/i, 3: /\bsupprim/i, 4: /\bcomment\b/i, 5: /\b(autre chose|autre|claude|ai)\b/i },
  es: { 1: /\bcobrar\b/i, 2: /\brecibo\b|\bdescargar\b/i, 3: /\beliminar\b/i, 4: /\bc[oó]mo\b/i, 5: /\b(otra cosa|otro|claude|ai)\b/i },
  ar: { 1: /تحصيل/, 2: /إيصال|تنزيل/, 3: /حذف/, 4: /كيف/, 5: /آخر|claude|ai/i },
  ru: { 1: /прин[яи]/i, 2: /квитанц/i, 3: /удал/i, 4: /как/i, 5: /другое|claude|ai/i },
  pt: { 1: /\bcobrar\b/i, 2: /\brecibo\b|\bbaixar\b/i, 3: /\bexcluir\b/i, 4: /\bcomo\b/i, 5: /\b(outra coisa|outro|claude|ai)\b/i },
  zh: { 1: /收款/, 2: /收据|下载/, 3: /删除/, 4: /如何/, 5: /其他|claude|ai/i }
};

const COLLECT_TOPIC_RE = { en: /\bcollect(?:ed|ing)?\b/i, de: /\beinzieh|\beingezogen/i, fr: /\bencaiss/i, es: /\bcobrar\b|\bcobrad/i, ar: /تحصيل/, ru: /прин[яи]/i, pt: /\bcobrar\b|\bcobranç/i, zh: /收款|收取/ };

function collectMenuQuestion() {
  const t = COLLECT_MENU_TEXT[currentLang] || COLLECT_MENU_TEXT.en;
  return `${t.intro}\n${t.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`;
}

const COLLECT_MENU_RE = new RegExp(
  Object.values(COLLECT_MENU_TEXT).map(t => escapeRegExp(t.intro)).join('|'),
  'i'
);
PENDING_FLOW_MARKERS.push(COLLECT_MENU_RE);

function parseCollectFallbackMenu(msg, history) {
  const safeHistory = Array.isArray(history) ? history : [];
  const lastAssistant = [...safeHistory].reverse().find(h => h.role === 'assistant');
  const kw = COLLECT_OPTION_KEYWORDS[currentLang] || COLLECT_OPTION_KEYWORDS.en;
  const t = COLLECT_MENU_TEXT[currentLang] || COLLECT_MENU_TEXT.en;

  if (lastAssistant && COLLECT_MENU_RE.test(lastAssistant.content)) {
    const choice = msg.trim().toLowerCase();

    // Delete checked first — "delete the receipt" would otherwise also
    // match option 2's bare /receipt/ keyword below. Only options 3 and 4
    // are terminal (1 and 2 hand off into their own multi-step flows) — the
    // menu is re-appended after each terminal reply so the next pick still
    // has something to match against instead of falling through to Claude.
    if (/^3\b/.test(choice) || kw[3].test(choice)) {
      const deleteResult = handleDeleteIntent('delete payment');
      return { reply: `${deleteResult.reply}\n\n${collectMenuQuestion()}`, handled: true };
    }
    if (/^1\b/.test(choice) || kw[1].test(choice)) {
      return { reply: paymentLinkViaMenuQuestion(), handled: true };
    }
    if (/^2\b/.test(choice) || kw[2].test(choice)) {
      return { reply: downloadReceiptMobileQuestion(), handled: true };
    }
    if (/^4\b/.test(choice) || kw[4].test(choice)) {
      return { reply: `${t.howto}\n\n${collectMenuQuestion()}`, handled: true };
    }
    if (/^5\b/.test(choice) || kw[5].test(choice)) {
      return { reply: anyOtherAskText(), handled: true };
    }

    // Unrecognized reply to the menu — re-ask rather than guess.
    return { reply: collectMenuQuestion(), handled: true };
  }

  const topicRe = COLLECT_TOPIC_RE[currentLang] || COLLECT_TOPIC_RE.en;
  if (!HOW_TO_RE.test(msg) && topicRe.test(msg)) {
    return { reply: collectMenuQuestion(), handled: true };
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
// Options 1/5's reply text below stays English literal on purpose —
// ADD_SUBSCRIBER_NAME_RE/EDIT_DETAILS_NAME_MOBILE_RE match that exact
// text elsewhere and hand off into their own (not-yet-localized) flows.
// Only the menu itself, picking an option, and the terminal options
// (2/3/4/6, which loop back to this same menu) are fully localized.
const SUBSCRIBER_MENU_TEXT = {
  en: { intro: 'I\'m not quite sure what you\'d like to do with a subscriber. Please choose one:', options: ['Add subscriber', 'View subscriber details', 'Delete/remove the subscriber', 'How to add a subscriber', 'Edit subscriber details', 'Something else'], openingDetails: 'Opening Subscriber Details for you.', howto: 'Sidebar -> Subscribers -> "+ Add" -> enter a name and mobile number -> Save. Or just say "add a subscriber" and I\'ll walk you through it.' },
  de: { intro: 'Ich bin nicht ganz sicher, was Sie mit einem Abonnenten tun möchten. Bitte wählen Sie eine Option:', options: ['Abonnent hinzufügen', 'Abonnentendetails anzeigen', 'Abonnenten löschen/entfernen', 'Wie man einen Abonnenten hinzufügt', 'Abonnentendetails bearbeiten', 'Etwas anderes'], openingDetails: 'Öffne Abonnentendetails für Sie.', howto: 'Seitenleiste -> Abonnenten -> "+ Hinzufügen" -> Name und Mobilnummer eingeben -> Speichern. Oder sagen Sie einfach "Abonnent hinzufügen" und ich führe Sie durch.' },
  fr: { intro: 'Je ne suis pas sûr de ce que vous souhaitez faire avec un abonné. Veuillez choisir une option :', options: ['Ajouter un abonné', 'Voir les détails de l\'abonné', 'Supprimer/retirer l\'abonné', 'Comment ajouter un abonné', 'Modifier les détails de l\'abonné', 'Autre chose'], openingDetails: 'Ouverture des détails de l\'abonné pour vous.', howto: 'Barre latérale -> Abonnés -> "+ Ajouter" -> saisissez un nom et un numéro de mobile -> Enregistrer. Ou dites simplement "ajouter un abonné" et je vous guiderai.' },
  es: { intro: 'No estoy seguro de qué quieres hacer con un suscriptor. Elige una opción:', options: ['Agregar suscriptor', 'Ver detalles del suscriptor', 'Eliminar/quitar al suscriptor', 'Cómo agregar un suscriptor', 'Editar detalles del suscriptor', 'Otra cosa'], openingDetails: 'Abriendo los detalles del suscriptor para ti.', howto: 'Barra lateral -> Suscriptores -> "+ Agregar" -> ingresa un nombre y número de móvil -> Guardar. O simplemente di "agregar un suscriptor" y te guiaré.' },
  ar: { intro: 'لست متأكدًا تمامًا مما تريد فعله بخصوص مشترك. يرجى اختيار خيار:', options: ['إضافة مشترك', 'عرض تفاصيل المشترك', 'حذف/إزالة المشترك', 'كيفية إضافة مشترك', 'تعديل تفاصيل المشترك', 'شيء آخر'], openingDetails: 'يتم فتح تفاصيل المشترك من أجلك.', howto: 'الشريط الجانبي -> المشتركون -> "+ إضافة" -> أدخل الاسم ورقم الجوال -> حفظ. أو فقط قل "إضافة مشترك" وسأرشدك خطوة بخطوة.' },
  ru: { intro: 'Я не совсем понял, что вы хотите сделать с подписчиком. Пожалуйста, выберите вариант:', options: ['Добавить подписчика', 'Посмотреть данные подписчика', 'Удалить/убрать подписчика', 'Как добавить подписчика', 'Изменить данные подписчика', 'Другое'], openingDetails: 'Открываю данные подписчика для вас.', howto: 'Боковая панель -> Подписчики -> «+ Добавить» -> введите имя и номер мобильного -> Сохранить. Или просто скажите «добавить подписчика», и я вас проведу.' },
  pt: { intro: 'Não tenho certeza do que você gostaria de fazer com um assinante. Por favor, escolha uma opção:', options: ['Adicionar assinante', 'Ver detalhes do assinante', 'Excluir/remover o assinante', 'Como adicionar um assinante', 'Editar detalhes do assinante', 'Outra coisa'], openingDetails: 'Abrindo os detalhes do assinante para você.', howto: 'Barra lateral -> Assinantes -> "+ Adicionar" -> insira um nome e número de celular -> Salvar. Ou apenas diga "adicionar um assinante" e eu te guio.' },
  zh: { intro: '我不太确定您想对订阅者做什么。请选择一项：', options: ['添加订阅者', '查看订阅者详情', '删除/移除订阅者', '如何添加订阅者', '编辑订阅者详情', '其他'], openingDetails: '正在为您打开订阅者详情。', howto: '侧边栏 -> 订阅者 -> "+ 添加" -> 输入姓名和手机号 -> 保存。或者直接说"添加订阅者"，我会引导您完成。' }
};

const SUBSCRIBER_OPTION_KEYWORDS = {
  en: { 1: /\badd\b/i, 2: /\bview\b|\bdetails\b/i, 3: /\b(delete|remove)\b/i, 4: /\bhow\b/i, 5: /\bedit\b/i, 6: /\b(something else|not covered|other|claude|ai)\b/i },
  de: { 1: /\bhinzufüg/i, 2: /\banzeig|\bdetails\b/i, 3: /\blösch|\bentfern/i, 4: /\bwie\b/i, 5: /\bbearbeit/i, 6: /\b(etwas anderes|sonstiges|andere|claude|ai)\b/i },
  fr: { 1: /\bajout/i, 2: /\bvoir\b|\bd[ée]tails\b/i, 3: /\bsupprim|\bretir/i, 4: /\bcomment\b/i, 5: /\bmodifi/i, 6: /\b(autre chose|autre|claude|ai)\b/i },
  es: { 1: /\bagregar\b/i, 2: /\bver\b|\bdetalles\b/i, 3: /\beliminar\b|\bquitar\b/i, 4: /\bc[oó]mo\b/i, 5: /\beditar\b/i, 6: /\b(otra cosa|otro|claude|ai)\b/i },
  ar: { 1: /إضافة/, 2: /عرض|تفاصيل/, 3: /حذف|إزالة/, 4: /كيف/, 5: /تعديل/, 6: /آخر|claude|ai/i },
  ru: { 1: /добав/i, 2: /просмотр|данные/i, 3: /удал|убрать/i, 4: /как/i, 5: /изменить/i, 6: /другое|claude|ai/i },
  pt: { 1: /\badicionar\b/i, 2: /\bver\b|\bdetalhes\b/i, 3: /\bexcluir\b|\bremover\b/i, 4: /\bcomo\b/i, 5: /\beditar\b/i, 6: /\b(outra coisa|outro|claude|ai)\b/i },
  zh: { 1: /添加/, 2: /查看|详情/, 3: /删除|移除/, 4: /如何/, 5: /编辑/, 6: /其他|claude|ai/i }
};

const SUBSCRIBER_TOPIC_RE = { en: /\bsubscribers?\b/i, de: /\babonnent(en)?\b/i, fr: /\babonn[ée]s?(?!\w)/i, es: /\bsuscriptor(es)?\b/i, ar: /مشترك/, ru: /подписчик/i, pt: /\bassinante(s)?\b/i, zh: /订阅者|订阅/ };

function subscriberMenuQuestion() {
  const t = SUBSCRIBER_MENU_TEXT[currentLang] || SUBSCRIBER_MENU_TEXT.en;
  return `${t.intro}\n${t.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`;
}

const SUBSCRIBER_MENU_RE = new RegExp(
  Object.values(SUBSCRIBER_MENU_TEXT).map(t => escapeRegExp(t.intro)).join('|'),
  'i'
);
PENDING_FLOW_MARKERS.push(SUBSCRIBER_MENU_RE);

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
  const kw = SUBSCRIBER_OPTION_KEYWORDS[currentLang] || SUBSCRIBER_OPTION_KEYWORDS.en;
  const t = SUBSCRIBER_MENU_TEXT[currentLang] || SUBSCRIBER_MENU_TEXT.en;

  if (lastAssistant && SUBSCRIBER_MENU_RE.test(lastAssistant.content)) {
    const choice = msg.trim().toLowerCase();

    // Delete and edit checked first — both mention "subscriber"/"details"
    // in ways that could otherwise be caught by the plainer add/view checks.
    // Options 2-4 are terminal (1 and 5 hand off into their own multi-step
    // flows) — the menu is re-appended after each so the next pick still
    // has the menu question to match against instead of falling through
    // to Claude.
    if (/^3\b/.test(choice) || kw[3].test(choice)) {
      const deleteResult = handleDeleteIntent('delete subscriber');
      return { reply: `${deleteResult.reply}\n\n${subscriberMenuQuestion()}`, handled: true };
    }
    if (/^5\b/.test(choice) || kw[5].test(choice)) {
      return { reply: 'Great — what\'s the subscriber\'s name and mobile number, so I can look up their details?', handled: true };
    }
    if (/^1\b/.test(choice) || kw[1].test(choice)) {
      return { reply: renderFlow(ADD_SUBSCRIBER_TEXT, 'askName'), handled: true };
    }
    if (/^2\b/.test(choice) || kw[2].test(choice)) {
      return { reply: `${t.openingDetails}\n\n${subscriberMenuQuestion()}`, action: { type: 'view_subscriber_details', params: {} }, handled: true };
    }
    if (/^4\b/.test(choice) || kw[4].test(choice)) {
      return { reply: `${t.howto}\n\n${subscriberMenuQuestion()}`, handled: true };
    }
    if (/^6\b/.test(choice) || kw[6].test(choice)) {
      return { reply: anyOtherAskText(), handled: true };
    }

    // Unrecognized reply to the menu — re-ask rather than guess.
    return { reply: subscriberMenuQuestion(), handled: true };
  }

  const topicRe = SUBSCRIBER_TOPIC_RE[currentLang] || SUBSCRIBER_TOPIC_RE.en;
  if (!HOW_TO_RE.test(msg) && topicRe.test(msg)) {
    return { reply: subscriberMenuQuestion(), handled: true };
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
  { markers: [ANY_OTHER_ASK_RE], fn: parseAnyOtherLookup },
  { markers: [BARE_NUMBER_CONFIRM_RE], fn: parseBareNumberLookup }
];

function parseLocalIntent(message, history, lang) {
  currentLang = ROOT_MENU_TEXT[lang] ? lang : 'en';
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

  // Same reasoning, for a bare number ("4") typed with nothing pending —
  // confirm which root-menu section it might mean rather than escalating
  // a meaningless digit or guessing outright. See parseBareNumberLookup.
  const bareNumberResult = parseBareNumberLookup(msg, safeHistory);
  if (bareNumberResult) return bareNumberResult;

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

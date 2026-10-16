/**
 * The messages the product sends parties (P2-M32, spec §6.2): one template per
 * purpose, with named `{{variables}}` only. A business may reword a template per
 * channel and language (`message_templates`); WhatsApp wording must match what the
 * BSP approved ([PO-1]). Variables are data-minimal (spec MSG-5, after draft PR #51
 * WA-5): the party's name, the shop's name, a document number, amounts and dates.
 * `{{payLink}}` (round 4a) is a UPI payment link in the message's language
 * (`payLinkText`), or empty when there is none, so a template reads well either way.
 */

export const MESSAGE_CHANNELS = ['whatsapp', 'sms', 'email'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export const MESSAGE_LANGUAGES = ['en', 'hi', 'te'] as const;
export type MessageLanguage = (typeof MESSAGE_LANGUAGES)[number];

export const TEMPLATE_KEYS = [
  'invoice_issued',
  'receipt_issued',
  'statement_ready',
  'payment_reminder_due',
  'payment_reminder_overdue',
  'promise_confirmed',
  'order_ready',
  'points_earned',
  'payment_request',
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

/** The variables each template may use; every one is filled when a message is queued. */
export const TEMPLATE_VARIABLES: Readonly<Record<TemplateKey, readonly string[]>> = {
  invoice_issued: ['name', 'business', 'number', 'amount', 'payLink'],
  receipt_issued: ['name', 'business', 'number', 'amount'],
  statement_ready: ['name', 'business', 'from', 'to', 'amount', 'link', 'payLink'],
  payment_reminder_due: ['name', 'business', 'amount', 'dueOn', 'payLink'],
  payment_reminder_overdue: ['name', 'business', 'amount', 'days', 'payLink'],
  promise_confirmed: ['name', 'business', 'amount', 'promisedOn'],
  order_ready: ['name', 'business', 'number'],
  points_earned: ['name', 'business', 'points', 'number', 'balance'],
  payment_request: ['name', 'business', 'amount', 'payLink'],
};

/** Longest template body a business may save (the column allows 1,000). */
export const TEMPLATE_MAX_LENGTH = 1000;

type Wording = Readonly<Record<MessageLanguage, string>>;

/** The product's own wording, used when the business has not reworded a template. */
export const DEFAULT_TEMPLATES: Readonly<Record<TemplateKey, Wording>> = {
  invoice_issued: {
    en: 'Dear {{name}}, thank you for shopping at {{business}}. Invoice {{number}} for {{amount}}.{{payLink}}',
    hi: 'प्रिय {{name}}, {{business}} से खरीदारी के लिए धन्यवाद। इनवॉइस {{number}}, राशि {{amount}}।{{payLink}}',
    te: 'ప్రియమైన {{name}}, {{business}}లో కొనుగోలు చేసినందుకు ధన్యవాదాలు. ఇన్‌వాయిస్ {{number}}, మొత్తం {{amount}}.{{payLink}}',
  },
  receipt_issued: {
    en: 'Dear {{name}}, {{business}} has received {{amount}} (receipt {{number}}). Thank you.',
    hi: 'प्रिय {{name}}, {{business}} को {{amount}} मिल गए (रसीद {{number}})। धन्यवाद।',
    te: 'ప్రియమైన {{name}}, {{business}}కు {{amount}} అందింది (రసీదు {{number}}). ధన్యవాదాలు.',
  },
  statement_ready: {
    en: 'Dear {{name}}, your statement from {{business}} for {{from}} to {{to}}: balance {{amount}}. View it here: {{link}}{{payLink}}',
    hi: 'प्रिय {{name}}, {{business}} से {{from}} से {{to}} तक आपका खाता विवरण: शेष {{amount}}। यहाँ देखें: {{link}}{{payLink}}',
    te: 'ప్రియమైన {{name}}, {{business}} నుండి {{from}} నుండి {{to}} వరకు మీ ఖాతా వివరణ: నిల్వ {{amount}}. ఇక్కడ చూడండి: {{link}}{{payLink}}',
  },
  payment_reminder_due: {
    en: 'Dear {{name}}, a reminder from {{business}}: {{amount}} falls due on {{dueOn}}.{{payLink}}',
    hi: 'प्रिय {{name}}, {{business}} की ओर से याद दिलाना: {{amount}} का भुगतान {{dueOn}} को देय है।{{payLink}}',
    te: 'ప్రియమైన {{name}}, {{business}} నుండి గుర్తు: {{amount}} చెల్లింపు {{dueOn}} నాటికి చెల్లించాలి.{{payLink}}',
  },
  payment_reminder_overdue: {
    en: 'Dear {{name}}, {{amount}} owed to {{business}} is overdue by {{days}} days. Please pay at the earliest.{{payLink}}',
    hi: 'प्रिय {{name}}, {{business}} का {{amount}} बकाया {{days}} दिन से देय है। कृपया जल्द भुगतान करें।{{payLink}}',
    te: 'ప్రియమైన {{name}}, {{business}}కు చెల్లించాల్సిన {{amount}} గడువు దాటి {{days}} రోజులైంది. దయచేసి త్వరగా చెల్లించండి.{{payLink}}',
  },
  promise_confirmed: {
    en: 'Dear {{name}}, {{business}} has noted your promise to pay {{amount}} by {{promisedOn}}. Thank you.',
    hi: 'प्रिय {{name}}, {{business}} ने {{promisedOn}} तक {{amount}} चुकाने का आपका वादा दर्ज किया है। धन्यवाद।',
    te: 'ప్రియమైన {{name}}, {{promisedOn}} లోపు {{amount}} చెల్లిస్తామన్న మీ మాటను {{business}} నమోదు చేసింది. ధన్యవాదాలు.',
  },
  order_ready: {
    en: 'Dear {{name}}, your order {{number}} at {{business}} is ready.',
    hi: 'प्रिय {{name}}, {{business}} पर आपका ऑर्डर {{number}} तैयार है।',
    te: 'ప్రియమైన {{name}}, {{business}}లో మీ ఆర్డర్ {{number}} సిద్ధంగా ఉంది.',
  },
  points_earned: {
    en: 'Dear {{name}}, you earned {{points}} points on invoice {{number}} at {{business}}. Balance: {{balance}} points.',
    hi: 'प्रिय {{name}}, {{business}} के इनवॉइस {{number}} पर आपको {{points}} पॉइंट मिले। कुल: {{balance}} पॉइंट।',
    te: 'ప్రియమైన {{name}}, {{business}} ఇన్‌వాయిస్ {{number}}పై మీకు {{points}} పాయింట్లు వచ్చాయి. మొత్తం: {{balance}} పాయింట్లు.',
  },
  payment_request: {
    en: 'Dear {{name}}, {{business}} requests a payment of {{amount}}.{{payLink}}',
    hi: 'प्रिय {{name}}, {{business}} ने {{amount}} का भुगतान माँगा है।{{payLink}}',
    te: 'ప్రియమైన {{name}}, {{business}} {{amount}} చెల్లింపు కోరుతోంది.{{payLink}}',
  },
};

/** The `{{payLink}}` sentence in each language; `{url}` is the payment link. */
export const PAY_LINK_TEXTS: Readonly<Record<MessageLanguage, string>> = {
  en: ' Pay by UPI: {url}',
  hi: ' UPI से भुगतान करें: {url}',
  te: ' UPI ద్వారా చెల్లించండి: {url}',
};

/** The sentence naming what the link asks for, when it differs from the message's amount. */
export const PAY_LINK_AMOUNT_TEXTS: Readonly<Record<MessageLanguage, string>> = {
  en: ' Pay {amount} by UPI: {url}',
  hi: ' UPI से {amount} का भुगतान करें: {url}',
  te: ' UPI ద్వారా {amount} చెల్లించండి: {url}',
};

/**
 * The value of `{{payLink}}`: the sentence with the link, or empty without one. Given
 * the link's amount (a link for the bills' full outstanding beside a balance net of the
 * advance, [PO-43]), it names it, so the message's figures never disagree unexplained.
 */
export function payLinkText(
  url: string | null,
  language: MessageLanguage,
  amount: string | null = null,
): string {
  if (url === null) return '';
  return amount === null
    ? PAY_LINK_TEXTS[language].replace('{url}', url)
    : PAY_LINK_AMOUNT_TEXTS[language].replace('{amount}', amount).replace('{url}', url);
}

const VARIABLE = /\{\{\s*([A-Za-z]+)\s*\}\}/g;

/** The variables a body uses, in order of first use. */
export function variablesIn(body: string): string[] {
  return [...new Set([...body.matchAll(VARIABLE)].map((match) => String(match[1])))];
}

/** Why a body cannot be saved for a template, or an empty list when it can. */
export function templateProblems(key: TemplateKey, body: string): string[] {
  const allowed = new Set(TEMPLATE_VARIABLES[key]);
  const problems: string[] = [];
  if (body.trim() === '') problems.push('The message cannot be empty');
  if (body.length > TEMPLATE_MAX_LENGTH) {
    problems.push(`Keep the message to ${String(TEMPLATE_MAX_LENGTH)} characters`);
  }
  for (const name of variablesIn(body)) {
    if (!allowed.has(name)) problems.push(`{{${name}}} is not a variable of this message`);
  }
  return problems;
}

/** The body with every `{{variable}}` filled; an unknown variable is left as it is. */
export function renderTemplate(body: string, variables: Readonly<Record<string, string>>): string {
  return body.replace(VARIABLE, (whole, name: string) => variables[name] ?? whole);
}

/** An email's subject (its first sentence, at most 120 characters) and its text. */
export function emailParts(body: string): { subject: string; text: string } {
  const end = body.search(/[.!?।]/u);
  const first = end === -1 ? body : body.slice(0, end + 1);
  const subject = first.length > 120 ? `${first.slice(0, 117)}...` : first;
  return { subject: subject.trim(), text: body };
}

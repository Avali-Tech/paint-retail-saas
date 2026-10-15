import type { MessageChannel, MessageLanguage } from './templates.js';

/**
 * Consent to messages (P2-M32, [CA-3]; DPDP Act 2023 ss.5–7 and Meta's opt-in rule,
 * spec §6.2): a notice in the party's language, naming the business and the purpose,
 * is shown before consent is recorded; its version is kept with the record.
 */
export const CONSENT_NOTICE_VERSION = '2026-10';

export const CONSENT_METHODS = [
  'counter_with_notice',
  'signed_form',
  'web_form',
  'whatsapp_reply',
] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

/** How staff record consent: a STOP reply is recorded by the provider's webhook only. */
export const STAFF_CONSENT_METHODS = ['counter_with_notice', 'signed_form', 'web_form'] as const;

export const CONSENT_STATES = ['granted', 'withdrawn'] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];

const NOTICES: Readonly<Record<MessageLanguage, string>> = {
  en: '{business} will send you bills, receipts, statements, payment reminders and loyalty points updates on {channel} at {address}. You can stop these messages at any time by telling us or replying STOP.',
  hi: '{business} आपको {channel} पर {address} पर बिल, रसीदें, खाता विवरण, भुगतान रिमाइंडर और लॉयल्टी पॉइंट की जानकारी भेजेगा। आप कभी भी हमें बताकर या STOP लिखकर ये संदेश बंद कर सकते हैं।',
  te: '{business} మీకు {channel}లో {address}కు బిల్లులు, రసీదులు, ఖాతా వివరణలు, చెల్లింపు గుర్తులు, లాయల్టీ పాయింట్ల సమాచారం పంపుతుంది. మాకు చెప్పి లేదా STOP అని జవాబిచ్చి ఎప్పుడైనా ఈ సందేశాలు ఆపవచ్చు.',
};

const CHANNEL_NAMES: Readonly<Record<MessageLanguage, Record<MessageChannel, string>>> = {
  en: { whatsapp: 'WhatsApp', sms: 'SMS', email: 'email' },
  hi: { whatsapp: 'WhatsApp', sms: 'SMS', email: 'ईमेल' },
  te: { whatsapp: 'WhatsApp', sms: 'SMS', email: 'ఈమెయిల్' },
};

/** The notice read to (or signed by) the party before their consent is recorded. */
export function consentNotice(
  language: MessageLanguage,
  values: { business: string; channel: MessageChannel; address: string },
): string {
  return NOTICES[language]
    .replace('{business}', values.business)
    .replace('{channel}', CHANNEL_NAMES[language][values.channel])
    .replace('{address}', values.address);
}

/** The latest consent records, one per channel (newest first), decide what may be sent. */
export interface ConsentRecord {
  readonly channel: MessageChannel;
  readonly address: string;
  readonly state: ConsentState;
  readonly language: MessageLanguage;
}

/**
 * The consent that lets a message go to `address` on `channel`: the channel's
 * latest record, when it is granted and for that same address (a changed number
 * needs new consent, spec MSG-9). Null when nothing may be sent.
 */
export function consentFor(
  latest: readonly ConsentRecord[],
  channel: MessageChannel,
  address?: string,
): ConsentRecord | null {
  const record = latest.find((row) => row.channel === channel);
  if (record?.state !== 'granted') return null;
  if (address !== undefined && record.address !== address) return null;
  return record;
}

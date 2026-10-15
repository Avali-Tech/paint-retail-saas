import { describe, expect, it } from 'vitest';
import {
  CONSENT_NOTICE_VERSION,
  DEFAULT_TEMPLATES,
  MESSAGE_LANGUAGES,
  TEMPLATE_KEYS,
  TEMPLATE_VARIABLES,
  consentFor,
  consentNotice,
  emailParts,
  isPermission,
  renderTemplate,
  templateProblems,
  variablesIn,
  CONSENT_MANAGE_PERMISSION,
  MESSAGING_READ_PERMISSION,
  TEMPLATES_MANAGE_PERMISSION,
  type ConsentRecord,
} from '../index.js';

describe('the template catalogue', () => {
  it('has every template in every language, using exactly its variables', () => {
    for (const key of TEMPLATE_KEYS) {
      for (const language of MESSAGE_LANGUAGES) {
        const body = DEFAULT_TEMPLATES[key][language];
        expect(templateProblems(key, body), `${key} ${language}`).toEqual([]);
        expect([...variablesIn(body)].sort(), `${key} ${language}`).toEqual(
          [...TEMPLATE_VARIABLES[key]].sort(),
        );
      }
    }
  });

  it('refuses empty, over-long and unknown-variable wording', () => {
    expect(templateProblems('order_ready', '  ')).toEqual(['The message cannot be empty']);
    expect(templateProblems('order_ready', 'x'.repeat(1001))).toEqual([
      'Keep the message to 1000 characters',
    ]);
    expect(templateProblems('order_ready', 'Hi {{name}}, pay {{amount}} {{ gstin }}')).toEqual([
      '{{amount}} is not a variable of this message',
      '{{gstin}} is not a variable of this message',
    ]);
  });

  it('fills variables and leaves unknown ones as written', () => {
    expect(
      renderTemplate('Hi {{name}}, {{ number }} {{missing}}', { name: 'Ravi', number: 'SO-1' }),
    ).toBe('Hi Ravi, SO-1 {{missing}}');
  });

  it('takes an email subject from the first sentence', () => {
    expect(emailParts('Dear Ravi, thanks. Invoice INV-1.')).toEqual({
      subject: 'Dear Ravi, thanks.',
      text: 'Dear Ravi, thanks. Invoice INV-1.',
    });
    expect(emailParts('प्रिय रवि। राशि').subject).toBe('प्रिय रवि।');
    expect(emailParts('No full stop here').subject).toBe('No full stop here');
    expect(emailParts('y'.repeat(130)).subject).toBe(`${'y'.repeat(117)}...`);
  });

  it('uses known permissions', () => {
    for (const permission of [
      CONSENT_MANAGE_PERMISSION,
      MESSAGING_READ_PERMISSION,
      TEMPLATES_MANAGE_PERMISSION,
    ]) {
      expect(isPermission(permission)).toBe(true);
    }
  });
});

describe('consent', () => {
  it('reads the notice in the party language, naming business, channel and address', () => {
    expect(CONSENT_NOTICE_VERSION).toBe('2026-10');
    const values = {
      business: 'Rangoli Paints',
      channel: 'whatsapp' as const,
      address: '+919811100032',
    };
    expect(consentNotice('en', values)).toMatch(
      /^Rangoli Paints will send you .* on WhatsApp at \+919811100032\. .*STOP\.$/,
    );
    expect(consentNotice('hi', { ...values, channel: 'email', address: 'a@b.in' })).toContain(
      'ईमेल पर a@b.in',
    );
    expect(consentNotice('te', { ...values, channel: 'sms' })).toContain('SMSలో');
  });

  const latest: ConsentRecord[] = [
    { channel: 'whatsapp', address: '+919811100032', state: 'granted', language: 'te' },
    { channel: 'sms', address: '+919811100032', state: 'withdrawn', language: 'en' },
  ];

  it('lets a message go only with granted consent for that channel and address', () => {
    expect(consentFor(latest, 'whatsapp')?.language).toBe('te');
    expect(consentFor(latest, 'whatsapp', '+919811100032')).not.toBeNull();
    // A changed mobile number needs new consent.
    expect(consentFor(latest, 'whatsapp', '+919811100099')).toBeNull();
    expect(consentFor(latest, 'sms')).toBeNull();
    expect(consentFor(latest, 'email')).toBeNull();
  });
});

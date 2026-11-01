import { DEFAULT_TEMPLATES, TEMPLATE_KEYS, TEMPLATE_MAX_LENGTH } from '@paint/shared';
import { describe, expect, it } from 'vitest';
import { SAMPLE_PAY_URL, previewOf, sampleVariables, templateIssues } from './template-preview.js';

const SAMPLE = { name: 'Lakshmi', business: 'ABC Paints', link: 'https://example/s/1' };

describe('templateIssues', () => {
  it('accepts every product wording', () => {
    for (const key of TEMPLATE_KEYS) {
      expect(templateIssues(key, DEFAULT_TEMPLATES[key].te)).toEqual([]);
    }
  });

  it('names an empty or long wording, and variables the template does not have', () => {
    expect(templateIssues('order_ready', '  ')).toEqual([{ kind: 'empty' }]);
    expect(templateIssues('order_ready', 'x'.repeat(TEMPLATE_MAX_LENGTH + 1))).toEqual([
      { kind: 'tooLong', max: TEMPLATE_MAX_LENGTH },
    ]);
    expect(templateIssues('order_ready', 'Hi {{name}}, {{gstin}} {{ address }}')).toEqual([
      { kind: 'unknown', name: 'gstin' },
      { kind: 'unknown', name: 'address' },
    ]);
  });
});

describe('previewOf', () => {
  it('fills every variable with sample data, the pay link in the message’s language', () => {
    const variables = sampleVariables('hi', SAMPLE);
    expect(variables.payLink).toBe(` UPI से भुगतान करें: ${SAMPLE_PAY_URL}`);
    expect(previewOf(DEFAULT_TEMPLATES.order_ready.en, 'whatsapp', variables)).toEqual({
      subject: null,
      text: 'Dear Lakshmi, your order AMP/26-27/000123 at ABC Paints is ready.',
    });
  });

  it('gives an email its subject', () => {
    const preview = previewOf(
      'Dear {{name}}, statement ready. See {{link}}',
      'email',
      sampleVariables('en', SAMPLE),
    );
    expect(preview).toEqual({
      subject: 'Dear Lakshmi, statement ready.',
      text: 'Dear Lakshmi, statement ready. See https://example/s/1',
    });
  });
});

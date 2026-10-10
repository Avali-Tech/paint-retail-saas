import { describe, expect, it } from 'vitest';
import {
  QUOTATION_LABEL_KEYS,
  QUOTATION_ONLY_KEYS,
  QUOTATION_ONLY_LABELS,
  quotationLabels,
} from './quotation-labels.js';

describe('quotation labels', () => {
  it('has every quotation label in every language', () => {
    for (const labels of Object.values(QUOTATION_ONLY_LABELS)) {
      expect(Object.keys(labels).sort()).toEqual([...QUOTATION_ONLY_KEYS].sort());
      expect(Object.values(labels).every((text) => text.trim() !== '')).toBe(true);
    }
  });

  it('keeps Latin letters out of translations, so one script font draws each', () => {
    for (const language of ['hi', 'te'] as const) {
      const labels = quotationLabels(language);
      const latin = QUOTATION_LABEL_KEYS.filter((key) =>
        /[A-Za-z]/.test((labels[key].translation ?? '').replace(/\{\w+\}/g, '')),
      );
      expect(latin).toEqual([]);
    }
  });

  it('is headed "Quotation", borrowing the invoice labels it shares', () => {
    expect(quotationLabels(null).quotation).toEqual({ text: 'Quotation', translation: null });
    expect(quotationLabels('hi').quotation).toEqual({ text: 'Quotation', translation: 'कोटेशन' });
    expect(quotationLabels('te').billTo).toEqual({
      text: 'Bill to',
      translation: 'బిల్ అందుకునేవారు',
    });
    expect(quotationLabels('hi').gstin).toEqual({ text: 'GSTIN', translation: null });
    expect(QUOTATION_LABEL_KEYS).not.toContain('taxInvoice');
  });
});

import { describe, expect, it } from 'vitest';
import { INVOICE_LABEL_KEYS, INVOICE_LABELS, fillLabel, invoiceLabels } from './labels.js';

describe('invoice labels', () => {
  it('has every label in every language', () => {
    for (const labels of Object.values(INVOICE_LABELS)) {
      expect(Object.keys(labels).sort()).toEqual([...INVOICE_LABEL_KEYS].sort());
      expect(Object.values(labels).every((text) => text.trim() !== '')).toBe(true);
      expect(labels.page).toContain('{page}');
      expect(labels.page).toContain('{pages}');
    }
  });

  it('keeps Latin letters out of translations, so one script font draws each', () => {
    for (const language of ['hi', 'te'] as const) {
      const labels = invoiceLabels(language);
      const latin = INVOICE_LABEL_KEYS.filter((key) =>
        /[A-Za-z]/.test((labels[key].translation ?? '').replace(/\{\w+\}/g, '')),
      );
      expect(latin).toEqual([]);
    }
  });

  it('prints English, with the second language under it unless it reads the same', () => {
    expect(invoiceLabels(null).taxInvoice).toEqual({ text: 'Tax Invoice', translation: null });
    expect(invoiceLabels('hi').taxInvoice).toEqual({
      text: 'Tax Invoice',
      translation: 'टैक्स इनवॉइस',
    });
    expect(invoiceLabels('te').placeOfSupply).toEqual({
      text: 'Place of supply',
      translation: 'సప్లై స్థలం',
    });
    expect(invoiceLabels('te').gstin).toEqual({ text: 'GSTIN', translation: null });
  });

  it('fills placeholders and leaves unknown ones', () => {
    expect(fillLabel('Page {page} of {pages}', { page: 1, pages: 2 })).toBe('Page 1 of 2');
    expect(fillLabel('For {name}', {})).toBe('For {name}');
  });
});

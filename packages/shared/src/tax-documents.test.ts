import { describe, expect, it } from 'vitest';
import {
  defaultSeries,
  financialYear,
  formatTaxDocumentNumber,
  gstClassFor,
  isValidSeriesPrefix,
  uqcFor,
} from './tax-documents.js';

describe('financialYear', () => {
  it('starts on 1 April', () => {
    expect(financialYear('2026-04-01')).toBe('2026-27');
    expect(financialYear('2027-03-31')).toBe('2026-27');
    expect(financialYear('2026-12-31')).toBe('2026-27');
    expect(financialYear('2099-01-15')).toBe('2098-99');
  });
});

describe('document numbers', () => {
  it('formats a prefix, the financial year and a zero-padded serial in 16 characters', () => {
    const number = formatTaxDocumentNumber('AMP', '2026-27', 123, 6);
    expect(number).toBe('AMP/26-27/000123');
    expect(number).toHaveLength(16);
  });

  it('refuses a serial that does not fit its digits, or is not a positive integer', () => {
    expect(() => formatTaxDocumentNumber('AMP', '2026-27', 1_000, 3)).toThrow(RangeError);
    expect(() => formatTaxDocumentNumber('AMP', '2026-27', 0, 3)).toThrow(RangeError);
    expect(() => formatTaxDocumentNumber('AMP', '2026-27', 1.5, 3)).toThrow(RangeError);
  });

  it('accepts only A–Z 0–9 prefixes that keep the number within 16 characters', () => {
    expect(isValidSeriesPrefix('AMP', 6)).toBe(true);
    expect(isValidSeriesPrefix('AMPB', 5)).toBe(true);
    expect(isValidSeriesPrefix('AMPB', 6)).toBe(false);
    expect(isValidSeriesPrefix('amp', 3)).toBe(false);
    expect(isValidSeriesPrefix('AM-P', 3)).toBe(false);
    expect(isValidSeriesPrefix('AMP', 0)).toBe(false);
    expect(isValidSeriesPrefix('AMP', 2.5)).toBe(false);
  });

  it("defaults to the store's code and a letter per kind", () => {
    expect(defaultSeries('amp', 'invoice')).toEqual({ prefix: 'AMP', digits: 6 });
    expect(defaultSeries('AMP', 'bill_of_supply')).toEqual({ prefix: 'AMPB', digits: 5 });
    expect(defaultSeries('HYD-1', 'credit_note')).toEqual({ prefix: 'HYD1C', digits: 4 });
    expect(defaultSeries('AB', 'debit_note')?.prefix).toBe('ABD');
    expect(defaultSeries('AB', 'receipt_voucher')?.prefix).toBe('ABA');
    expect(defaultSeries('AB', 'refund_voucher')?.prefix).toBe('ABR');
    // Too long a code leaves fewer than 3 digits: a series must be set up by hand.
    expect(defaultSeries('KUKATPALLY', 'invoice')).toBeNull();
    expect(defaultSeries('---', 'invoice')).toBeNull();
  });
});

describe('gstClassFor', () => {
  it('is B2B with a GSTIN, B2C large only inter-state above ₹1 lakh', () => {
    expect(gstClassFor('36AABCS1429B1Z5', false, 1)).toBe('b2b');
    expect(gstClassFor(null, true, 1_00_000_01)).toBe('b2cl');
    expect(gstClassFor(null, true, 1_00_000_00)).toBe('b2cs');
    expect(gstClassFor(null, false, 5_00_000_00)).toBe('b2cs');
  });
});

describe('uqcFor', () => {
  it('maps units of measure to GSTN quantity codes', () => {
    expect(['ml', 'l', 'g', 'kg', 'piece', 'set', 'm'].map(uqcFor)).toEqual([
      'MLT',
      'LTR',
      'GMS',
      'KGS',
      'PCS',
      'SET',
      'MTR',
    ]);
    expect(uqcFor('barrel')).toBe('OTH');
  });
});

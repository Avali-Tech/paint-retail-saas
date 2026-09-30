import { describe, expect, it } from 'vitest';
import {
  GST_RATES_PERCENT,
  basisPointsToPercent,
  isValidBarcode,
  isValidGtin,
  isValidHsn,
  percentToBasisPoints,
} from './index.js';

describe('GST rates', () => {
  it('includes the 18% slab used for paints', () => {
    expect(GST_RATES_PERCENT).toContain(18);
  });

  it('converts between percent and basis points without drift', () => {
    for (const percent of GST_RATES_PERCENT) {
      expect(basisPointsToPercent(percentToBasisPoints(percent))).toBe(percent);
    }
    expect(percentToBasisPoints(18)).toBe(1800);
    expect(percentToBasisPoints(0.1 + 0.2)).toBe(30);
  });
});

describe('isValidHsn', () => {
  it.each(['3209', '320910', '32091090'])('accepts %s', (hsn) => {
    expect(isValidHsn(hsn)).toBe(true);
  });

  it.each(['', '320', '32091', '3209109', '320910900', '32A9'])('rejects %s', (hsn) => {
    expect(isValidHsn(hsn)).toBe(false);
  });
});

describe('isValidGtin', () => {
  // Published example codes with correct check digits.
  it.each(['96385074', '036000291452', '4006381333931', '10614141000415'])('accepts %s', (code) => {
    expect(isValidGtin(code)).toBe(true);
  });

  it.each(['96385075', '036000291453', '4006381333932', '1234567', '12345678901', 'ABCDEFGH'])(
    'rejects %s',
    (code) => {
      expect(isValidGtin(code)).toBe(false);
    },
  );
});

describe('isValidBarcode', () => {
  it('accepts valid EAN/UPC codes and internal codes', () => {
    expect(isValidBarcode('4006381333931')).toBe(true);
    expect(isValidBarcode('AP-ULT-20L')).toBe(true);
    expect(isValidBarcode('12345')).toBe(true);
  });

  it('rejects EAN-shaped numbers with a wrong check digit', () => {
    expect(isValidBarcode('4006381333932')).toBe(false);
  });

  it.each(['', 'abc', 'has space', 'x'.repeat(49), 'ÄPFEL-12'])('rejects "%s"', (code) => {
    expect(isValidBarcode(code)).toBe(false);
  });
});

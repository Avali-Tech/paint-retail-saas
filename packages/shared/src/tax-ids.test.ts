import { describe, expect, it } from 'vitest';
import {
  gstinCheckCharacter,
  isValidGstin,
  isValidPan,
  isValidPincode,
  panFromGstin,
} from './index.js';

// Real, published sample GSTINs.
const VALID = ['27AAPFU0939F1ZV', '29AAGCB7383J1Z4'];

describe('isValidGstin', () => {
  it.each(VALID)('accepts %s', (gstin) => {
    expect(isValidGstin(gstin)).toBe(true);
  });

  it('computes the published check character', () => {
    expect(gstinCheckCharacter('27AAPFU0939F1Z')).toBe('V');
    expect(gstinCheckCharacter('29AAGCB7383J1Z')).toBe('4');
  });

  it('catches a single mistyped character through the checksum', () => {
    expect(isValidGstin('27AAPFU0939F1ZW')).toBe(false);
    expect(isValidGstin('27AAPFU0938F1ZV')).toBe(false);
  });

  it.each([
    '',
    '27aapfu0939f1zv',
    '27AAPFU0939F1V',
    '27AAPFU0939F1ZVV',
    'A7AAPFU0939F1ZV',
    '27AAPFU0939F0ZV',
    '27AAPFU0939F1XV',
  ])('rejects the malformed %s', (gstin) => {
    expect(isValidGstin(gstin)).toBe(false);
  });
});

describe('panFromGstin', () => {
  it('extracts the PAN inside a GSTIN', () => {
    expect(panFromGstin('27AAPFU0939F1ZV')).toBe('AAPFU0939F');
  });
});

describe('isValidPan', () => {
  it('accepts a well-formed PAN', () => {
    expect(isValidPan('AAPFU0939F')).toBe(true);
  });

  it.each(['', 'aapfu0939f', 'AAPF0939F', 'AAPFU09399', 'AAPFU0939FF'])('rejects %s', (pan) => {
    expect(isValidPan(pan)).toBe(false);
  });
});

describe('isValidPincode', () => {
  it.each(['500081', '411001', '110001'])('accepts %s', (pin) => {
    expect(isValidPincode(pin)).toBe(true);
  });

  it.each(['', '050081', '50008', '5000811', '50008A'])('rejects %s', (pin) => {
    expect(isValidPincode(pin)).toBe(false);
  });
});

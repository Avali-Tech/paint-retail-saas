import { describe, expect, it } from 'vitest';
import { normalizeEmail, normalizePhone } from './index.js';

describe('normalizePhone', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['98765 43210', '+919876543210'],
    ['098765-43210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['+14155552671', '+14155552671'],
    ['(+44) 20 7946 0958', '+442079460958'],
  ])('normalises "%s" to %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(['', '12345', '5876543210', '98765432101', 'call me', '+0123456789', '+1234'])(
    'rejects "%s"',
    (input) => {
      expect(normalizePhone(input)).toBeNull();
    },
  );
});

describe('normalizeEmail', () => {
  it.each([
    ['asha@abc.in', 'asha@abc.in'],
    ['  Asha@ABC.in ', 'asha@abc.in'],
  ])('normalises "%s" to %s', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });

  it.each(['', 'asha', 'asha@', '@abc.in', 'asha@abc', 'a sha@abc.in'])('rejects "%s"', (input) => {
    expect(normalizeEmail(input)).toBeNull();
  });
});

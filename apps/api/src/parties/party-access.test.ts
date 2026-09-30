import { describe, expect, it } from 'vitest';
import { sampleAuth } from '../test-support/sample-auth.js';
import { canSeeParty, containsPattern, phoneSearchDigits } from './party-access.js';

describe('canSeeParty', () => {
  it('shows business-wide parties to everyone', () => {
    expect(canSeeParty(sampleAuth, { homeStoreId: null })).toBe(true);
  });

  it('shows store parties only to members of that store', () => {
    expect(canSeeParty(sampleAuth, { homeStoreId: 'store-a' })).toBe(true);
    expect(canSeeParty(sampleAuth, { homeStoreId: 'store-z' })).toBe(false);
  });

  it('shows every party to all-store members', () => {
    expect(canSeeParty({ ...sampleAuth, allStores: true }, { homeStoreId: 'store-z' })).toBe(true);
  });
});

describe('containsPattern', () => {
  it('wraps text for a contains match', () => {
    expect(containsPattern('raj')).toBe('%raj%');
  });

  it('escapes LIKE wildcards so they match literally', () => {
    expect(containsPattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});

describe('phoneSearchDigits', () => {
  it.each([
    ['98480', '98480'],
    ['+91 98480 12345', '919848012345'],
    ['(040) 2345', '0402345'],
  ])('treats "%s" as a phone search for %s', (text, digits) => {
    expect(phoneSearchDigits(text)).toBe(digits);
  });

  it.each(['raj', 'Raj 98', '12', 'AAPFU0939F'])('treats "%s" as a name search', (text) => {
    expect(phoneSearchDigits(text)).toBeNull();
  });
});

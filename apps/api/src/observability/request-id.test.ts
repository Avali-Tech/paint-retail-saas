import { describe, expect, it } from 'vitest';
import { generateRequestId, requestIdFor } from './request-id.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('requestIdFor', () => {
  it("keeps a caller's well-formed id", () => {
    expect(requestIdFor('Root-1a2b3c4d_e5')).toBe('Root-1a2b3c4d_e5');
  });

  it.each([
    ['missing', undefined],
    ['too short', 'abc'],
    ['unsafe characters', 'abcdefgh\nX-Injected: 1'],
    ['repeated', ['abcdefgh1', 'abcdefgh2']],
  ])('makes a new UUID when the header is %s', (_, header) => {
    expect(requestIdFor(header)).toMatch(UUID);
  });
});

describe('generateRequestId', () => {
  it('reads X-Request-Id', () => {
    expect(generateRequestId({ headers: { 'x-request-id': 'abcdefgh-1' } })).toBe('abcdefgh-1');
    expect(generateRequestId({ headers: {} })).toMatch(UUID);
  });
});

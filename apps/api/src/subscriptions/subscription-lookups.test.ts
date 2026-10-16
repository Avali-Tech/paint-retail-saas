import { describe, expect, it } from 'vitest';
import { planRefusal } from './subscription-lookups.js';

describe('planRefusal', () => {
  it('names each limit the business is over', () => {
    expect(
      planRefusal('starter', [
        { what: 'stores', used: 3, limit: 1 },
        { what: 'members', used: 13, limit: 5 },
      ]),
    ).toBe(
      'The Starter plan allows 1 active store and you have 3; it allows 5 active team members and you have 13. Close stores or deactivate team members first.',
    );
  });
});

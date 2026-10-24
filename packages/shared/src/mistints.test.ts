import { describe, expect, it } from 'vitest';
import { mistintLoss } from './mistints.js';

describe('mistintLoss', () => {
  it('is the cost less what it sold for, or all of it written off', () => {
    expect(mistintLoss('sold', 800_000, 500_000)).toBe(300_000);
    expect(mistintLoss('sold', 800_000, 900_000)).toBe(-100_000);
    expect(mistintLoss('written_off', 800_000, null)).toBe(800_000);
  });

  it('is not known while it waits or without a cost', () => {
    expect(mistintLoss('available', 800_000, null)).toBeNull();
    expect(mistintLoss('written_off', null, null)).toBeNull();
  });
});

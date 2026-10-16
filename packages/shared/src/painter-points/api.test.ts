import { describe, expect, it } from 'vitest';
import { ruleInForce, toEarnRule } from './api.js';

describe('toEarnRule', () => {
  const stored = {
    id: 'r',
    points: 2,
    perPaise: 10_000,
    perMillilitres: null,
    brandId: null,
    multiplierBps: 10_000,
  };

  it('reads the divisor of the rule’s basis', () => {
    expect(toEarnRule({ ...stored, basis: 'value' })).toEqual({
      id: 'r',
      basis: 'value',
      points: 2,
      per: 10_000,
      brandId: null,
      multiplierBps: 10_000,
    });
    expect(
      toEarnRule({ ...stored, basis: 'litre', perPaise: null, perMillilitres: 1000 }).per,
    ).toBe(1000);
  });
});

describe('ruleInForce', () => {
  const open = { isActive: true, validFrom: null, validUntil: null };

  it('applies an active rule within its dates, ends included', () => {
    expect(ruleInForce(open, '2026-10-16')).toBe(true);
    const october = { ...open, validFrom: '2026-10-01', validUntil: '2026-10-31' };
    expect(ruleInForce(october, '2026-10-01')).toBe(true);
    expect(ruleInForce(october, '2026-10-31')).toBe(true);
    expect(ruleInForce(october, '2026-09-30')).toBe(false);
    expect(ruleInForce(october, '2026-11-01')).toBe(false);
  });

  it('never applies a switched-off rule', () => {
    expect(ruleInForce({ ...open, isActive: false }, '2026-10-16')).toBe(false);
  });
});

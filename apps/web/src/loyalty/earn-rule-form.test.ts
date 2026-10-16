import type { EarnRuleView } from '@paint/shared';
import { describe, expect, it } from 'vitest';
import {
  NEW_RULE,
  earnRuleValues,
  parseLitres,
  parseMultiplier,
  readEarnRule,
  type EarnRuleValues,
} from './earn-rule-form.js';

const values = (overrides: Partial<EarnRuleValues> = {}): EarnRuleValues => ({
  ...NEW_RULE,
  name: 'Every brand',
  ...overrides,
});

describe('readEarnRule', () => {
  it('reads a value rule in rupees', () => {
    expect(readEarnRule(values({ name: '  Every brand ', brandId: 'b1', per: '1,000' }))).toEqual({
      input: {
        name: 'Every brand',
        basis: 'value',
        points: 1,
        perPaise: 100_000,
        perMillilitres: null,
        brandId: 'b1',
        multiplierBps: 10_000,
        validFrom: null,
        validUntil: null,
        isActive: true,
      },
    });
  });

  it('reads a litre rule with dates and a multiplier', () => {
    expect(
      readEarnRule(
        values({
          basis: 'litre',
          per: '0.5',
          points: '3',
          multiplier: '1.5',
          validFrom: '2026-10-01',
          validUntil: '2026-10-31',
          isActive: false,
        }),
      ),
    ).toEqual({
      input: expect.objectContaining({
        basis: 'litre',
        points: 3,
        perPaise: null,
        perMillilitres: 500,
        brandId: null,
        multiplierBps: 15_000,
        validFrom: '2026-10-01',
        validUntil: '2026-10-31',
        isActive: false,
      }),
    });
  });

  it('names the first problem', () => {
    expect(readEarnRule(values({ name: ' ' }))).toEqual({ problem: 'earnRules.invalid.name' });
    expect(readEarnRule(values({ name: 'x'.repeat(101) }))).toEqual({
      problem: 'earnRules.invalid.name',
    });
    for (const points of ['0', '1.5', 'a', '1001']) {
      expect(readEarnRule(values({ points }))).toEqual({ problem: 'earnRules.invalid.points' });
    }
    for (const per of ['', '0.5', 'abc', '100001']) {
      expect(readEarnRule(values({ per }))).toEqual({ problem: 'earnRules.invalid.perRupees' });
    }
    expect(readEarnRule(values({ basis: 'litre', per: '0.05' }))).toEqual({
      problem: 'earnRules.invalid.perLitres',
    });
    expect(readEarnRule(values({ multiplier: '0' }))).toEqual({
      problem: 'earnRules.invalid.multiplier',
    });
    expect(readEarnRule(values({ validFrom: '2026-10-31', validUntil: '2026-10-01' }))).toEqual({
      problem: 'earnRules.invalid.dates',
    });
  });
});

describe('parseMultiplier and parseLitres', () => {
  it('keep to their ranges', () => {
    expect(parseMultiplier(' 2 ')).toBe(20_000);
    expect(parseMultiplier('0.1')).toBe(1_000);
    expect(parseMultiplier('10')).toBe(100_000);
    expect(parseMultiplier('10.5')).toBeNull();
    expect(parseMultiplier('x')).toBeNull();
    expect(parseLitres('1')).toBe(1000);
    expect(parseLitres('1000')).toBe(1_000_000);
    expect(parseLitres('1000.001')).toBeNull();
    expect(parseLitres('-1')).toBeNull();
  });
});

describe('earnRuleValues', () => {
  const stored: EarnRuleView = {
    id: 'r',
    name: 'Asian double',
    basis: 'value',
    points: 2,
    perPaise: 10_000,
    perMillilitres: null,
    brand: { id: 'b1', name: 'Asian Paints' },
    multiplierBps: 20_000,
    validFrom: '2026-10-01',
    validUntil: null,
    isActive: true,
    updatedAt: '2026-10-16T00:00:00.000Z',
  };

  it('turns a stored rule back into fields that read the same', () => {
    expect(earnRuleValues(stored)).toEqual({
      name: 'Asian double',
      basis: 'value',
      points: '2',
      per: '100',
      brandId: 'b1',
      multiplier: '2',
      validFrom: '2026-10-01',
      validUntil: '',
      isActive: true,
    });
    const litres = earnRuleValues({
      ...stored,
      basis: 'litre',
      perPaise: null,
      perMillilitres: 4000,
      brand: null,
      validFrom: null,
      validUntil: '2026-12-31',
    });
    expect(litres).toMatchObject({
      per: '4',
      brandId: '',
      validFrom: '',
      validUntil: '2026-12-31',
    });
    expect(readEarnRule(litres)).toEqual({
      input: expect.objectContaining({ perMillilitres: 4000, brandId: null }),
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CREDIT_RULES,
  checkCredit,
  type CreditPosition,
  type CreditRules,
} from './index.js';

/** Raj Contractors from the spec: ₹30,000 limit, 30 days. */
const raj: CreditPosition = {
  status: 'active',
  limitPaise: 30_000_00,
  exposurePaise: 0,
  overdueDays: 0,
};
const at = (exposurePaise: number, overdueDays = 0) => ({ ...raj, exposurePaise, overdueDays });

describe('checkCredit with the default rules', () => {
  it('sells normally up to 80 % of the limit, including exactly 80 %', () => {
    expect(checkCredit(DEFAULT_CREDIT_RULES, at(0))).toEqual({
      decision: 'allowed',
      blockedBecause: null,
      projectedExposurePaise: 0,
      availablePaise: 30_000_00,
      utilizationPercent: 0,
    });
    expect(checkCredit(DEFAULT_CREDIT_RULES, at(18_000_00), 6_000_00)).toMatchObject({
      decision: 'allowed',
      projectedExposurePaise: 24_000_00,
      utilizationPercent: 80,
    });
  });

  it('needs a manager above 80 % up to and including 100 %', () => {
    expect(checkCredit(DEFAULT_CREDIT_RULES, at(24_000_00), 1).decision).toBe('manager_approval');
    expect(checkCredit(DEFAULT_CREDIT_RULES, at(30_000_00))).toMatchObject({
      decision: 'manager_approval',
      availablePaise: 0,
      utilizationPercent: 100,
    });
  });

  it('needs the owner above 100 % — the spec’s ₹18,000 owed plus a ₹15,000 order', () => {
    expect(checkCredit(DEFAULT_CREDIT_RULES, at(18_000_00), 15_000_00)).toEqual({
      decision: 'owner_approval',
      blockedBecause: null,
      projectedExposurePaise: 33_000_00,
      availablePaise: -3_000_00,
      utilizationPercent: 110,
    });
    expect(checkCredit(DEFAULT_CREDIT_RULES, at(30_000_00), 1).decision).toBe('owner_approval');
  });

  it('decides correctly for every exposure from nothing to twice the limit', () => {
    // A limit that does not divide evenly, to catch rounding at the boundaries.
    const position = { ...raj, limitPaise: 33_333 };
    for (let exposure = 0; exposure <= 66_666; exposure += 1) {
      const expected =
        exposure * 100 <= 33_333 * 80
          ? 'allowed'
          : exposure * 100 <= 33_333 * 100
            ? 'manager_approval'
            : 'owner_approval';
      const { decision } = checkCredit(DEFAULT_CREDIT_RULES, {
        ...position,
        exposurePaise: exposure,
      });
      if (decision !== expected) throw new Error(`${String(exposure)}: ${decision}`);
    }
    expect(checkCredit(DEFAULT_CREDIT_RULES, { ...position, exposurePaise: 26_666 }).decision).toBe(
      'allowed',
    );
    expect(checkCredit(DEFAULT_CREDIT_RULES, { ...position, exposurePaise: 26_667 }).decision).toBe(
      'manager_approval',
    );
  });

  it('stays exact for limits too large for floating-point products', () => {
    const big = { ...raj, limitPaise: 9_000_000_000_000_00, exposurePaise: 7_200_000_000_000_00 };

    expect(checkCredit(DEFAULT_CREDIT_RULES, big).decision).toBe('allowed');
    expect(checkCredit(DEFAULT_CREDIT_RULES, big, 1).decision).toBe('manager_approval');
  });

  it('counts a return (negative amount) against what is owed', () => {
    expect(checkCredit(DEFAULT_CREDIT_RULES, at(31_000_00), -2_000_00)).toMatchObject({
      decision: 'manager_approval',
      projectedExposurePaise: 29_000_00,
    });
  });
});

describe('checkCredit blocks', () => {
  it('parties without credit, with no utilisation to show', () => {
    expect(
      checkCredit(DEFAULT_CREDIT_RULES, { ...raj, status: 'none', limitPaise: 0 }, 100),
    ).toEqual({
      decision: 'blocked',
      blockedBecause: 'no_credit',
      projectedExposurePaise: 100,
      availablePaise: -100,
      utilizationPercent: null,
    });
  });

  it('accounts on hold, whatever they owe', () => {
    expect(checkCredit(DEFAULT_CREDIT_RULES, { ...raj, status: 'on_hold' })).toMatchObject({
      decision: 'blocked',
      blockedBecause: 'on_hold',
    });
  });

  it('accounts overdue beyond the threshold, but not at it', () => {
    expect(checkCredit(DEFAULT_CREDIT_RULES, at(0, 30)).decision).toBe('allowed');
    expect(checkCredit(DEFAULT_CREDIT_RULES, at(0, 31))).toMatchObject({
      decision: 'blocked',
      blockedBecause: 'overdue',
    });
  });
});

describe('checkCredit with configured rules', () => {
  const strict: CreditRules = {
    normalUpToPercent: 50,
    managerUpToPercent: 75,
    holdAfterOverdueDays: 7,
  };

  it('uses the business’s own thresholds', () => {
    expect(checkCredit(strict, at(15_000_00)).decision).toBe('allowed');
    expect(checkCredit(strict, at(15_000_01)).decision).toBe('manager_approval');
    expect(checkCredit(strict, at(22_500_01)).decision).toBe('owner_approval');
    expect(checkCredit(strict, at(0, 8)).blockedBecause).toBe('overdue');
  });

  it('can send everything to the owner, or allow going over the limit', () => {
    const ownerOnly = { normalUpToPercent: 0, managerUpToPercent: 0, holdAfterOverdueDays: 30 };
    const generous = { normalUpToPercent: 120, managerUpToPercent: 150, holdAfterOverdueDays: 30 };

    expect(checkCredit(ownerOnly, at(0)).decision).toBe('allowed');
    expect(checkCredit(ownerOnly, at(1)).decision).toBe('owner_approval');
    expect(checkCredit(generous, at(36_000_00)).decision).toBe('allowed');
    expect(checkCredit(generous, at(45_000_00)).decision).toBe('manager_approval');
  });

  it('refuses amounts that are not whole paise', () => {
    expect(() => checkCredit(DEFAULT_CREDIT_RULES, raj, 1.5)).toThrow(RangeError);
  });
});

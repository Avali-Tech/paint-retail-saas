import { describe, expect, it } from 'vitest';
import { FEATURE_FLAG_KEYS, PAID_PLAN_KEYS, PLAN_KEYS, PLANS, resolveFeatures } from './plans.js';

describe('plans', () => {
  it('lists the free trial, then paid plans with growing limits', () => {
    expect(PLAN_KEYS).toEqual(['trial', 'starter', 'standard', 'enterprise']);
    expect(PAID_PLAN_KEYS).toEqual(['starter', 'standard', 'enterprise']);
    expect(PLANS.starter.maxStores).toBeLessThan(PLANS.standard.maxStores);
    expect(PLANS.trial.maxStores).toBeLessThan(PLANS.standard.maxStores);
    expect(PLANS.enterprise).toMatchObject({ maxStores: null, maxMembers: null });
  });

  it('prices every paid plan per store in whole rupees, annual at ten months', () => {
    expect(PLANS.trial.prices).toBeNull();
    for (const key of PAID_PLAN_KEYS) {
      const { monthly, annual } = PLANS[key].prices;
      expect(monthly % 100).toBe(0);
      expect(annual).toBe(monthly * 10);
    }
  });
});

describe('resolveFeatures', () => {
  it('starts from the plan’s features', () => {
    expect(resolveFeatures('trial', {})).toEqual(
      Object.fromEntries(FEATURE_FLAG_KEYS.map((flag) => [flag, false])),
    );
    expect(resolveFeatures('standard', {}).advanced_reports).toBe(true);
    expect(Object.values(resolveFeatures('enterprise', {})).every(Boolean)).toBe(true);
  });

  it('lets the platform turn single features on or off for a business', () => {
    const features = resolveFeatures('standard', { loyalty: true, advanced_reports: false });

    expect(features).toMatchObject({
      loyalty: true,
      advanced_reports: false,
      credit_control: false,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { FEATURE_FLAG_KEYS, PLAN_KEYS, PLANS, resolveFeatures } from './plans.js';

describe('plans', () => {
  it('lists trial, standard and enterprise, with growing limits', () => {
    expect(PLAN_KEYS).toEqual(['trial', 'standard', 'enterprise']);
    expect(PLANS.trial.maxStores).toBeLessThan(PLANS.standard.maxStores);
    expect(PLANS.enterprise).toMatchObject({ maxStores: null, maxMembers: null });
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

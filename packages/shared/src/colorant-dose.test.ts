import { describe, expect, it } from 'vitest';
import { colorantDose, isLooseColorantPack } from './colorant-dose.js';

const BY_ML = { unit: 'ml', densityGPerMl: 1.6 } as const;
const BY_G = { unit: 'g', densityGPerMl: 1.25 } as const;
const UNITS = { shotMl: 0.616, yMl: 0.308 };
const UNSET = { shotMl: null, yMl: null };

describe('colorantDose', () => {
  it('takes a dose in the colorant’s own unit as it is', () => {
    expect(colorantDose(12.5, 'ml', BY_ML, UNSET)).toEqual({ ok: true, quantity: 12.5 });
    expect(colorantDose(3, 'g', BY_G, UNSET)).toEqual({ ok: true, quantity: 3 });
  });

  it('turns ml into g and g into ml through the density', () => {
    expect(colorantDose(10, 'ml', BY_G, UNSET)).toEqual({ ok: true, quantity: 12.5 });
    expect(colorantDose(8, 'g', BY_ML, UNSET)).toEqual({ ok: true, quantity: 5 });
  });

  it('turns shots and Y into ml with the machine setting, then into g if stocked by weight', () => {
    expect(colorantDose(4, 'shot', BY_ML, UNITS)).toEqual({ ok: true, quantity: 2.464 });
    expect(colorantDose(10, 'y', BY_ML, UNITS)).toEqual({ ok: true, quantity: 3.08 });
    // 10 Y = 3.08 ml; × 1.25 g/ml.
    expect(colorantDose(10, 'y', BY_G, UNITS)).toEqual({ ok: true, quantity: 3.85 });
  });

  it('says what is missing when it cannot work the dose out', () => {
    expect(colorantDose(1, 'shot', BY_ML, UNSET)).toEqual({ ok: false, gap: 'shot_not_set' });
    expect(colorantDose(1, 'y', BY_ML, UNSET)).toEqual({ ok: false, gap: 'y_not_set' });
    const noDensity = { unit: 'ml', densityGPerMl: null } as const;
    expect(colorantDose(1, 'g', noDensity, UNSET)).toEqual({ ok: false, gap: 'density_not_set' });
    expect(colorantDose(1, 'ml', { unit: 'g', densityGPerMl: null }, UNSET)).toEqual({
      ok: false,
      gap: 'density_not_set',
    });
  });

  it('keeps 3 decimals, as stock does', () => {
    expect(colorantDose(1, 'shot', BY_ML, { shotMl: 0.6164, yMl: null })).toEqual({
      ok: true,
      quantity: 0.616,
    });
  });
});

describe('isLooseColorantPack', () => {
  it('accepts one ml or one g, nothing else', () => {
    expect(isLooseColorantPack({ packSize: 1, unit: 'ml' })).toBe(true);
    expect(isLooseColorantPack({ packSize: 1, unit: 'g' })).toBe(true);
    expect(isLooseColorantPack({ packSize: 1, unit: 'l' })).toBe(false);
    expect(isLooseColorantPack({ packSize: 1000, unit: 'ml' })).toBe(false);
  });
});

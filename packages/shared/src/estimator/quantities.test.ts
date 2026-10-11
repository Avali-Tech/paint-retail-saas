import { describe, expect, it } from 'vitest';
import { surfaceNetAreaSqft } from '../paint-api.js';
import {
  paintMillilitres,
  primerMillilitres,
  puttyGrams,
  type EstimatorSurface,
} from './quantities.js';

const surface = (overrides: Partial<EstimatorSurface> = {}): EstimatorSurface => ({
  netAreaSqft: 100,
  coats: null,
  condition: 'repaint',
  primer: false,
  putty: false,
  ...overrides,
});

const APEX = { coverageSqftPerLitre: 120, defaultCoats: 2 };

describe('paintMillilitres', () => {
  it('matches the spec example: 1,350 sq ft, 2 coats, 120 sq ft/L, 5 % → 23.625 L', () => {
    expect(paintMillilitres([surface({ netAreaSqft: 1350 })], APEX)).toBe(23_625);
  });

  it('takes doors and windows off through the net area', () => {
    const net = surfaceNetAreaSqft({ lengthFt: 52, heightFt: 10, openingsSqft: 21 + 16 });
    expect(net).toBe(483);
    expect(paintMillilitres([surface({ netAreaSqft: net, coats: 1 })], APEX, 0)).toBe(4_025);
  });

  it("uses each surface's coats, else the product's default, else two", () => {
    const surfaces = [surface({ coats: 3 }), surface()];
    expect(paintMillilitres(surfaces, { coverageSqftPerLitre: 100, defaultCoats: 1 }, 0)).toBe(
      4_000,
    );
    expect(paintMillilitres(surfaces, { coverageSqftPerLitre: 100, defaultCoats: null }, 0)).toBe(
      5_000,
    );
  });

  it('rounds any part of a millilitre up', () => {
    expect(
      paintMillilitres(
        [surface({ coats: 1 })],
        { coverageSqftPerLitre: 115.5, defaultCoats: null },
        0,
      ),
    ).toBe(866);
  });

  it('needs nothing for no surfaces', () => {
    expect(paintMillilitres([], APEX)).toBe(0);
  });

  it('refuses bad coverage, coats, areas and wastage', () => {
    expect(() => paintMillilitres([], { coverageSqftPerLitre: 0, defaultCoats: null })).toThrow(
      'Coverage must be more than zero',
    );
    expect(() =>
      paintMillilitres([], { coverageSqftPerLitre: Number.NaN, defaultCoats: null }),
    ).toThrow('Coverage must be more than zero');
    expect(() => paintMillilitres([surface({ coats: 6 })], APEX)).toThrow(
      'Coats must be a whole number from 1 to 5',
    );
    expect(() => paintMillilitres([surface({ coats: 1.5 })], APEX)).toThrow(
      'Coats must be a whole number from 1 to 5',
    );
    expect(() => paintMillilitres([surface({ netAreaSqft: -1 })], APEX)).toThrow(
      'A surface area must be zero or more',
    );
    expect(() => paintMillilitres([surface({ netAreaSqft: Infinity })], APEX)).toThrow(
      'A surface area must be zero or more',
    );
    expect(() => paintMillilitres([], APEX, -1)).toThrow('Wastage must be 0 to 50 %');
    expect(() => paintMillilitres([], APEX, 5_001)).toThrow('Wastage must be 0 to 50 %');
    expect(() => paintMillilitres([], APEX, 2.5)).toThrow('Wastage must be 0 to 50 %');
  });
});

describe('primerMillilitres', () => {
  it('is one coat on the surfaces that take primer', () => {
    expect(
      primerMillilitres([surface({ primer: true, coats: 3 }), surface({ netAreaSqft: 500 })], 100),
    ).toBe(1_050);
  });
});

describe('puttyGrams', () => {
  it('is grams per sq ft by condition, with wastage, on the surfaces that take putty', () => {
    expect(
      puttyGrams(
        [
          surface({ putty: true, condition: 'new' }),
          surface({ putty: true, condition: 'damaged', netAreaSqft: 10.5 }),
          surface({ putty: true, condition: 'repaint' }),
          surface({ netAreaSqft: 900 }),
        ],
        0,
      ),
    ).toBe(7_000 + 1_050 + 4_000);
    expect(puttyGrams([surface({ putty: true, condition: 'new' })])).toBe(7_350);
  });
});

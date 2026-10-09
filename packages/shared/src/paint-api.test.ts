import { describe, expect, it } from 'vitest';
import {
  ESTIMATES_PERMISSION,
  FALLBACK_COATS,
  PERMISSIONS,
  SHADE_CODE_MAX_LENGTH,
  TINT_LINE_KINDS,
  TINT_PERMISSION,
  TINT_READ_PERMISSION,
  coatsFor,
  coverageSqftFromSqm,
  defaultSurfaceTreatment,
  hasAtMostTwoDecimals,
  lineTintRequest,
  normalizeShadeCode,
  surfaceGrossAreaSqft,
  surfaceNetAreaSqft,
} from './index.js';

describe('product paint fields', () => {
  it('turns a data sheet’s m² per litre into sq ft per litre', () => {
    // The roadmap's "10–12 m²" is about 108–129 sq ft (spec §6.2).
    expect(coverageSqftFromSqm(10)).toBe(107.64);
    expect(coverageSqftFromSqm(12)).toBe(129.17);
  });

  it('knows a number of at most 2 decimals', () => {
    expect(hasAtMostTwoDecimals(120.5)).toBe(true);
    expect(hasAtMostTwoDecimals(0.01)).toBe(true);
    expect(hasAtMostTwoDecimals(10.005)).toBe(false);
  });
});

describe('shade codes', () => {
  it('are trimmed, single-spaced and upper case', () => {
    expect(normalizeShadeCode('  x 132 ')).toBe('X 132');
    expect(normalizeShadeCode('l\t104')).toBe('L 104');
    expect(normalizeShadeCode('8203')).toBe('8203');
  });

  it('are refused when blank or too long', () => {
    expect(normalizeShadeCode('   ')).toBeNull();
    expect(normalizeShadeCode('A'.repeat(SHADE_CODE_MAX_LENGTH))).toHaveLength(40);
    expect(normalizeShadeCode('A'.repeat(SHADE_CODE_MAX_LENGTH + 1))).toBeNull();
  });
});

describe('surfaces', () => {
  it('measure by area, or by length × height to the hundredth', () => {
    expect(surfaceGrossAreaSqft({ areaSqft: 430.5 })).toBe(430.5);
    expect(surfaceGrossAreaSqft({ lengthFt: 12.25, heightFt: 10 })).toBe(122.5);
    // 10.33 × 9.17 = 94.7261, rounded to 94.73.
    expect(surfaceGrossAreaSqft({ lengthFt: 10.33, heightFt: 9.17 })).toBe(94.73);
    expect(surfaceGrossAreaSqft({})).toBe(0);
  });

  it('deduct openings, never below nothing', () => {
    expect(surfaceNetAreaSqft({ lengthFt: 50, heightFt: 10, openingsSqft: 40 })).toBe(460);
    expect(surfaceNetAreaSqft({ areaSqft: 0.3, openingsSqft: 0.1 })).toBe(0.2);
    expect(surfaceNetAreaSqft({ areaSqft: 10 })).toBe(10);
    expect(surfaceNetAreaSqft({ areaSqft: 10, openingsSqft: 12 })).toBe(0);
  });

  it('get primer when new or damaged, and putty on such inside walls and ceilings', () => {
    expect(defaultSurfaceTreatment('interior_wall', 'new')).toEqual({ primer: true, putty: true });
    expect(defaultSurfaceTreatment('ceiling', 'damaged')).toEqual({ primer: true, putty: true });
    expect(defaultSurfaceTreatment('exterior', 'new')).toEqual({ primer: true, putty: false });
    expect(defaultSurfaceTreatment('wood', 'damaged')).toEqual({ primer: true, putty: false });
    expect(defaultSurfaceTreatment('interior_wall', 'repaint')).toEqual({
      primer: false,
      putty: false,
    });
  });

  it('take their own coats, else the product’s, else two', () => {
    expect(coatsFor(1, 3)).toBe(1);
    expect(coatsFor(null, 3)).toBe(3);
    expect(coatsFor(null, null)).toBe(FALLBACK_COATS);
    expect(FALLBACK_COATS).toBe(2);
  });
});

describe('paint permissions', () => {
  it('are known permission keys for every line kind', () => {
    for (const kind of TINT_LINE_KINDS) expect(PERMISSIONS).toContain(TINT_PERMISSION[kind]);
    expect(PERMISSIONS).toContain(TINT_READ_PERMISSION);
    expect(PERMISSIONS).toContain(ESTIMATES_PERMISSION);
  });
});

describe('lineTintRequest', () => {
  const view = {
    id: 'tint-1',
    brand: { id: 'brand-asian', name: 'Asian Paints' },
    shadeCode: 'X 132',
    shadeName: null,
    packQuantity: 2,
    colorantCostPaise: null,
    tintChargePaise: 0,
    machine: null,
    formula: [],
    note: null,
    createdAt: '2026-10-09T05:00:00.000Z',
  };

  it('sends back what a line read, leaving out what is empty', () => {
    expect(lineTintRequest(view)).toEqual({
      shadeCode: 'X 132',
      brandId: 'brand-asian',
      packQuantity: 2,
      tintChargePaise: 0,
      formula: [],
    });
    expect(
      lineTintRequest({
        ...view,
        shadeName: 'Moon Mist',
        colorantCostPaise: 450,
        machine: 'Colour World 2',
        note: 'Kitchen',
      }),
    ).toMatchObject({
      shadeName: 'Moon Mist',
      colorantCostPaise: 450,
      machine: 'Colour World 2',
      note: 'Kitchen',
    });
  });
});

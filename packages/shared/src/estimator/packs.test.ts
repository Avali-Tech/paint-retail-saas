import { describe, expect, it } from 'vitest';
import { packAmount, packsOf, type VariantForSale } from './packs.js';

const variant = (overrides: Partial<VariantForSale>): VariantForSale => ({
  id: 'v',
  packSize: 1,
  unit: 'l',
  sellingPricePaise: 100_00,
  mrpPaise: 120_00,
  isActive: true,
  densityGPerMl: null,
  ...overrides,
});

describe('packsOf', () => {
  it('offers active, priced packs in mL, the selling price before the MRP', () => {
    expect(
      packsOf(
        [
          variant({ id: 'a', packSize: 4, sellingPricePaise: 900_00 }),
          variant({
            id: 'b',
            packSize: 900,
            unit: 'ml',
            sellingPricePaise: null,
            mrpPaise: 260_00,
          }),
          variant({ id: 'c', sellingPricePaise: null, mrpPaise: null }),
          variant({ id: 'd', packSize: 10, isActive: false }),
          variant({ id: 'e', unit: 'kg' }),
          variant({ id: 'f', unit: 'piece' }),
        ],
        'volume',
      ),
    ).toEqual([
      { variantId: 'a', size: 4_000, pricePaise: 900_00 },
      { variantId: 'b', size: 900, pricePaise: 260_00 },
    ]);
  });

  it('offers putty in grams', () => {
    expect(
      packsOf(
        [
          variant({ id: 'kg', packSize: 20, unit: 'kg', sellingPricePaise: 1_100_00 }),
          variant({ id: 'g', packSize: 500, unit: 'g', sellingPricePaise: 40_00 }),
          variant({ id: 'l', unit: 'l' }),
        ],
        'weight',
      ),
    ).toEqual([
      { variantId: 'kg', size: 20_000, pricePaise: 1_100_00 },
      { variantId: 'g', size: 500, pricePaise: 40_00 },
    ]);
  });
});

describe('across litres and kilograms', () => {
  it('counts a pack weighed in kg in litres through its density, and the other way', () => {
    // Distemper sold by the kg, covering by the litre: 10 kg at 1.6 g/ml is 6,250 ml.
    expect(packAmount(variant({ packSize: 10, unit: 'kg', densityGPerMl: 1.6 }), 'volume')).toBe(
      6_250,
    );
    // Putty sold by the litre, used by the kg: 5 l at 1.8 g/ml is 9,000 g.
    expect(packAmount(variant({ packSize: 5, unit: 'l', densityGPerMl: 1.8 }), 'weight')).toBe(
      9_000,
    );
    expect(packAmount(variant({ packSize: 500, unit: 'g', densityGPerMl: 2 }), 'volume')).toBe(250);
  });

  it('cannot tell without a density, or for pieces', () => {
    expect(packAmount(variant({ unit: 'kg' }), 'volume')).toBe(0);
    expect(packAmount(variant({ unit: 'piece', densityGPerMl: 1.2 }), 'weight')).toBe(0);
  });

  it('offers converted packs beside the others, never rounding a pack up', () => {
    expect(
      packsOf(
        [
          variant({ id: 'l', packSize: 4 }),
          // 20 kg at 1.3 g/ml is 15,384.6… ml: offered as 15,384 ml.
          variant({
            id: 'kg',
            packSize: 20,
            unit: 'kg',
            densityGPerMl: 1.3,
            sellingPricePaise: 700_00,
          }),
          variant({ id: 'no-density', packSize: 20, unit: 'kg' }),
        ],
        'volume',
      ),
    ).toEqual([
      { variantId: 'l', size: 4_000, pricePaise: 100_00 },
      { variantId: 'kg', size: 15_384, pricePaise: 700_00 },
    ]);
  });
});

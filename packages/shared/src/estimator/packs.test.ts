import { describe, expect, it } from 'vitest';
import { packsOf, type VariantForSale } from './packs.js';

const variant = (overrides: Partial<VariantForSale>): VariantForSale => ({
  id: 'v',
  packSize: 1,
  unit: 'l',
  sellingPricePaise: 100_00,
  mrpPaise: 120_00,
  isActive: true,
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

import { describe, expect, it } from 'vitest';
import { at } from '../gst/arith.js';
import { MAX_PACK_MIX_STEPS, cheapestPackMix, type PackOption } from './pack-mix.js';

const SPEC_PACKS: PackOption[] = [
  { variantId: 'v1', size: 1_000, pricePaise: 250_00 },
  { variantId: 'v4', size: 4_000, pricePaise: 900_00 },
  { variantId: 'v10', size: 10_000, pricePaise: 2_100_00 },
  { variantId: 'v20', size: 20_000, pricePaise: 4_000_00 },
];

describe('cheapestPackMix', () => {
  it('matches the spec example: 23.63 L → 20 L + 4 L, not 20 L + 4 × 1 L', () => {
    expect(cheapestPackMix(SPEC_PACKS, 23_625)).toEqual({
      required: 23_625,
      supplied: 24_000,
      surplus: 375,
      totalPaise: 4_900_00,
      packCount: 2,
      lines: [
        {
          variantId: 'v20',
          size: 20_000,
          unitPricePaise: 4_000_00,
          quantity: 1,
          totalPaise: 4_000_00,
        },
        { variantId: 'v4', size: 4_000, unitPricePaise: 900_00, quantity: 1, totalPaise: 900_00 },
      ],
    });
  });

  it('mixes sizes, e.g. 1 × 10 L + 2 × 1 L', () => {
    const mix = cheapestPackMix(SPEC_PACKS, 11_500);
    expect(mix?.lines.map((line) => [line.size, line.quantity])).toEqual([
      [10_000, 1],
      [1_000, 2],
    ]);
    expect(mix?.totalPaise).toBe(2_600_00);
  });

  it('over-buys a bigger pack when that is cheaper', () => {
    const mix = cheapestPackMix(SPEC_PACKS, 3_100);
    expect(mix?.lines.map((line) => line.variantId)).toEqual(['v4']);
  });

  it('breaks a price tie by fewer packs', () => {
    const packs = [
      { variantId: 'small', size: 1_000, pricePaise: 100 },
      { variantId: 'big', size: 2_000, pricePaise: 200 },
    ];
    expect(cheapestPackMix(packs, 4_000)?.lines).toEqual([
      { variantId: 'big', size: 2_000, unitPricePaise: 200, quantity: 2, totalPaise: 400 },
    ]);
  });

  it('breaks a price and count tie by less surplus', () => {
    const packs = [
      { variantId: 'a', size: 3_000, pricePaise: 100 },
      { variantId: 'b', size: 5_000, pricePaise: 100 },
    ];
    expect(cheapestPackMix(packs, 2_000)?.lines.map((line) => line.variantId)).toEqual(['a']);
  });

  it('needs no packs for no paint', () => {
    expect(cheapestPackMix(SPEC_PACKS, 0)).toMatchObject({
      supplied: 0,
      totalPaise: 0,
      packCount: 0,
      lines: [],
    });
  });

  it('returns null without packs', () => {
    expect(cheapestPackMix([], 1_000)).toBeNull();
  });

  it('refuses bad volumes and prices', () => {
    expect(() => cheapestPackMix(SPEC_PACKS, -1)).toThrow(
      'The amount needed must be a whole number',
    );
    expect(() => cheapestPackMix(SPEC_PACKS, 1.5)).toThrow(
      'The amount needed must be a whole number',
    );
    expect(() => cheapestPackMix([{ variantId: 'x', size: 0, pricePaise: 1 }], 1)).toThrow(
      'Pack x needs a size above zero',
    );
    expect(() => cheapestPackMix([{ variantId: 'x', size: 1, pricePaise: -1 }], 1)).toThrow(
      'Pack x needs a price in whole paise',
    );
  });

  it('refuses a volume too large to compute', () => {
    expect(() =>
      cheapestPackMix([{ variantId: 'x', size: 1, pricePaise: 1 }], MAX_PACK_MIX_STEPS),
    ).toThrow('The amount needed is too large for these pack sizes');
  });
});

/** mulberry32: a tiny seeded generator, so every run checks the same cases. */
function generator(seed: number) {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return (max: number) => Math.floor(next() * (max + 1));
}

const VOLUMES = [50, 100, 200, 500, 900, 1_000, 3_600, 4_000, 9_000, 10_000, 20_000];

function randomCase(seed: number): { packs: PackOption[]; required: number } {
  const int = generator(seed);
  const packs = Array.from({ length: 1 + int(3) }, (_, index) => ({
    variantId: `v${String(index)}`,
    size: int(4) === 0 ? 1 + int(25_000) : at(VOLUMES, int(VOLUMES.length - 1)),
    pricePaise: int(5_000_00),
  }));
  return { packs, required: int(60_000) };
}

/** Every mix of up to `depth` packs: brute force to check the DP is optimal on small cases. */
function bruteForceBest(packs: readonly PackOption[], required: number): [number, number, number] {
  let best: [number, number, number] = [Infinity, Infinity, Infinity];
  const walk = (index: number, volume: number, cost: number, count: number): void => {
    if (volume >= required) {
      const candidate: [number, number, number] = [cost, count, volume - required];
      if (compare(candidate, best) < 0) best = candidate;
      return;
    }
    if (index === packs.length) return;
    const pack = at(packs, index);
    for (let quantity = 0; volume + quantity * pack.size < required + pack.size; quantity += 1) {
      walk(
        index + 1,
        volume + quantity * pack.size,
        cost + quantity * pack.pricePaise,
        count + quantity,
      );
    }
  };
  walk(0, 0, 0, 0);
  return best;
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < a.length; index += 1) {
    if (at(a, index) !== at(b, index)) return at(a, index) - at(b, index);
  }
  return 0;
}

describe('cheapestPackMix properties', () => {
  it('never under-supplies, and its lines add up, for 1,000 seeded random cases', () => {
    for (let seed = 1; seed <= 1_000; seed += 1) {
      const { packs, required } = randomCase(seed);
      const mix = cheapestPackMix(packs, required);
      expect(mix).not.toBeNull();
      if (!mix) continue;
      const supplied = mix.lines.reduce((sum, line) => sum + line.size * line.quantity, 0);
      const total = mix.lines.reduce((sum, line) => sum + line.totalPaise, 0);
      expect(supplied, `seed ${String(seed)}`).toBeGreaterThanOrEqual(required);
      expect(supplied).toBe(mix.supplied);
      expect(total).toBe(mix.totalPaise);
      expect(mix.surplus).toBe(supplied - required);
    }
  });

  it('is the cheapest mix (then fewest packs, least surplus) on small seeded cases', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const int = generator(seed * 7919);
      const packs = Array.from({ length: 1 + int(2) }, (_, index) => ({
        variantId: `v${String(index)}`,
        size: 100 * (1 + int(40)),
        pricePaise: int(1_000),
      }));
      const required = int(12_000);
      const mix = cheapestPackMix(packs, required);
      expect([mix?.totalPaise, mix?.packCount, mix?.surplus], `seed ${String(seed)}`).toEqual(
        bruteForceBest(packs, required),
      );
    }
  });
});

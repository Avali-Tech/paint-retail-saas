import { describe, expect, it } from 'vitest';
import { earnInvoice, type EarnLine, type EarnRule } from './earn.js';
import {
  pointsToTakeBack,
  reversalTarget,
  weighLines,
  type CreditedLine,
  type WeightedLine,
} from './reversal.js';

const weighted = (key: string, taxablePaise: number, weight: bigint): WeightedLine => ({
  key,
  taxablePaise,
  weight,
});
const credit = (key: string, creditedTaxablePaise: number): CreditedLine => ({
  key,
  creditedTaxablePaise,
});

describe('weighLines', () => {
  const lines: EarnLine[] = [
    { key: 'paint', brandId: 'asian', taxablePaise: 100_000, millilitres: 20_000 },
    { key: 'brush', brandId: 'other', taxablePaise: 50_000, millilitres: 0 },
  ];

  it('weighs each line by what it earned', () => {
    const earning = earnInvoice(lines, [
      { id: 'r', basis: 'per_litre', points: 1, per: 1000, brandId: null, multiplierBps: 10_000 },
    ]);
    expect(weighLines(lines, earning)).toEqual([
      weighted('paint', 100_000, 20_000_000n),
      weighted('brush', 50_000, 0n),
    ]);
  });

  it('falls back to taxable value when no line earns any more', () => {
    expect(weighLines(lines, { points: 0, lines: [] })).toEqual([
      weighted('paint', 100_000, 100_000n),
      weighted('brush', 50_000, 50_000n),
    ]);
    expect(
      weighLines([{ ...lines[0], taxablePaise: -5 } as EarnLine], { points: 0, lines: [] }),
    ).toEqual([weighted('paint', -5, 0n)]);
  });
});

describe('reversalTarget', () => {
  const lines = [weighted('double', 100_000, 2_000n), weighted('single', 100_000, 1_000n)];

  it('takes back by the weight of the lines credited', () => {
    // 30 points: the double line made 20 of them, the single line 10.
    expect(reversalTarget(30, lines, [credit('double', 100_000)])).toBe(20);
    expect(reversalTarget(30, lines, [credit('single', 100_000)])).toBe(10);
    expect(reversalTarget(30, lines, [credit('single', 50_000)])).toBe(5);
  });

  it('adds up credits of the same line and never counts more than the line', () => {
    expect(reversalTarget(30, lines, [credit('double', 50_000), credit('double', 50_000)])).toBe(
      20,
    );
    expect(reversalTarget(30, lines, [credit('double', 500_000)])).toBe(20);
  });

  it('takes back everything once every line is credited in full', () => {
    expect(reversalTarget(30, lines, [credit('double', 100_000), credit('single', 100_000)])).toBe(
      30,
    );
  });

  it('rounds half up', () => {
    // 3 points × 1/2 = 1.5 → 2; 3 × 1/6 = 0.5 → 1; 3 × 1/7 → 0.43 → 0.
    const one = [weighted('a', 600, 600n)];
    expect(reversalTarget(3, one, [credit('a', 300)])).toBe(2);
    expect(reversalTarget(3, one, [credit('a', 100)])).toBe(1);
    expect(reversalTarget(3, [weighted('a', 700, 700n)], [credit('a', 100)])).toBe(0);
  });

  it('ignores lines it does not know, negative credits, and lines without weight or value', () => {
    expect(reversalTarget(30, lines, [credit('other', 100_000), credit('double', -100)])).toBe(0);
    const odd = [weighted('free', 0, 5n), weighted('none', 100, 0n), weighted('a', 100, 10n)];
    expect(reversalTarget(10, odd, [credit('free', 100), credit('none', 100)])).toBe(0);
    expect(reversalTarget(10, odd, [credit('a', 100)])).toBe(10);
  });

  it('is zero when nothing was earned or nothing carries weight', () => {
    expect(reversalTarget(0, lines, [credit('double', 100_000)])).toBe(0);
    expect(reversalTarget(10, [], [credit('double', 100_000)])).toBe(0);
    expect(reversalTarget(10, [weighted('a', 100, 0n)], [credit('a', 100)])).toBe(0);
  });

  it('refuses earned points that are negative or not whole', () => {
    expect(() => reversalTarget(-1, lines, [])).toThrow(RangeError);
    expect(() => reversalTarget(1.5, lines, [])).toThrow(RangeError);
    expect(() => reversalTarget(1, lines, [credit('double', 0.5)])).toThrow(RangeError);
  });
});

describe('pointsToTakeBack', () => {
  it('posts the step between the earlier notes’ target and this one’s', () => {
    expect(pointsToTakeBack({ targetBefore: 5, targetNow: 12, balance: 100 })).toEqual({
      points: 7,
      forgiven: 0,
    });
  });

  it('never takes the balance below zero and forgives the rest', () => {
    expect(pointsToTakeBack({ targetBefore: 0, targetNow: 12, balance: 4 })).toEqual({
      points: 4,
      forgiven: 8,
    });
    expect(pointsToTakeBack({ targetBefore: 0, targetNow: 12, balance: -3 })).toEqual({
      points: 0,
      forgiven: 12,
    });
  });

  it('never gives points back', () => {
    expect(pointsToTakeBack({ targetBefore: 9, targetNow: 7, balance: 100 })).toEqual({
      points: 0,
      forgiven: 0,
    });
  });
});

// Property tests ------------------------------------------------------------

/** A small seeded generator (mulberry32), so a failure replays exactly. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return { int, pick: <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T };
}

function scenario(seed: number) {
  const r = random(seed);
  const brands = ['asian', 'berger', 'nerolac', null];
  const rules: EarnRule[] = Array.from({ length: r.int(1, 4) }, (_, i) => ({
    id: `rule-${String(i)}`,
    basis: r.pick(['per_rupee', 'per_litre'] as const),
    points: r.int(1, 5),
    per: r.pick([1, 100, 1000, 10_000, 30_000]),
    brandId: r.pick(brands),
    multiplierBps: r.pick([5_000, 10_000, 12_500, 20_000]),
  }));
  const lines: EarnLine[] = Array.from({ length: r.int(1, 8) }, (_, i) => ({
    key: `line-${String(i)}`,
    brandId: r.pick(brands),
    taxablePaise: r.int(0, 5_000_000),
    millilitres: r.pick([0, 200, 900, 1000, 4000, 10_000, 20_000]),
  }));
  return { r, rules, lines };
}

/** Splits each line's value into 1–4 notes and shuffles the notes. */
function notesCrediting(r: ReturnType<typeof random>, lines: readonly EarnLine[]) {
  const pieces: CreditedLine[] = [];
  for (const line of lines) {
    let left = line.taxablePaise;
    const parts = r.int(1, 4);
    for (let part = 1; part < parts && left > 0; part += 1) {
      const piece = r.int(0, left);
      pieces.push(credit(line.key, piece));
      left -= piece;
    }
    pieces.push(credit(line.key, left));
  }
  // Shuffled by drawing pieces at random.
  const shuffled: CreditedLine[] = [];
  while (pieces.length > 0) shuffled.push(...pieces.splice(r.int(0, pieces.length - 1), 1));
  const notes: CreditedLine[][] = [];
  while (shuffled.length > 0) notes.push(shuffled.splice(0, r.int(1, 3)));
  return notes;
}

describe('earn then reverse (property)', () => {
  const SEEDS = Array.from({ length: 500 }, (_, i) => i + 1);

  it('nets to zero when credit notes credit the whole invoice, in any split and order', () => {
    for (const seed of SEEDS) {
      const { r, rules, lines } = scenario(seed);
      const earning = earnInvoice(lines, rules);
      const weights = weighLines(lines, earning);
      const credited: CreditedLine[] = [];
      let before = 0;
      let takenBack = 0;
      for (const note of notesCrediting(r, lines)) {
        credited.push(...note);
        const now = reversalTarget(earning.points, weights, credited);
        // Never more than earned, and never moving backwards.
        expect(now, `seed ${String(seed)}`).toBeLessThanOrEqual(earning.points);
        expect(now, `seed ${String(seed)}`).toBeGreaterThanOrEqual(before);
        const step = pointsToTakeBack({
          targetBefore: before,
          targetNow: now,
          balance: Number.MAX_SAFE_INTEGER,
        });
        expect(step.forgiven).toBe(0);
        takenBack += step.points;
        before = now;
      }
      expect(earning.points - takenBack, `seed ${String(seed)}`).toBe(0);
    }
  });

  it('never takes the balance below zero, whatever was spent in between', () => {
    for (const seed of SEEDS) {
      const { r, rules, lines } = scenario(seed);
      const earning = earnInvoice(lines, rules);
      const weights = weighLines(lines, earning);
      let balance = earning.points;
      const credited: CreditedLine[] = [];
      let before = 0;
      let accounted = 0;
      for (const note of notesCrediting(r, lines)) {
        balance -= r.int(0, balance); // the painter redeems some
        credited.push(...note);
        const now = reversalTarget(earning.points, weights, credited);
        const step = pointsToTakeBack({ targetBefore: before, targetNow: now, balance });
        balance -= step.points;
        accounted += step.points + step.forgiven;
        expect(balance, `seed ${String(seed)}`).toBeGreaterThanOrEqual(0);
        before = now;
      }
      // Taken back or forgiven: together exactly what was earned.
      expect(accounted, `seed ${String(seed)}`).toBe(earning.points);
    }
  });

  it('earns the same whatever order the lines and rules come in', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const { rules, lines } = scenario(seed);
      expect(earnInvoice([...lines].reverse(), [...rules].reverse()).points).toBe(
        earnInvoice(lines, rules).points,
      );
    }
  });
});

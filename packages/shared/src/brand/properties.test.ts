import { describe, expect, it } from 'vitest';
import { at as nth } from '../gst/arith.js';
import { schemeClaim, type ReceivedBenefit } from './claims.js';
import { brandMargins, type BrandSchemeMoney, type MarginRow } from './margin.js';
import { planStockUp, type PlannerRates, type StockUpSku } from './price-hike.js';
import { schemeProgress } from './progress.js';
import {
  slabBenefits,
  type BrandScheme,
  type SchemeGrnLine,
  type SlabBenefit,
  type SlabBenefits,
  type SlabMeasure,
  type SlabMode,
} from './scheme.js';

/** A small seeded generator (mulberry32), so a failure replays exactly. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T;
  return { int, pick };
}
type Random = ReturnType<typeof random>;

const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);
const at = (seed: number) => `seed ${String(seed)}`;

/**
 * A scheme whose benefits never shrink from one slab to the next (as real
 * ones do): rates and units rise, ratio steps get shorter.
 */
function randomScheme(r: Random, mode: SlabMode, measure: SlabMeasure): BrandScheme {
  const count = r.int(1, 4);
  let target = 0;
  let bps = r.int(0, 300);
  let ppl = r.int(0, 300);
  let freeUnits = r.int(0, 2);
  let per = r.int(50, 500) * 1000;
  let points = r.int(0, 10);
  const proportional = mode === 'retro' || measure === 'litres';
  const slabs = Array.from({ length: count }, (_, index) => {
    target += measure === 'value' ? r.int(1, 5_00_000_00) : r.int(1, 2000 * 1000);
    bps += r.int(0, 200);
    ppl += r.int(0, 200);
    freeUnits += r.int(0, 2);
    per = Math.max(1000, per - r.int(0, 50_000));
    points += r.int(0, 10);
    const benefits: SlabBenefit[] = [
      { kind: 'points', label: 'trip', points },
      { kind: 'free_goods', variantId: 'v-fixed', units: freeUnits, perMillilitres: null },
    ];
    if (mode === 'retro' || measure === 'value')
      benefits.push({ kind: 'rebate', basisPoints: bps });
    if (proportional) {
      benefits.push({ kind: 'per_litre', paisePerLitre: ppl });
      benefits.push({
        kind: 'free_goods',
        variantId: 'v-ratio',
        units: freeUnits,
        perMillilitres: per,
      });
    }
    return { id: `s${String(index)}`, target, benefits };
  });
  return {
    id: 'scheme',
    brandId: 'brand',
    startsOn: '2026-07-01',
    endsOn: '2026-09-30',
    measure,
    mode,
    productIds: [],
    categoryIds: [],
    slabs,
    settlementDays: r.int(0, 90),
  };
}

function randomLine(r: Random, id: number): SchemeGrnLine {
  return {
    id: `l${String(id)}`,
    brandId: r.int(0, 5) === 0 ? 'other' : 'brand',
    productId: 'p',
    categoryId: null,
    receivedOn: `2026-0${String(r.int(6, 9))}-${String(r.int(10, 28))}`,
    valuePaise: r.int(0, 3_00_000_00),
    millilitres: r.int(0, 1500 * 1000),
    freeMillilitres: r.int(0, 3) === 0 ? r.int(0, 100 * 1000) : 0,
  };
}

/** Every figure of `b` is at least that of `a`. */
function expectAtLeast(a: SlabBenefits, b: SlabBenefits, seed: number): void {
  expect(b.rebatePaise, at(seed)).toBeGreaterThanOrEqual(a.rebatePaise);
  expect(b.perLitrePaise, at(seed)).toBeGreaterThanOrEqual(a.perLitrePaise);
  for (const item of a.freeGoods) {
    const after = b.freeGoods.find((x) => x.variantId === item.variantId)?.units ?? 0;
    expect(after, at(seed)).toBeGreaterThanOrEqual(item.units);
  }
  for (const item of a.points) {
    const after = b.points.find((x) => x.label === item.label)?.points ?? 0;
    expect(after, at(seed)).toBeGreaterThanOrEqual(item.points);
  }
}

describe('slab progress (property)', () => {
  it('never goes back when a purchase is added', () => {
    let earning = 0;
    for (const seed of SEEDS) {
      const r = random(seed);
      const scheme = randomScheme(r, r.pick(['retro', 'incremental']), r.pick(['value', 'litres']));
      const lines = Array.from({ length: r.int(0, 8) }, (_, i) => randomLine(r, i));
      const asOf = `2026-${r.pick(['07', '08', '09', '10'])}-15`;
      let before = schemeProgress(scheme, lines, asOf);
      for (let extra = 0; extra < 4; extra++) {
        lines.push(randomLine(r, 100 + extra));
        const after = schemeProgress(scheme, lines, asOf);
        expect(after.achievedValuePaise, at(seed)).toBeGreaterThanOrEqual(
          before.achievedValuePaise,
        );
        expect(after.achievedMillilitres, at(seed)).toBeGreaterThanOrEqual(
          before.achievedMillilitres,
        );
        expect(after.current?.index ?? -1, at(seed)).toBeGreaterThanOrEqual(
          before.current?.index ?? -1,
        );
        expect(after.projected, at(seed)).toBeGreaterThanOrEqual(before.projected);
        expectAtLeast(before.benefit, after.benefit, seed);
        expectAtLeast(before.projectedBenefit, after.projectedBenefit, seed);
        before = after;
      }
      if (before.benefit.creditPaise > 0) earning++;
    }
    // The cases are not vacuous: most schemes end up paying something.
    expect(earning).toBeGreaterThan(SEEDS.length / 4);
  });

  it('counts free litres toward litres only', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const r = random(seed);
      const scheme = randomScheme(r, 'retro', r.pick(['value', 'litres']));
      const lines = Array.from({ length: r.int(1, 6) }, (_, i) => randomLine(r, i));
      const withoutFree = lines.map((line) => ({ ...line, freeMillilitres: 0 }));
      const a = schemeProgress(scheme, lines, '2026-09-30');
      const b = schemeProgress(scheme, withoutFree, '2026-09-30');
      expect(a.achievedValuePaise, at(seed)).toBe(b.achievedValuePaise);
      expect(a.achievedMillilitres - a.freeMillilitres, at(seed)).toBe(b.achievedMillilitres);
    }
  });
});

describe('retro and incremental slabs (property)', () => {
  const den = (measure: SlabMeasure) => (measure === 'value' ? 10_000n : 1000n);
  const rateOf = (scheme: BrandScheme, index: number) => {
    const benefit = scheme.slabs[index]?.benefits.find(
      (b) => b.kind === (scheme.measure === 'value' ? 'rebate' : 'per_litre'),
    );
    return BigInt(
      benefit?.kind === 'rebate'
        ? benefit.basisPoints
        : benefit?.kind === 'per_litre'
          ? benefit.paisePerLitre
          : 0,
    );
  };
  const money = (scheme: BrandScheme, achieved: number) =>
    scheme.measure === 'value'
      ? slabBenefits(scheme, achieved, 0).rebatePaise
      : slabBenefits(scheme, 0, achieved).perLitrePaise;

  it('agree below slab 2, and match their definitions at every slab target', () => {
    for (const seed of SEEDS) {
      const r = random(seed);
      const measure = r.pick(['value', 'litres'] as const);
      const retro = randomScheme(r, 'incremental', measure);
      const scheme = { ...retro, mode: 'retro' as const };
      const incremental = retro;
      const targets = scheme.slabs.map((slab) => slab.target);
      const second = targets[1] ?? Number.MAX_SAFE_INTEGER / 1e6;
      for (const achieved of [0, targets[0] ?? 0, r.int(0, Math.floor(second) - 1)]) {
        expect(money(scheme, achieved), at(seed)).toBe(money(incremental, achieved));
      }
      targets.forEach((target, k) => {
        // Retro at a target: that slab's rate on the whole target.
        expect(BigInt(money(scheme, target)), at(seed)).toBe(
          (rateOf(scheme, k) * BigInt(target)) / den(measure),
        );
        // Incremental at a target: the lower bands full, and the new band empty.
        let exact = 0n;
        for (let j = 0; j < k; j++) {
          const low = j === 0 ? 0 : nth(targets, j);
          exact += rateOf(scheme, j) * BigInt(nth(targets, j + 1) - low);
        }
        if (k === 0) exact = rateOf(scheme, 0) * BigInt(target);
        expect(BigInt(money(incremental, target)), at(seed)).toBe(exact / den(measure));
        // Incremental has no jump at a higher target; retro never pays less.
        if (k > 0) {
          expect(
            money(incremental, target) - money(incremental, target - 1),
            at(seed),
          ).toBeLessThanOrEqual(1);
        }
        expect(money(scheme, target), at(seed)).toBeGreaterThanOrEqual(money(incremental, target));
      });
    }
  });

  it('agree everywhere when every slab pays the same rate', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const r = random(seed);
      const flat = randomScheme(r, 'incremental', 'litres');
      const rate = r.int(0, 500);
      const slabs = flat.slabs.map((slab) => ({
        ...slab,
        benefits: [{ kind: 'per_litre', paisePerLitre: rate } as const],
      }));
      const incremental = { ...flat, slabs };
      const retro = { ...incremental, mode: 'retro' as const };
      const achieved = r.int(0, 10_000 * 1000);
      expect(money(retro, achieved), at(seed)).toBe(money(incremental, achieved));
    }
  });
});

describe('expected vs received (property)', () => {
  it('outstanding is always expected − received', () => {
    for (const seed of SEEDS) {
      const r = random(seed);
      const scheme = randomScheme(r, 'retro', 'litres');
      const expected = slabBenefits(scheme, r.int(0, 1e9), r.int(0, 10_000_000));
      const received: ReceivedBenefit[] = Array.from({ length: r.int(0, 6) }, (_, i) => {
        const base = { id: `r${String(i)}`, schemeId: 'scheme', receivedOn: '2026-10-10' };
        return r.pick([
          { ...base, kind: 'money', amountPaise: r.int(-1000, 5_000_00) } as const,
          {
            ...base,
            kind: 'free_goods',
            variantId: r.pick(['v-fixed', 'v-ratio', 'v-x']),
            units: r.int(0, 9),
          } as const,
          {
            ...base,
            kind: 'points',
            label: r.pick(['trip', 'gift']),
            points: r.int(0, 20),
          } as const,
        ]);
      });
      const claim = schemeClaim(scheme, expected, received, '2026-12-31');
      const { money } = claim;
      expect(money.expectedPaise - money.receivedPaise, at(seed)).toBe(money.outstandingPaise);
      expect(money.expectedPaise, at(seed)).toBe(expected.creditPaise);
      for (const row of claim.freeGoods) {
        expect(row.expectedUnits - row.receivedUnits, at(seed)).toBe(row.outstandingUnits);
      }
      for (const row of claim.points) {
        expect(row.expected - row.received, at(seed)).toBe(row.outstanding);
      }
      const owed = [
        money.outstandingPaise,
        ...claim.freeGoods.map((x) => x.outstandingUnits),
        ...claim.points.map((x) => x.outstanding),
      ];
      expect(claim.status === 'open', at(seed)).toBe(owed.some((x) => x > 0));
      expect(claim.bucket === null, at(seed)).toBe(claim.status !== 'open');
    }
  });
});

describe('price-hike planner (property)', () => {
  it('adds up, never stocks past break-even, and never plans a loss beyond rounding', () => {
    let stocking = 0;
    for (const seed of SEEDS) {
      const r = random(seed);
      const rates: PlannerRates = {
        holdingCostBps: r.int(0, 1500),
        costOfMoneyBps: r.int(0, 2400),
        deadStockRiskBps: r.int(0, 2000),
        maxCoverDays: r.int(0, 180),
      };
      const skus: StockUpSku[] = Array.from({ length: r.int(1, 5) }, (_, i) => ({
        variantId: `v${String(i)}`,
        unitCostPaise: r.int(0, 50_000_00),
        stockUnits: r.int(0, 300),
        soldUnits: r.int(0, 500),
        salesWindowDays: r.int(1, 180),
        deadStockRiskBps: r.int(0, 2) === 0 ? r.int(0, 5000) : null,
      }));
      const hike = { hikeBasisPoints: r.int(0, 1500), effectiveOn: '2026-11-01' };
      const asOf = `2026-10-${String(r.int(10, 31))}`;
      const plan = planStockUp(hike, skus, asOf, rates);
      const bigger = planStockUp(
        { ...hike, hikeBasisPoints: hike.hikeBasisPoints + r.int(1, 500) },
        skus,
        asOf,
        rates,
      );
      plan.lines.forEach((line, index) => {
        const sku = nth(skus, index);
        expect(line.carryingCostPaise, at(seed)).toBe(
          line.holdingCostPaise + line.moneyCostPaise + line.deadStockCostPaise,
        );
        expect(line.netSavingPaise, at(seed)).toBe(line.savingPaise - line.carryingCostPaise);
        expect(line.stockUpPaise, at(seed)).toBe(line.stockUpUnits * sku.unitCostPaise);
        expect(line.stockUpUnits, at(seed)).toBeGreaterThanOrEqual(0);
        expect(line.coverDays, at(seed)).toBeLessThanOrEqual(line.breakEvenDays ?? Infinity);
        // At most the cover's sales, less what is already there.
        expect(
          (line.unitsAtHike + line.stockUpUnits) * sku.salesWindowDays,
          at(seed),
        ).toBeLessThanOrEqual(
          Math.max(sku.soldUnits * line.coverDays, (line.unitsAtHike + 1) * sku.salesWindowDays),
        );
        // Every unit sells within break-even, so only rounding (≤ 1 paisa a figure) can lose.
        expect(line.netSavingPaise, at(seed)).toBeGreaterThanOrEqual(-4);
        expect(nth(bigger.lines, index).stockUpUnits, at(seed)).toBeGreaterThanOrEqual(
          line.stockUpUnits,
        );
      });
      expect(plan.netSavingPaise, at(seed)).toBe(plan.savingPaise - plan.carryingCostPaise);
      if (plan.stockUpPaise > 0) stocking++;
    }
    expect(stocking).toBeGreaterThan(SEEDS.length / 4);
  });
});

describe('brand margin (property)', () => {
  it('components sum to the contribution, and slices to their brand', () => {
    for (const seed of SEEDS) {
      const r = random(seed);
      const brands = ['b1', 'b2', 'b3'];
      const rows: MarginRow[] = Array.from({ length: r.int(0, 12) }, () => {
        const invoiced = r.int(0, 10_00_000_00);
        const cost = r.int(0, invoiced);
        return {
          brandId: r.pick(brands),
          productId: r.pick(['p1', 'p2', 'p3']),
          storeId: r.pick(['s1', 's2']),
          invoicedPaise: invoiced,
          creditNotePaise: r.int(0, Math.floor(invoiced / 4)),
          costOfSalesPaise: cost,
          costReturnedPaise: r.int(0, Math.floor(cost / 4)),
          creditPaiseDays: r.int(0, invoiced) * r.int(0, 90),
          loyaltyPaise: r.int(0, 10_000_00),
          painterPointsPaise: r.int(0, 10_000_00),
        };
      });
      const schemes: BrandSchemeMoney[] = brands
        .filter(() => r.int(0, 1) === 1)
        .map((brandId) => ({
          brandId,
          receivedPaise: r.int(0, 50_000_00),
          expectedPaise: r.int(0, 50_000_00),
        }));
      const options = { costOfMoneyBps: r.int(0, 2400) };
      const split = brandMargins(rows, schemes, { ...options, groupBy: ['product', 'store'] });
      const whole = brandMargins(rows, schemes, { ...options, groupBy: [] });
      for (const s of split) {
        expect(
          s.netSalesPaise -
            s.costPaise +
            s.schemeReceivedPaise +
            s.schemeExpectedPaise -
            s.creditCostPaise -
            s.loyaltyPaise -
            s.painterPointsPaise,
          at(seed),
        ).toBe(s.contributionPaise);
        expect(s.netSalesPaise, at(seed)).toBe(s.invoicedPaise - s.creditNotePaise);
        expect(s.grossMarginPaise, at(seed)).toBe(s.netSalesPaise - s.costPaise);
      }
      for (const brand of whole) {
        const slices = split.filter((s) => s.brandId === brand.brandId);
        const sum = (pick: (s: (typeof split)[number]) => number) =>
          slices.reduce((t, s) => t + pick(s), 0);
        const scheme = schemes.find((s) => s.brandId === brand.brandId);
        expect(
          sum((s) => s.schemeReceivedPaise),
          at(seed),
        ).toBe(scheme?.receivedPaise ?? 0);
        expect(
          sum((s) => s.schemeExpectedPaise),
          at(seed),
        ).toBe(scheme?.expectedPaise ?? 0);
        expect(
          sum((s) => s.netSalesPaise),
          at(seed),
        ).toBe(brand.netSalesPaise);
        expect(
          sum((s) => s.costPaise),
          at(seed),
        ).toBe(brand.costPaise);
        expect(
          sum((s) => s.loyaltyPaise + s.painterPointsPaise),
          at(seed),
        ).toBe(brand.loyaltyPaise + brand.painterPointsPaise);
        // Credit cost rounds per slice: half a paisa each at most.
        expect(
          Math.abs(sum((s) => s.creditCostPaise) - brand.creditCostPaise) * 2,
          at(seed),
        ).toBeLessThanOrEqual(slices.length + 1);
      }
    }
  });
});

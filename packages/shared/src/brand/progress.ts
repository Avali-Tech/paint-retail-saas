import { daysBetween } from '../receivables/dates.js';
import { assertWhole, divCeil, divFloor, maxBig, minBig, toSafe } from './arith.js';
import {
  assertScheme,
  lineCounts,
  slabBenefits,
  slabIndexFor,
  type BrandScheme,
  type SchemeGrnLine,
  type SlabBenefits,
} from './scheme.js';

/**
 * Slab progress (roadmap P2-M33, spec §6.3): how far a dealer's purchases of
 * the brand have come in a scheme, where they will end at the current pace,
 * and what they have earned so far.
 *
 * - Achieved value = Σ value of the counted GRN lines (paid units only).
 * - Achieved litres = Σ (paid + scheme-free) millilitres [CA-4].
 *   Purchase returns are negative lines; a total below zero counts as zero.
 * - Projection at the run-rate: achieved × period days ÷ days elapsed, rounded
 *   down, where days elapsed run from the first day through the as-of day
 *   (capped at the period). Before the period starts nothing is projected.
 */

/** A slab in a progress answer. */
export interface SlabRef {
  /** Index into the scheme's slabs, 0 for the first. */
  readonly index: number;
  readonly slabId: string;
  /** Paise or millilitres, as the scheme measures. */
  readonly target: number;
}

/** The slab after the current one and how far it is. */
export interface NextSlab extends SlabRef {
  /** Still to buy to reach it, in the scheme's measure. */
  readonly distance: number;
  /** Per remaining day (rounded up) to reach it by the period end; null with no day left. */
  readonly perDayNeeded: number | null;
}

export interface SchemeProgress {
  readonly schemeId: string;
  readonly asOf: string;
  /** Paise of purchase value at cost; scheme-free units add nothing. */
  readonly achievedValuePaise: number;
  /** Paid plus scheme-free millilitres. */
  readonly achievedMillilitres: number;
  /** Of which scheme-free. */
  readonly freeMillilitres: number;
  /** The figure the slabs are measured on (value or millilitres). */
  readonly achieved: number;
  readonly current: SlabRef | null;
  readonly next: NextSlab | null;
  /** Days of the period, days elapsed through the as-of day, and days left after it. */
  readonly periodDays: number;
  readonly elapsedDays: number;
  readonly remainingDays: number;
  /** Achieved value, litres and measure at the run-rate to the period end. */
  readonly projectedValuePaise: number;
  readonly projectedMillilitres: number;
  readonly projected: number;
  readonly projectedSlab: SlabRef | null;
  /** What the projection would earn. */
  readonly projectedBenefit: SlabBenefits;
  /** Earned so far. */
  readonly benefit: SlabBenefits;
}

function slabRef(scheme: BrandScheme, index: number): SlabRef | null {
  const slab = scheme.slabs[index];
  return slab === undefined ? null : { index, slabId: slab.id, target: slab.target };
}

/** A scheme's progress from the brand's GRN lines, as of a day. */
export function schemeProgress(
  scheme: BrandScheme,
  lines: readonly SchemeGrnLine[],
  asOf: string,
): SchemeProgress {
  assertScheme(scheme);
  let value = 0n;
  let paid = 0n;
  let free = 0n;
  for (const line of lines) {
    assertWhole(line.valuePaise, 'GRN line value');
    assertWhole(line.millilitres, 'GRN line millilitres');
    assertWhole(line.freeMillilitres, 'GRN line free millilitres');
    if (!lineCounts(scheme, line, asOf)) continue;
    value += BigInt(line.valuePaise);
    paid += BigInt(line.millilitres);
    free += BigInt(line.freeMillilitres);
  }
  const achievedValue = maxBig(value, 0n);
  const achievedMl = maxBig(paid + free, 0n);
  const measured = (valuePaise: bigint, ml: bigint) =>
    toSafe(scheme.measure === 'value' ? valuePaise : ml, 'Achieved');

  const periodDays = daysBetween(scheme.startsOn, scheme.endsOn) + 1;
  const elapsedDays = Math.min(Math.max(daysBetween(scheme.startsOn, asOf) + 1, 0), periodDays);
  const remainingDays = periodDays - elapsedDays;
  const project = (amount: bigint) =>
    elapsedDays === 0 ? amount : divFloor(amount * BigInt(periodDays), BigInt(elapsedDays));
  const projectedValue = project(achievedValue);
  const projectedMl = project(achievedMl);

  const achieved = measured(achievedValue, achievedMl);
  const currentIndex = slabIndexFor(scheme, achieved);
  const nextRef = slabRef(scheme, currentIndex + 1);
  const projected = measured(projectedValue, projectedMl);
  const projectedIndex = slabIndexFor(scheme, projected);

  let next: NextSlab | null = null;
  if (nextRef !== null) {
    const distance = nextRef.target - achieved;
    next = {
      ...nextRef,
      distance,
      perDayNeeded:
        remainingDays === 0
          ? null
          : toSafe(divCeil(BigInt(distance), BigInt(remainingDays)), 'Per day'),
    };
  }
  return {
    schemeId: scheme.id,
    asOf,
    achievedValuePaise: toSafe(achievedValue, 'Achieved value'),
    achievedMillilitres: toSafe(achievedMl, 'Achieved millilitres'),
    freeMillilitres: toSafe(minBig(maxBig(free, 0n), achievedMl), 'Free millilitres'),
    achieved,
    current: slabRef(scheme, currentIndex),
    next,
    periodDays,
    elapsedDays,
    remainingDays,
    projectedValuePaise: toSafe(projectedValue, 'Projected value'),
    projectedMillilitres: toSafe(projectedMl, 'Projected millilitres'),
    projected,
    projectedSlab: slabRef(scheme, projectedIndex),
    projectedBenefit: slabBenefits(
      scheme,
      toSafe(projectedValue, 'Projected value'),
      toSafe(projectedMl, 'Projected millilitres'),
    ),
    benefit: slabBenefits(
      scheme,
      toSafe(achievedValue, 'Achieved value'),
      toSafe(achievedMl, 'Achieved millilitres'),
    ),
  };
}

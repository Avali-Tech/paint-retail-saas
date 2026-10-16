import { at } from '../gst/arith.js';
import { dayNumber } from '../receivables/dates.js';
import {
  BPS,
  ML_PER_LITRE,
  assertNonNegative,
  assertPositive,
  divFloor,
  maxBig,
  minBig,
  toSafe,
} from './arith.js';

/**
 * Brand schemes (roadmap P2-M33, MVP 3 spec §6.3): the scheme model and what a
 * slab gives. Pure: the API loads the scheme and the GRN lines.
 *
 * A scheme runs over a period (both days included) on the brand's products, or
 * on the products and categories it names, and has ascending slabs. Each slab's
 * target is in rupees (`value`, paise of purchase value at cost) or in litres
 * (`litres`, millilitres, scheme-free units included, [CA-4]).
 *
 * How slabs apply (`mode`, default `retro`):
 * - `retro` (whole volume): the highest slab reached gives its benefit on the
 *   whole of what was achieved, from the first litre or rupee.
 * - `incremental`: every slab reached gives its own benefit on its band only.
 *   Slab 1's band is [0, slab 2's target) and slab k's is [its target, the next
 *   target); the last band is open. So while only slab 1 is reached the two
 *   modes give the same, and above it incremental is retro without the uplift
 *   on the lower bands. Fixed benefits (free goods without a ratio, points)
 *   come once from the top slab in retro and once from every slab reached in
 *   incremental.
 */

export const SLAB_MEASURES = ['value', 'litres'] as const;
/** What a slab target counts: purchase value in paise, or millilitres. */
export type SlabMeasure = (typeof SLAB_MEASURES)[number];

export const SLAB_MODES = ['retro', 'incremental'] as const;
export type SlabMode = (typeof SLAB_MODES)[number];
/** Most paint brand slabs are whole-volume ("retro"): the slab reached pays on everything. */
export const DEFAULT_SLAB_MODE: SlabMode = 'retro';

/** A benefit a slab gives. */
export type SlabBenefit =
  /** A rebate of the achieved purchase value, in basis points (200 = 2 %). */
  | { readonly kind: 'rebate'; readonly basisPoints: number }
  /** An amount per litre achieved, in paise per litre. */
  | { readonly kind: 'per_litre'; readonly paisePerLitre: number }
  /**
   * Free units of one variant: `units` once on reaching the slab when
   * `perMillilitres` is null, else `units` for every whole `perMillilitres` achieved.
   */
  | {
      readonly kind: 'free_goods';
      readonly variantId: string;
      readonly units: number;
      readonly perMillilitres: number | null;
    }
  /** Gift or trip points once on reaching the slab, named by `label`. */
  | { readonly kind: 'points'; readonly label: string; readonly points: number };

export interface SchemeSlab {
  readonly id: string;
  /** Paise for a `value` scheme, millilitres for a `litres` one. */
  readonly target: number;
  readonly benefits: readonly SlabBenefit[];
}

export interface BrandScheme {
  readonly id: string;
  readonly brandId: string;
  /** First and last day of the period (ISO dates, both included). */
  readonly startsOn: string;
  readonly endsOn: string;
  readonly measure: SlabMeasure;
  readonly mode: SlabMode;
  /** Products and categories the scheme covers; both empty means every product of the brand. */
  readonly productIds: readonly string[];
  readonly categoryIds: readonly string[];
  /** Ascending by target. */
  readonly slabs: readonly SchemeSlab[];
  /** Days after the period the brand settles in; null for {@link DEFAULT_SETTLEMENT_DAYS}. */
  readonly settlementDays: number | null;
}

/** Days after a scheme's period by which its benefits are expected, unless the scheme says. */
export const DEFAULT_SETTLEMENT_DAYS = 45;

/** One line of a goods receipt (GRN) from the brand, as far as schemes are concerned. */
export interface SchemeGrnLine {
  readonly id: string;
  readonly brandId: string;
  readonly productId: string;
  readonly categoryId: string | null;
  /** The GRN's date. */
  readonly receivedOn: string;
  /** Taxable purchase value of the paid units at cost, before GST; negative for a return. */
  readonly valuePaise: number;
  /** Paint in the paid units in millilitres (0 for kg or pieces); negative for a return. */
  readonly millilitres: number;
  /** Paint in the scheme-free units: counts toward litres, never toward value [CA-4]. */
  readonly freeMillilitres: number;
}

/** Free units of one variant. */
export interface FreeGoods {
  readonly variantId: string;
  readonly units: number;
}

/** Gift or trip points under one label. */
export interface SchemePoints {
  readonly label: string;
  readonly points: number;
}

/** What slabs give for an achieved value and volume. */
export interface SlabBenefits {
  /** Rebate in paise, rounded down. */
  readonly rebatePaise: number;
  /** Per-litre benefit in paise, rounded down. */
  readonly perLitrePaise: number;
  /** Money the brand owes as credit notes: rebate + per litre. */
  readonly creditPaise: number;
  /** By variant id, ascending. */
  readonly freeGoods: readonly FreeGoods[];
  /** By label, ascending. */
  readonly points: readonly SchemePoints[];
}

/** Throws unless the scheme can be computed: dates, ascending positive targets, whole rates. */
export function assertScheme(scheme: BrandScheme): void {
  if (dayNumber(scheme.endsOn) < dayNumber(scheme.startsOn)) {
    throw new RangeError(`Scheme ${scheme.id} ends before it starts`);
  }
  if (!SLAB_MEASURES.includes(scheme.measure) || !SLAB_MODES.includes(scheme.mode)) {
    throw new RangeError(`Scheme ${scheme.id} has an unknown measure or mode`);
  }
  if (scheme.slabs.length === 0) throw new RangeError(`Scheme ${scheme.id} has no slabs`);
  if (scheme.settlementDays !== null) {
    assertNonNegative(scheme.settlementDays, 'Settlement days');
  }
  let previous = 0;
  for (const slab of scheme.slabs) {
    assertPositive(slab.target, 'Slab target');
    if (slab.target <= previous) {
      throw new RangeError(`Scheme ${scheme.id} slab targets must rise`);
    }
    previous = slab.target;
    slab.benefits.forEach((benefit) => {
      assertBenefit(benefit, scheme.mode, scheme.measure);
    });
  }
}

/** The basis a proportional benefit is measured on; null for a fixed one. */
function basisOf(benefit: SlabBenefit): SlabMeasure | null {
  switch (benefit.kind) {
    case 'rebate':
      return 'value';
    case 'per_litre':
      return 'litres';
    case 'free_goods':
      return benefit.perMillilitres === null ? null : 'litres';
    case 'points':
      return null;
  }
}

function assertBenefit(benefit: SlabBenefit, mode: SlabMode, measure: SlabMeasure): void {
  switch (benefit.kind) {
    case 'rebate':
      assertNonNegative(benefit.basisPoints, 'Rebate basis points');
      break;
    case 'per_litre':
      assertNonNegative(benefit.paisePerLitre, 'Paise per litre');
      break;
    case 'free_goods':
      assertNonNegative(benefit.units, 'Free units');
      if (benefit.perMillilitres !== null) {
        assertPositive(benefit.perMillilitres, 'Free goods per millilitres');
      }
      break;
    case 'points':
      assertNonNegative(benefit.points, 'Points');
      break;
    default:
      throw new RangeError('Unknown slab benefit');
  }
  // An incremental band is a slice of the target's own measure; a rebate on a
  // litres band (or litres on a rupee band) has no exact share, so it is refused.
  const basis = basisOf(benefit);
  if (mode === 'incremental' && basis !== null && basis !== measure) {
    throw new RangeError(
      `An incremental ${measure} scheme cannot give a ${benefit.kind} benefit; make it retro`,
    );
  }
}

/** Whether a GRN line counts toward the scheme: its brand, in its period, a product it covers. */
export function lineCounts(scheme: BrandScheme, line: SchemeGrnLine, asOf: string): boolean {
  const day = dayNumber(line.receivedOn);
  if (line.brandId !== scheme.brandId) return false;
  if (day < dayNumber(scheme.startsOn) || day > dayNumber(scheme.endsOn)) return false;
  if (day > dayNumber(asOf)) return false;
  if (scheme.productIds.length === 0 && scheme.categoryIds.length === 0) return true;
  return (
    scheme.productIds.includes(line.productId) ||
    (line.categoryId !== null && scheme.categoryIds.includes(line.categoryId))
  );
}

/** The index of the highest slab whose target `achieved` reaches; -1 for none. */
export function slabIndexFor(scheme: BrandScheme, achieved: number): number {
  let reached = -1;
  scheme.slabs.forEach((slab, index) => {
    if (achieved >= slab.target) reached = index;
  });
  return reached;
}

/**
 * What the scheme gives for `valuePaise` and `millilitres` achieved (each
 * taken as 0 when negative). Money is summed exactly over the slabs and bands,
 * then rounded down once per kind (the brand never owes a paisa the slabs did
 * not make); free goods with a ratio count whole steps per slab band.
 */
export function slabBenefits(
  scheme: BrandScheme,
  valuePaise: number,
  millilitres: number,
): SlabBenefits {
  const totals: Record<SlabMeasure, bigint> = {
    value: maxBig(BigInt(valuePaise), 0n),
    litres: maxBig(BigInt(millilitres), 0n),
  };
  const achieved = totals[scheme.measure];
  const top = slabIndexFor(scheme, toSafe(achieved, 'Achieved'));
  // Each slab that pays, with the amount of the scheme's measure it pays on.
  const bands: { readonly slab: SchemeSlab; readonly amount: bigint }[] = [];
  if (top >= 0) {
    if (scheme.mode === 'retro') {
      bands.push({ slab: at(scheme.slabs, top), amount: achieved });
    } else {
      for (let index = 0; index <= top; index++) {
        const slab = at(scheme.slabs, index);
        const low = index === 0 ? 0n : BigInt(slab.target);
        const next = scheme.slabs[index + 1];
        const high = next === undefined ? achieved : minBig(achieved, BigInt(next.target));
        bands.push({ slab, amount: high - low });
      }
    }
  }
  // In retro the band is the whole achievement, so a benefit on the other basis
  // takes that basis's whole total; incremental schemes never mix bases.
  const base = (basis: SlabMeasure, amount: bigint) =>
    basis === scheme.measure ? amount : totals[basis];
  let rebate = 0n;
  let perLitre = 0n;
  const free = new Map<string, bigint>();
  const points = new Map<string, bigint>();
  for (const { slab, amount } of bands) {
    for (const benefit of slab.benefits) {
      switch (benefit.kind) {
        case 'rebate':
          rebate += BigInt(benefit.basisPoints) * base('value', amount);
          break;
        case 'per_litre':
          perLitre += BigInt(benefit.paisePerLitre) * base('litres', amount);
          break;
        case 'free_goods': {
          const units =
            benefit.perMillilitres === null
              ? BigInt(benefit.units)
              : BigInt(benefit.units) * (base('litres', amount) / BigInt(benefit.perMillilitres));
          free.set(benefit.variantId, (free.get(benefit.variantId) ?? 0n) + units);
          break;
        }
        case 'points':
          points.set(benefit.label, (points.get(benefit.label) ?? 0n) + BigInt(benefit.points));
          break;
      }
    }
  }
  const rebatePaise = toSafe(divFloor(rebate, BPS), 'Rebate');
  const perLitrePaise = toSafe(divFloor(perLitre, ML_PER_LITRE), 'Per-litre benefit');
  return {
    rebatePaise,
    perLitrePaise,
    creditPaise: toSafe(BigInt(rebatePaise) + BigInt(perLitrePaise), 'Credit'),
    freeGoods: [...free]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([variantId, units]) => ({ variantId, units: toSafe(units, 'Free units') })),
    points: [...points]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, total]) => ({ label, points: toSafe(total, 'Points') })),
  };
}

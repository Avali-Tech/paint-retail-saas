import { AGEING_BUCKETS, bucketFor, type AgeingBucket } from '../receivables/ageing.js';
import { addDays, dayNumber, daysBetween } from '../receivables/dates.js';
import { assertWhole, toSafe } from './arith.js';
import {
  DEFAULT_SETTLEMENT_DAYS,
  assertScheme,
  type BrandScheme,
  type SlabBenefits,
} from './scheme.js';

/**
 * Expected vs received scheme benefits (roadmap P2-M33, spec §6.3): what a
 * scheme's slabs say the brand owes (credit notes, free goods, points) against
 * what the brand has issued, and the claims still open with their age.
 *
 * - Outstanding = expected − received, per kind (money, each variant, each
 *   label). Negative means the brand gave more than the slabs make (an excess).
 * - A claim falls due `settlementDays` after the period ends (default 45) and
 *   is aged from then with the receivables buckets: not due, 0–30, 31–60,
 *   61–90 and 90+ days past due.
 * - Before the period ends the expected figures are provisional (`final` false).
 */

/** Something the brand issued against a scheme. Entries dated after the as-of day are ignored. */
export type ReceivedBenefit =
  /** A credit note or cash rebate in paise (negative to reverse one). */
  | {
      readonly kind: 'money';
      readonly id: string;
      readonly schemeId: string;
      readonly receivedOn: string;
      readonly amountPaise: number;
    }
  | {
      readonly kind: 'free_goods';
      readonly id: string;
      readonly schemeId: string;
      readonly receivedOn: string;
      readonly variantId: string;
      readonly units: number;
    }
  | {
      readonly kind: 'points';
      readonly id: string;
      readonly schemeId: string;
      readonly receivedOn: string;
      readonly label: string;
      readonly points: number;
    };

export interface MoneyClaim {
  readonly expectedPaise: number;
  readonly receivedPaise: number;
  /** expected − received; negative when the brand gave more. */
  readonly outstandingPaise: number;
}

export interface FreeGoodsClaim {
  readonly variantId: string;
  readonly expectedUnits: number;
  readonly receivedUnits: number;
  readonly outstandingUnits: number;
}

export interface PointsClaim {
  readonly label: string;
  readonly expected: number;
  readonly received: number;
  readonly outstanding: number;
}

export const CLAIM_STATUSES = ['open', 'settled', 'excess'] as const;
/** `open`: something is still owed; `excess`: nothing owed and more given than earned. */
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export interface SchemeClaim {
  readonly schemeId: string;
  readonly brandId: string;
  readonly asOf: string;
  /** The period is over, so the expected figures will not change with purchases. */
  readonly final: boolean;
  readonly dueOn: string;
  /** Days past `dueOn` on the as-of day; negative before it. */
  readonly daysPastDue: number;
  /** The age of what is open; null when nothing is. */
  readonly bucket: AgeingBucket | null;
  readonly status: ClaimStatus;
  readonly money: MoneyClaim;
  /** By variant id, ascending. */
  readonly freeGoods: readonly FreeGoodsClaim[];
  /** By label, ascending. */
  readonly points: readonly PointsClaim[];
}

function add(map: Map<string, bigint>, key: string, amount: number): void {
  map.set(key, (map.get(key) ?? 0n) + BigInt(amount));
}

function compare(
  expected: Map<string, bigint>,
  received: Map<string, bigint>,
): { key: string; expected: number; received: number; outstanding: number }[] {
  return [...new Set([...expected.keys(), ...received.keys()])]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const e = expected.get(key) ?? 0n;
      const r = received.get(key) ?? 0n;
      return {
        key,
        expected: toSafe(e, 'Expected'),
        received: toSafe(r, 'Received'),
        outstanding: toSafe(e - r, 'Outstanding'),
      };
    });
}

/** A scheme's claim: `expected` (its progress's benefit) against what the brand issued. */
export function schemeClaim(
  scheme: BrandScheme,
  expected: SlabBenefits,
  received: readonly ReceivedBenefit[],
  asOf: string,
): SchemeClaim {
  assertScheme(scheme);
  const asOfDay = dayNumber(asOf);
  let money = 0n;
  const freeIn = new Map<string, bigint>();
  const pointsIn = new Map<string, bigint>();
  for (const entry of received) {
    if (entry.schemeId !== scheme.id || dayNumber(entry.receivedOn) > asOfDay) continue;
    switch (entry.kind) {
      case 'money':
        assertWhole(entry.amountPaise, 'Received amount');
        money += BigInt(entry.amountPaise);
        break;
      case 'free_goods':
        assertWhole(entry.units, 'Received units');
        add(freeIn, entry.variantId, entry.units);
        break;
      case 'points':
        assertWhole(entry.points, 'Received points');
        add(pointsIn, entry.label, entry.points);
        break;
    }
  }
  const freeOut = new Map<string, bigint>();
  expected.freeGoods.forEach((item) => {
    add(freeOut, item.variantId, item.units);
  });
  const pointsOut = new Map<string, bigint>();
  expected.points.forEach((item) => {
    add(pointsOut, item.label, item.points);
  });

  const moneyClaim: MoneyClaim = {
    expectedPaise: expected.creditPaise,
    receivedPaise: toSafe(money, 'Received'),
    outstandingPaise: toSafe(BigInt(expected.creditPaise) - money, 'Outstanding'),
  };
  const freeGoods = compare(freeOut, freeIn).map((row): FreeGoodsClaim => ({
    variantId: row.key,
    expectedUnits: row.expected,
    receivedUnits: row.received,
    outstandingUnits: row.outstanding,
  }));
  const points = compare(pointsOut, pointsIn).map((row): PointsClaim => ({
    label: row.key,
    expected: row.expected,
    received: row.received,
    outstanding: row.outstanding,
  }));
  const outstanding = [
    moneyClaim.outstandingPaise,
    ...freeGoods.map((row) => row.outstandingUnits),
    ...points.map((row) => row.outstanding),
  ];
  const status: ClaimStatus = outstanding.some((amount) => amount > 0)
    ? 'open'
    : outstanding.some((amount) => amount < 0)
      ? 'excess'
      : 'settled';
  const dueOn = addDays(scheme.endsOn, scheme.settlementDays ?? DEFAULT_SETTLEMENT_DAYS);
  const daysPastDue = daysBetween(dueOn, asOf);
  return {
    schemeId: scheme.id,
    brandId: scheme.brandId,
    asOf,
    final: asOfDay > dayNumber(scheme.endsOn),
    dueOn,
    daysPastDue,
    bucket: status === 'open' ? bucketFor(daysPastDue) : null,
    status,
    money: moneyClaim,
    freeGoods,
    points,
  };
}

export interface ClaimsAgeingRow {
  readonly bucket: AgeingBucket;
  /** Open claims in the bucket. */
  readonly claims: number;
  /** Money still owed on them (claims owing only goods or points add 0). */
  readonly outstandingPaise: number;
}

/** Open claims by age: every bucket in order, with the money still owed. */
export function claimsAgeing(claims: readonly SchemeClaim[]): ClaimsAgeingRow[] {
  return AGEING_BUCKETS.map((bucket) => {
    const open = claims.filter((claim) => claim.bucket === bucket);
    const owed = open.reduce(
      (sum, claim) => sum + BigInt(Math.max(claim.money.outstandingPaise, 0)),
      0n,
    );
    return { bucket, claims: open.length, outstandingPaise: toSafe(owed, 'Outstanding') };
  });
}
